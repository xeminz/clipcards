// ClipCards – YouTube-Link rein, Zusammenfassung + Lernkarten raus.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { GoogleGenAI, ApiError } from "@google/genai";
import { z } from "zod";
import { fetchTranscript } from "youtube-transcript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Wird der Reihe nach probiert: ist ein Modell nicht verfügbar, zu langsam oder sein
// Gratis-Limit erreicht, kommt das nächste.
const MODELS = [process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"].filter(Boolean);
const MODEL_TIMEOUT_MS = 90_000;

// ---------- Datenbank ----------
const db = new DatabaseSync(path.join(here, "clipcards.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   TEXT UNIQUE NOT NULL,
    url        TEXT NOT NULL,
    title      TEXT,
    channel    TEXT,
    summary    TEXT NOT NULL,
    transcript TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cards (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer   TEXT NOT NULL
  );
`);
db.exec("PRAGMA foreign_keys = ON");

// ---------- YouTube ----------
function extractVideoId(input) {
  const s = String(input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12);
    if (u.hostname.endsWith("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
      const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

async function fetchMeta(videoId) {
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!r.ok) return {};
    const j = await r.json();
    return { title: j.title, channel: j.author_name };
  } catch {
    return {};
  }
}

function decodeEntities(t) {
  return t
    .replace(/&amp;#39;|&#39;/g, "'")
    .replace(/&amp;quot;|&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function getTranscript(videoId) {
  // Bevorzugt Deutsch, dann Englisch, sonst die Standardspur. YouTube antwortet
  // manchmal leer – dann kurz warten und erneut versuchen.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const lang of ["de", "en", undefined]) {
      try {
        const parts = await fetchTranscript(videoId, lang ? { lang } : undefined);
        const text = decodeEntities(parts.map((p) => p.text).join(" ")).replace(/\s+/g, " ").trim();
        if (text) return text;
      } catch (e) {
        lastError = e;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new UserError(
    "Für dieses Video konnte kein Transkript geladen werden (evtl. keine Untertitel verfügbar)." +
      (lastError ? ` Details: ${lastError.message}` : "")
  );
}

// ---------- KI ----------
let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new UserError("Kein API-Key gefunden. Trage GEMINI_API_KEY in die Datei .env ein.");
  }
  return (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
}

const ResultSchema = z.object({
  summary: z.string(),
  cards: z.array(z.object({ question: z.string(), answer: z.string() })),
});

const SYSTEM = `Du erstellst Lernmaterial aus Video-Transkripten.
Schreibe immer auf Deutsch, egal in welcher Sprache das Transkript ist.
- "summary": eine klare Zusammenfassung des Videos in 1–3 kurzen Absätzen (Absätze mit Leerzeile trennen).
- "cards": 5 bis 10 Lernkarten. Jede Karte prüft genau einen wichtigen Gedanken aus dem Video.
  Die Frage ist konkret und ohne Kontext verständlich, die Antwort ist kurz (1–3 Sätze).
  Keine Fragen zu Nebensächlichkeiten wie Sponsoren, Begrüßung oder "Abonniert den Kanal".`;

async function generateCards(transcript, title) {
  let response;
  for (const [i, model] of MODELS.entries()) {
    try {
      response = await getClient().models.generateContent({
        model,
        contents: `Videotitel: ${title || "(unbekannt)"}\n\n<transkript>\n${transcript}\n</transkript>`,
        config: {
          systemInstruction: SYSTEM,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(ResultSchema),
          abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
        },
      });
      break;
    } catch (e) {
      const isLast = i === MODELS.length - 1;
      const keyProblem = e instanceof ApiError && [400, 401, 403].includes(e.status);
      if (isLast || keyProblem) {
        if (e.name === "TimeoutError" || e.name === "AbortError")
          throw new UserError("Die KI hat zu lange gebraucht. Bitte nochmal versuchen.");
        throw e;
      }
      console.log(`Modell ${model} nicht nutzbar (${e.status ?? e.name}), versuche nächstes…`);
    }
  }
  let out;
  try {
    out = ResultSchema.parse(JSON.parse(response.text ?? ""));
  } catch {
    throw new UserError("Die KI-Antwort war unvollständig oder wurde blockiert. Bitte nochmal versuchen.");
  }
  if (out.cards.length === 0) throw new UserError("Die KI hat keine Karten erstellt. Bitte nochmal versuchen.");
  out.cards = out.cards.slice(0, 10);
  return out;
}

// ---------- Speichern / Lesen ----------
function saveVideo(v) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM videos WHERE video_id = ?").run(v.videoId);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO videos (video_id, url, title, channel, summary, transcript) VALUES (?,?,?,?,?,?)"
      )
      .run(v.videoId, v.url, v.title ?? null, v.channel ?? null, v.summary, v.transcript);
    const ins = db.prepare("INSERT INTO cards (video_id, question, answer) VALUES (?,?,?)");
    for (const c of v.cards) ins.run(lastInsertRowid, c.question, c.answer);
    db.exec("COMMIT");
    return Number(lastInsertRowid);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function getVideo(id) {
  const v = db
    .prepare("SELECT id, video_id, url, title, channel, summary, created_at FROM videos WHERE id = ?")
    .get(id);
  if (!v) return null;
  v.cards = db.prepare("SELECT id, question, answer FROM cards WHERE video_id = ? ORDER BY id").all(id);
  return v;
}

function listVideos(q) {
  const base = `SELECT v.id, v.video_id, v.title, v.channel, v.created_at,
                  (SELECT COUNT(*) FROM cards c WHERE c.video_id = v.id) AS card_count
                FROM videos v`;
  if (!q) return db.prepare(`${base} ORDER BY v.created_at DESC, v.id DESC`).all();
  const like = `%${q}%`;
  return db
    .prepare(
      `${base} WHERE v.title LIKE ?1 OR v.channel LIKE ?1 OR v.summary LIKE ?1 OR v.transcript LIKE ?1
         OR EXISTS (SELECT 1 FROM cards c WHERE c.video_id = v.id AND (c.question LIKE ?1 OR c.answer LIKE ?1))
       ORDER BY v.created_at DESC, v.id DESC`
    )
    .all(like);
}

// ---------- HTTP ----------
class UserError extends Error {}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(here, "public", "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/videos") {
      return send(res, 200, listVideos(url.searchParams.get("q")?.trim()));
    }
    const m = url.pathname.match(/^\/api\/videos\/(\d+)$/);
    if (m && req.method === "GET") {
      const v = getVideo(Number(m[1]));
      return v ? send(res, 200, v) : send(res, 404, { error: "Nicht gefunden" });
    }
    if (m && req.method === "DELETE") {
      db.prepare("DELETE FROM videos WHERE id = ?").run(Number(m[1]));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/videos") {
      const { url: link } = await readJson(req);
      const videoId = extractVideoId(link);
      if (!videoId) throw new UserError("Das sieht nicht nach einem YouTube-Link aus.");
      const [meta, transcript] = await Promise.all([fetchMeta(videoId), getTranscript(videoId)]);
      const result = await generateCards(transcript, meta.title);
      const id = saveVideo({
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        ...meta,
        transcript,
        ...result,
      });
      return send(res, 201, getVideo(id));
    }
    send(res, 404, { error: "Nicht gefunden" });
  } catch (e) {
    if (e instanceof UserError) return send(res, 400, { error: e.message });
    if (e instanceof ApiError) {
      if (e.status === 400 && /API key/i.test(e.message))
        return send(res, 400, { error: "Der API-Key ist ungültig. Prüfe die Datei .env." });
      if (e.status === 401 || e.status === 403)
        return send(res, 400, { error: "Der API-Key ist ungültig oder hat keinen Zugriff. Prüfe die Datei .env." });
      if (e.status === 429)
        return send(res, 429, { error: "Gratis-Limit erreicht – kurz warten (oder morgen) und nochmal versuchen." });
      return send(res, 502, { error: `KI-Fehler (${e.status}): ${e.message}` });
    }
    console.error(e);
    send(res, 500, { error: "Unerwarteter Fehler: " + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`ClipCards läuft auf http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log("Hinweis: GEMINI_API_KEY ist nicht gesetzt – trage ihn in die Datei .env ein.");
  }
});
