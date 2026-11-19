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
const thumb = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
let session = null; // Lernmodus: { videoId, queue, known, firstTry, total, flipped }
let tab = "learn";

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2200);
}

function renderList() {
  const all = loadVideos();
  const q = $("#search").value.trim().toLowerCase();
  const videos = all
    .filter((v) => !q || [v.title, v.channel, v.summary, ...v.cards.flatMap((c) => [c.question, c.answer])]
      .some((t) => (t || "").toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#count").textContent = all.length ? `${all.length} ${all.length === 1 ? "Video" : "Videos"}` : "";
  $("#list").innerHTML = videos.length
    ? videos.map((v) => `
        <button class="item ${v.id === activeId ? "active" : ""}" data-id="${esc(v.id)}">
          <img src="${thumb(v.videoId)}" alt="" loading="lazy">
          <span><b>${esc(v.title || v.videoId)}</b><small>${v.cards.length} Karten${v.channel ? " · " + esc(v.channel) : ""}</small></span>
        </button>`).join("")
    : `<div class="lib-empty">${q ? "Nichts gefunden." : "Hier landen deine Videos."}</div>`;
}

function renderEmpty() {
  activeId = null;
  session = null;
  $("#view").innerHTML = `
    <div class="empty">
      <div class="fan"><i></i><i></i><i></i></div>
      <h2 class="serif">Noch keine Karten in Sicht.</h2>
      <p>Kopier einen Link von YouTube, füg ihn oben ein und klick auf „Karten machen“. Ein paar Sekunden später kannst du loslernen.</p>
      <span class="hand">Tipp: Erklärvideos funktionieren am besten!</span>
    </div>`;
  renderList();
}

const LOADING_LINES = [
  "Die KI schaut sich das Video an …",
  "Sie sucht die wichtigsten Punkte heraus …",
  "Sie schreibt die Fragen …",
  "Und die Antworten auf die Rückseite …",
];
function renderLoading() {
  let i = 0;
  $("#view").innerHTML = `
    <div class="loading">
      <div class="shuffle"><i></i><i></i><i></i></div>
      <h2 class="serif" id="loadLine">${LOADING_LINES[0]}</h2>
      <p>Dauert meist 10–40 Sekunden.</p>
    </div>`;
  const timer = setInterval(() => {
    const el = $("#loadLine");
    if (!el) return clearInterval(timer);
    i = Math.min(i + 1, LOADING_LINES.length - 1);
    el.textContent = LOADING_LINES[i];
  }, 5000);
}

function showVideo(id, keepTab) {
  const v = loadVideos().find((x) => x.id === id);
  if (!v) return renderEmpty();
  if (activeId !== id) session = null;
  activeId = id;
  if (!keepTab) tab = "learn";
  const paras = v.summary.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("");
  $("#view").innerHTML = `
    <div class="video-head">
      <a class="thumb" href="${esc(v.url)}" target="_blank" rel="noopener" title="Auf YouTube ansehen"><img src="${thumb(v.videoId)}" alt=""></a>
      <div>
        <h2 class="serif">${esc(v.title || v.videoId)}</h2>
        <div class="meta">${v.channel ? esc(v.channel) + " · " : ""}${v.cards.length} Karten · ${new Date(v.createdAt).toLocaleDateString("de")}</div>
        <div class="actions">
          <a class="chip" href="${esc(v.url)}" target="_blank" rel="noopener" style="text-decoration:none">Video ansehen</a>
          <button class="chip danger" id="del">Löschen</button>
        </div>
      </div>
    </div>
    <div class="summary"><span class="tag">Zusammenfassung</span>${paras}</div>
    <div class="tabs">
      <h3 class="serif">Lernkarten</h3>
      <button class="tab ${tab === "learn" ? "on" : ""}" data-tab="learn">Lernen</button>
      <button class="tab ${tab === "all" ? "on" : ""}" data-tab="all">Alle Karten</button>
    </div>
    <div id="cardsArea"></div>`;
  $("#del").onclick = () => {
    if (!confirm("Dieses Video samt Karten löschen?")) return;
    saveVideos(loadVideos().filter((x) => x.id !== id));
    toast("Gelöscht");
    renderEmpty();
  };
  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; showVideo(id, true); }));
  if (tab === "learn") renderLearn(v); else renderAll(v);
  renderList();
}

function renderAll(v) {
  $("#cardsArea").innerHTML = `<div class="grid">${v.cards.map((c, i) => `
    <div class="mini"><div class="in">
      <div class="face front"><small>Karte ${i + 1}</small><div class="q">${esc(c.question)}</div></div>
      <div class="face back"><small>Antwort</small><div class="a">${esc(c.answer)}</div></div>
    </div></div>`).join("")}</div>`;
  document.querySelectorAll(".mini").forEach((el) => (el.onclick = () => el.classList.toggle("flip")));
}

function startSession(v) {
  const order = v.cards.map((_, i) => i).sort(() => Math.random() - 0.5);
  session = { videoId: v.id, queue: order, known: 0, firstTry: 0, missed: new Set(), total: v.cards.length, flipped: false };
}

function renderLearn(v) {
  if (!session || session.videoId !== v.id) startSession(v);
  const s = session;
  if (s.queue.length === 0) {
    const pct = Math.round((s.firstTry / s.total) * 100);
    const praise = pct === 100 ? "Perfekt, alles gewusst!" : pct >= 70 ? "Stark, fast alles drin!" : pct >= 40 ? "Guter Anfang, nochmal?" : "Übung macht den Meister!";
    $("#cardsArea").innerHTML = `
      <div class="done">
        <span class="hand">${praise}</span>
        <div class="score serif">${s.firstTry} / ${s.total}</div>
        <p>beim ersten Versuch gewusst</p>
        <div class="grade"><button class="yes" id="again">Nochmal lernen</button><button id="showAll">Alle Karten ansehen</button></div>
      </div>`;
    $("#again").onclick = () => { startSession(v); renderLearn(v); };
    $("#showAll").onclick = () => { tab = "all"; showVideo(v.id, true); };
    return;
  }
  const card = v.cards[s.queue[0]];
  $("#cardsArea").innerHTML = `
    <div class="learn">
      <div class="progress"><span>${s.known} / ${s.total} gewusst</span><div class="bar"><span style="width:${(s.known / s.total) * 100}%"></span></div><span>${s.queue.length} übrig</span></div>
      <div class="big ${s.flipped ? "flip" : ""}" id="big" tabindex="0" role="button" aria-label="Karte umdrehen">
        <div class="in">
          <div class="face front"><small>Frage</small><div class="q">${esc(card.question)}</div><div class="flip-hint">Klicken zum Umdrehen</div></div>
          <div class="face back"><small>Antwort</small><div class="a">${esc(card.answer)}</div><div class="flip-hint">Und, wusstest du's?</div></div>
        </div>
      </div>
      <div class="grade ${s.flipped ? "" : "wait"}">
        <button class="no" id="no">Nochmal</button>
        <button class="yes" id="yes">Gewusst</button>
      </div>
      <div class="keys"><kbd>Leertaste</kbd> umdrehen · <kbd>1</kbd> nochmal · <kbd>2</kbd> gewusst</div>
    </div>`;
  $("#big").onclick = () => flip();
  $("#no").onclick = () => grade(false);
  $("#yes").onclick = () => grade(true);
}

function flip() {
  if (!session || tab !== "learn" || !$("#big")) return;
  session.flipped = !session.flipped;
  $("#big").classList.toggle("flip", session.flipped);
  document.querySelector(".grade").classList.toggle("wait", !session.flipped);
}

function grade(knew) {
  const s = session;
  if (!s || !s.flipped || !s.queue.length) return;
  const idx = s.queue.shift();
  if (knew) {
    s.known++;
    if (!s.missed.has(idx)) s.firstTry++;
  } else {
    s.missed.add(idx);
    s.queue.push(idx);
  }
  s.flipped = false;
  const v = loadVideos().find((x) => x.id === s.videoId);
  if (v) renderLearn(v);
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, dialog") || tab !== "learn" || !session) return;
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
  else if (e.key === "1" || e.key === "ArrowLeft") grade(false);
  else if (e.key === "2" || e.key === "ArrowRight") grade(true);
});

$("#add").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#addBtn"), st = $("#status");
  st.textContent = "";
  const videoId = extractVideoId($("#url").value);
  if (!videoId) { st.textContent = "Das sieht nicht nach einem YouTube-Link aus."; return; }
  btn.disabled = true;
  const previous = activeId;
  renderLoading();
  try {
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
    $("#url").value = "";
    $("#search").value = "";
    toast(`${video.cards.length} Karten erstellt`);
    showVideo(video.id);
  } catch (err) {
    st.textContent = err instanceof UserError ? err.message : "Unerwarteter Fehler: " + err.message;
    if (previous) showVideo(previous, true); else renderEmpty();
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
  if (k) { store(API_KEY, k); toast("Key gespeichert"); }
};

// ---------- Sichern / Wiederherstellen ----------
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(loadVideos(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `clipcards-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Sicherung heruntergeladen");
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
    toast(`${incoming.length} Videos wiederhergestellt`);
  } catch {
    toast("Keine gültige ClipCards-Sicherung");
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

// ---------- Start ----------
const newest = loadVideos().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
if (newest) showVideo(newest.id); else renderEmpty();

// Link von der Startseite übernehmen (…/app/?url=…)
const incomingUrl = new URLSearchParams(location.search).get("url");
if (incomingUrl) {
  $("#url").value = incomingUrl;
  history.replaceState(null, "", location.pathname);
}
if (!store(API_KEY)) openKeyDialog();
else if (incomingUrl) $("#add").requestSubmit();

// Nach dem Speichern des Keys einen wartenden Link direkt verarbeiten
let pendingFromLanding = Boolean(incomingUrl);
$("#keyDialog").addEventListener("close", () => {
  if (pendingFromLanding && store(API_KEY) && $("#url").value.trim()) {
    pendingFromLanding = false;
    $("#add").requestSubmit();
  }
});
