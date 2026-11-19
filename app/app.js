// ClipCards – läuft komplett im Browser. Gemini sieht sich das YouTube-Video direkt an,
// Videos und Karten werden im Browser (localStorage) gespeichert.

const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const MODEL_TIMEOUT_MS = 120_000;
const STORE_KEY = "clipcards.videos";
const API_KEY = "clipcards.geminiKey";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
let activeId = null;

class UserError extends Error {}

// ---------- Speicher ----------
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}
function loadVideos() {
  try { return JSON.parse(store(STORE_KEY) || "[]"); } catch { return []; }
}
function saveVideos(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    throw new UserError("Speichern im Browser nicht möglich (privater Modus oder Speicher voll).");
  }
}

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
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!r.ok) return {};
    const j = await r.json();
    return { title: j.title, channel: j.author_name };
  } catch {
    return {};
  }
}

// ---------- KI ----------
const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: { question: { type: "string" }, answer: { type: "string" } },
        required: ["question", "answer"],
      },
    },
  },
  required: ["title", "summary", "cards"],
};

const SYSTEM = `Du erstellst Lernmaterial aus YouTube-Videos.
Schreibe immer auf Deutsch, egal in welcher Sprache das Video ist.
- "title": ein kurzer deutscher Titel für das Video.
- "summary": eine klare Zusammenfassung des Videos in 1–3 kurzen Absätzen (Absätze mit Leerzeile trennen).
- "cards": 5 bis 10 Lernkarten. Jede Karte prüft genau einen wichtigen Gedanken aus dem Video.
  Die Frage ist konkret und ohne Kontext verständlich, die Antwort ist kurz (1–3 Sätze).
  Keine Fragen zu Nebensächlichkeiten wie Sponsoren, Begrüßung oder "Abonniert den Kanal".`;

async function callGemini(model, key, videoUrl) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{
        parts: [
          { fileData: { fileUri: videoUrl, mimeType: "video/*" } },
          { text: "Erstelle Zusammenfassung und Lernkarten zu diesem Video." },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
        mediaResolution: "MEDIA_RESOLUTION_LOW",
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function generateCards(videoUrl) {
  const key = store(API_KEY);
  if (!key) {
    openKeyDialog();
    throw new UserError("Bitte zuerst deinen kostenlosen Gemini-Key eintragen.");
  }
  let body;
  for (const [i, model] of MODELS.entries()) {
    try {
      body = await callGemini(model, key, videoUrl);
      break;
    } catch (e) {
      const msg = e.message || "";
      if (e.status === 400 && /api key/i.test(msg)) {
        openKeyDialog();
        throw new UserError("Der Gemini-Key ist ungültig. Bitte prüfen und neu eintragen.");
      }
      if (e.status === 401 || e.status === 403) {
        openKeyDialog();
        throw new UserError("Der Gemini-Key hat keinen Zugriff. Bitte prüfen und neu eintragen.");
      }
      if (e.status === 400 && /token|too long|exceeds/i.test(msg)) {
        throw new UserError("Das Video ist zu lang für das Gratis-Kontingent. Probier ein kürzeres (bis ca. 30 Minuten).");
      }
      if (e.status === 400) {
        throw new UserError("Gemini konnte das Video nicht öffnen. Ist es öffentlich? Details: " + msg);
      }
      if (i === MODELS.length - 1) {
        if (e.status === 429) throw new UserError("Gratis-Limit erreicht. Warte kurz (oder bis morgen) und versuch es nochmal.");
        if (e.name === "TimeoutError" || e.name === "AbortError") throw new UserError("Die KI hat zu lange gebraucht. Bitte nochmal versuchen.");
        throw new UserError("KI-Fehler: " + msg);
      }
    }
  }
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  let out;
  try { out = JSON.parse(text); } catch {
    throw new UserError("Die KI-Antwort war unvollständig oder wurde blockiert. Bitte nochmal versuchen.");
  }
  const cards = (Array.isArray(out.cards) ? out.cards : [])
    .filter((c) => c && c.question && c.answer)
    .slice(0, 10);
  if (!out.summary || cards.length === 0) throw new UserError("Die KI hat keine Karten erstellt. Bitte nochmal versuchen.");
  return { title: out.title, summary: out.summary, cards };
}

// ---------- Oberfläche ----------
function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const videos = loadVideos()
    .filter((v) => !q || [v.title, v.channel, v.summary, ...v.cards.flatMap((c) => [c.question, c.answer])]
      .some((t) => (t || "").toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#list").innerHTML = videos.length
    ? videos.map((v) => `
        <button class="item ${v.id === activeId ? "active" : ""}" data-id="${esc(v.id)}">
          <b>${esc(v.title || v.videoId)}</b>
          <small>${esc(v.channel || "")}${v.channel ? " · " : ""}${v.cards.length} Karten</small>
        </button>`).join("")
    : `<div class="empty">${q ? "Nichts gefunden." : "Noch keine Videos gespeichert."}</div>`;
}

function showVideo(id) {
  const v = loadVideos().find((x) => x.id === id);
  if (!v) return;
  activeId = id;
  const paras = v.summary.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("");
  $("#detail").innerHTML = `
    <h2>${esc(v.title || v.videoId)}</h2>
    <div class="meta">${esc(v.channel || "")}${v.channel ? " · " : ""}<a href="${esc(v.url)}" target="_blank" rel="noopener">auf YouTube ansehen</a></div>
    <div class="summary">${paras}</div>
    <div class="tools">
      <h3>Lernkarten (${v.cards.length})</h3>
      <button class="ghost small" id="shuffle">Mischen</button>
      <button class="ghost small" id="reset">Alle umdrehen</button>
      <button class="danger small" id="del">Löschen</button>
    </div>
    <div class="cards" id="cards"></div>
    <div class="hint">Tipp: Klick auf eine Karte dreht sie um.</div>`;
  renderCards(v.cards);
  $("#shuffle").onclick = () => renderCards([...v.cards].sort(() => Math.random() - 0.5));
  $("#reset").onclick = () => document.querySelectorAll(".card").forEach((c) => c.classList.remove("flipped"));
  $("#del").onclick = () => {
    if (!confirm("Dieses Video samt Karten löschen?")) return;
    saveVideos(loadVideos().filter((x) => x.id !== id));
    activeId = null;
    $("#detail").innerHTML = `<div class="placeholder">Gelöscht.</div>`;
    renderList();
  };
  renderList();
}

function renderCards(cards) {
  $("#cards").innerHTML = cards.map((c, i) => `
    <div class="card">
      <div class="card-inner">
        <div class="face front"><div class="label">Frage ${i + 1}</div><div class="txt">${esc(c.question)}</div></div>
        <div class="face back"><div class="label">Antwort</div><div class="txt">${esc(c.answer)}</div></div>
      </div>
    </div>`).join("");
  document.querySelectorAll(".card").forEach((el) => (el.onclick = () => el.classList.toggle("flipped")));
}

$("#add").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#addBtn"), st = $("#status");
  btn.disabled = true; st.className = "status";
  try {
    const videoId = extractVideoId($("#url").value);
    if (!videoId) throw new UserError("Das sieht nicht nach einem YouTube-Link aus.");
    st.textContent = "Die KI schaut sich das Video an… (dauert meist 10–60 Sekunden)";
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const [meta, result] = await Promise.all([fetchMeta(videoId), generateCards(url)]);
    const video = {
      id: crypto.randomUUID(),
      videoId, url,
      title: meta.title || result.title,
      channel: meta.channel || "",
      summary: result.summary,
      cards: result.cards,
      createdAt: new Date().toISOString(),
    };
    saveVideos([video, ...loadVideos().filter((v) => v.videoId !== videoId)]);
    st.textContent = "Fertig!";
    $("#url").value = "";
    $("#search").value = "";
    showVideo(video.id);
  } catch (err) {
    st.className = "status err";
    st.textContent = err instanceof UserError ? err.message : "Unerwarteter Fehler: " + err.message;
  } finally {
    btn.disabled = false;
  }
};

$("#list").onclick = (e) => { const b = e.target.closest(".item"); if (b) showVideo(b.dataset.id); };
let t; $("#search").oninput = () => { clearTimeout(t); t = setTimeout(renderList, 150); };

// ---------- API-Key ----------
function openKeyDialog() {
  $("#keyInput").value = store(API_KEY) || "";
  if (!$("#keyDialog").open) $("#keyDialog").showModal();
}
$("#keyBtn").onclick = openKeyDialog;
$("#keyCancel").onclick = () => $("#keyDialog").close();
$("#keyForm").onsubmit = () => {
  const k = $("#keyInput").value.trim();
  if (k) store(API_KEY, k);
};

// ---------- Sichern / Wiederherstellen ----------
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(loadVideos(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `clipcards-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async () => {
  const file = $("#importFile").files[0];
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming)) throw new Error();
    const byVideo = new Map(loadVideos().map((v) => [v.videoId, v]));
    for (const v of incoming) if (v && v.videoId && Array.isArray(v.cards)) byVideo.set(v.videoId, v);
    saveVideos([...byVideo.values()]);
    renderList();
    alert(`${incoming.length} Videos wiederhergestellt.`);
  } catch {
    alert("Diese Datei ist keine gültige ClipCards-Sicherung.");
  }
  $("#importFile").value = "";
};

// ---------- Installieren ----------
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("#installBtn").hidden = false;
});
$("#installBtn").onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("#installBtn").hidden = true;
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js").catch(() => {});

renderList();
if (!store(API_KEY)) openKeyDialog();
