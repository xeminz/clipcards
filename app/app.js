// ClipCards – läuft komplett im Browser. Gemini sieht sich das YouTube-Video direkt an,
// Videos, Fächer und Karten werden im Browser (localStorage) gespeichert.

const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const MODEL_TIMEOUT_MS = 120_000;
const STORE_KEY = "clipcards.videos";
const FOLDER_KEY = "clipcards.folders";
const API_KEY = "clipcards.geminiKey";
const COLORS = ["#d9480f", "#2f7d4f", "#2563eb", "#9333ea", "#c2410c", "#0e7490", "#be185d", "#a16207"];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

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
function readJson(key) {
  try { return JSON.parse(store(key) || "[]"); } catch { return []; }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new UserError("Speichern im Browser nicht möglich (privater Modus oder Speicher voll).");
  }
}
const loadVideos = () => readJson(STORE_KEY).map((v) => ({ folderId: null, quiz: [], ...v }));
const saveVideos = (list) => writeJson(STORE_KEY, list);
const loadFolders = () => readJson(FOLDER_KEY);
const saveFolders = (list) => writeJson(FOLDER_KEY, list);
const getVideo = (id) => loadVideos().find((v) => v.id === id);
function updateVideo(id, fn) {
  const list = loadVideos();
  const v = list.find((x) => x.id === id);
  if (!v) return null;
  fn(v);
  saveVideos(list);
  return v;
}
const folderOf = (id) => loadFolders().find((f) => f.id === id);

// ---------- Fortschritt: XP, Level, Lernserie, Tagesziel ----------
const STATS_KEY = "clipcards.stats";
const DAILY_GOAL = 20;
const XP = { known: 10, again: 3, quizRight: 15, quizWrong: 3, newVideo: 25 };
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function loadStats() {
  try { return { xp: 0, days: {}, ...JSON.parse(store(STATS_KEY) || "{}") }; } catch { return { xp: 0, days: {} }; }
}
const levelOf = (xp) => Math.floor(Math.sqrt(xp / 60)) + 1;
const xpForLevel = (lv) => 60 * (lv - 1) ** 2;
function streakOf(stats) {
  let n = 0;
  const d = new Date();
  if (!stats.days[dayKey(d)]) d.setDate(d.getDate() - 1); // heute noch nicht gelernt: Serie zählt bis gestern
  while (stats.days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function addProgress(xp, cards = 0, anchor) {
  const s = loadStats();
  s.xp += xp;
  const k = dayKey();
  s.days[k] = (s.days[k] || 0) + cards;
  if (!s.days[k] && xp) s.days[k] = 0.001; // Aktivität ohne Karten zählt für die Serie
  try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch {}
  renderBadges(true);
  if (anchor && xp) xpPop(anchor, `+${xp} XP`);
}
// ---------- Belohnungen: Farben und Kartendesigns ----------
const THEME_KEY = "clipcards.theme";
const REWARDS = [
  { type: "accent", id: "",         name: "Orange",      level: 1,  color: "#d9480f" },
  { type: "cards",  id: "",         name: "Liniert",     level: 1,  pv: "lined",  sample: "Frage?" },
  { type: "accent", id: "ocean",    name: "Ozean",       level: 2,  color: "#2563eb" },
  { type: "cards",  id: "grid",     name: "Karopapier",  level: 3,  pv: "grid",   sample: "Frage?" },
  { type: "accent", id: "forest",   name: "Wald",        level: 4,  color: "#2f7d4f" },
  { type: "cards",  id: "sticky",   name: "Post-it",     level: 5,  pv: "sticky", sample: "Frage?" },
  { type: "accent", id: "lavender", name: "Lavendel",    level: 6,  color: "#7c3aed" },
  { type: "accent", id: "rose",     name: "Himbeere",    level: 8,  color: "#db2777" },
  { type: "cards",  id: "chalk",    name: "Schultafel",  level: 10, pv: "chalk",  sample: "Frage?" },
];
function loadTheme() {
  try { return { accent: "", cards: "", seenLevel: 1, ...JSON.parse(store(THEME_KEY) || "{}") }; } catch { return { accent: "", cards: "", seenLevel: 1 }; }
}
function saveTheme(t) { try { localStorage.setItem(THEME_KEY, JSON.stringify(t)); } catch {} }
function applyTheme() {
  const t = loadTheme();
  const lv = levelOf(loadStats().xp);
  const ok = (type, id) => !id || REWARDS.some((r) => r.type === type && r.id === id && r.level <= lv);
  const root = document.documentElement;
  if (t.accent && ok("accent", t.accent)) root.dataset.accent = t.accent; else delete root.dataset.accent;
  if (t.cards && ok("cards", t.cards)) root.dataset.cards = t.cards; else delete root.dataset.cards;
}
const nextReward = (lv) => REWARDS.filter((r) => r.level > lv).sort((a, b) => a.level - b.level)[0];
const newRewards = () => {
  const lv = levelOf(loadStats().xp), seen = loadTheme().seenLevel;
  return REWARDS.filter((r) => r.level > seen && r.level <= lv);
};

function openRewards() {
  const s = loadStats();
  const lv = levelOf(s.xp), from = xpForLevel(lv), to = xpForLevel(lv + 1);
  const t = loadTheme();
  const fresh = new Set(newRewards().map((r) => r.type + r.id));
  const tile = (r) => {
    const locked = r.level > lv;
    const on = (r.type === "accent" ? t.accent : t.cards) === r.id;
    const pv = r.type === "accent"
      ? `<div class="pv" style="background:${r.color};color:#fff">Aa</div>`
      : `<div class="pv ${r.pv}">${r.sample}</div>`;
    return `<button class="rw ${on ? "on" : ""}" data-type="${r.type}" data-id="${r.id}" ${locked ? "disabled" : ""}>
      ${pv}<b>${r.name}</b><small>${locked ? `ab Level ${r.level}` : on ? "Aktiv" : "Freigeschaltet"}</small>
      ${locked ? `<span class="lock">🔒 ${r.level}</span>` : fresh.has(r.type + r.id) ? `<span class="new">Neu</span>` : ""}
    </button>`;
  };
  $("#rewardsBody").innerHTML = `
    <div class="rw-level"><b>Level ${lv}</b><div class="bar"><span style="width:${((s.xp - from) / (to - from)) * 100}%"></span></div><span>${s.xp} / ${to} XP</span></div>
    <div class="rw-sec">Farbe</div><div class="rw-grid">${REWARDS.filter((r) => r.type === "accent").map(tile).join("")}</div>
    <div class="rw-sec">Kartendesign</div><div class="rw-grid">${REWARDS.filter((r) => r.type === "cards").map(tile).join("")}</div>`;
  $$("#rewardsBody .rw").forEach((b) => (b.onclick = () => {
    const theme = loadTheme();
    theme[b.dataset.type] = b.dataset.id;
    saveTheme(theme);
    applyTheme();
    openRewards();
  }));
  saveTheme({ ...loadTheme(), seenLevel: Math.max(lv, t.seenLevel) });
  renderBadges();
  if (!$("#rewardsDialog").open) $("#rewardsDialog").showModal();
}

function renderBadges(animate) {
  const s = loadStats();
  const lv = levelOf(s.xp);
  const from = xpForLevel(lv), to = xpForLevel(lv + 1);
  const streak = streakOf(s);
  $("#streakN").textContent = streak;
  $("#streakBadge").classList.toggle("cold", !s.days[dayKey()]);
  $("#levelN").textContent = lv;
  $("#xpN").textContent = s.xp;
  $("#levelRing").style.strokeDashoffset = String(94.25 * (1 - (s.xp - from) / (to - from)));
  const fresh = newRewards();
  $("#levelBadge").classList.toggle("has-new", fresh.length > 0);
  $("#levelBadge").title = fresh.length
    ? `Neu freigeschaltet: ${fresh.map((r) => r.name).join(", ")} – klick zum Ansehen`
    : `Level ${lv} – noch ${to - s.xp} XP bis Level ${lv + 1}. Klick für Belohnungen`;
  if (animate) { $("#levelBadge").classList.remove("bump"); void $("#levelBadge").offsetWidth; $("#levelBadge").classList.add("bump"); }
}
function xpPop(anchor, text) {
  const r = anchor.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "xp-pop";
  el.textContent = text;
  el.style.left = r.left + r.width / 2 + "px";
  el.style.top = r.top - 6 + "px";
  document.body.append(el);
  setTimeout(() => el.remove(), 1000);
}

// Kleines Konfetti ohne Bibliothek
function confetti(count = 120) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = $("#confetti"), ctx = c.getContext("2d");
  c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const colors = ["#d9480f", "#ff9f43", "#2f7d4f", "#2563eb", "#9333ea", "#facc15"];
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight * .35,
    vx: (Math.random() - .5) * 14, vy: -Math.random() * 13 - 4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - .5) * .4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (++frame < 160) requestAnimationFrame(tick); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })();
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
const thumb = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;

// ---------- KI ----------
const QUIZ_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      correct: { type: "integer" },
      explanation: { type: "string" },
    },
    required: ["question", "options", "correct", "explanation"],
  },
};

const VIDEO_SCHEMA = {
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
    quiz: QUIZ_SCHEMA,
  },
  required: ["title", "summary", "cards", "quiz"],
};

const QUIZ_RULES = `5 Multiple-Choice-Fragen. Jede hat genau 4 Antwortmöglichkeiten ("options"), davon genau eine richtig.
  "correct" ist der Index (0–3) der richtigen Antwort. Die falschen Antworten sind plausibel, aber eindeutig falsch.
  "explanation" erklärt in einem Satz, warum die richtige Antwort stimmt.`;

const VIDEO_SYSTEM = `Du erstellst Lernmaterial aus YouTube-Videos.
Schreibe immer auf Deutsch, egal in welcher Sprache das Video ist.
- "title": ein kurzer deutscher Titel für das Video.
- "summary": eine klare Zusammenfassung des Videos in 1–3 kurzen Absätzen (Absätze mit Leerzeile trennen).
- "cards": 5 bis 10 Lernkarten. Jede Karte prüft genau einen wichtigen Gedanken aus dem Video.
  Die Frage ist konkret und ohne Kontext verständlich, die Antwort ist kurz (1–3 Sätze).
  Keine Fragen zu Nebensächlichkeiten wie Sponsoren, Begrüßung oder "Abonniert den Kanal".
- "quiz": ${QUIZ_RULES}`;

const QUIZ_SYSTEM = `Du erstellst ein Quiz auf Deutsch aus Lernmaterial zu einem Video.
Gib ${QUIZ_RULES}
Frage nur nach Inhalten, die im Material vorkommen.`;

async function callGemini(model, key, { system, parts, schema, video }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        ...(video ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
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

async function askGemini(request) {
  const key = store(API_KEY);
  if (!key) {
    openKeyDialog();
    throw new UserError("Bitte zuerst deinen kostenlosen Gemini-Key eintragen.");
  }
  let body;
  for (const [i, model] of MODELS.entries()) {
    try {
      body = await callGemini(model, key, request);
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
        throw new UserError((request.video ? "Gemini konnte das Video nicht öffnen. Ist es öffentlich? " : "KI-Fehler: ") + msg);
      }
      if (i === MODELS.length - 1) {
        if (e.status === 429) throw new UserError("Gratis-Limit erreicht. Warte kurz (oder bis morgen) und versuch es nochmal.");
        if (e.name === "TimeoutError" || e.name === "AbortError") throw new UserError("Die KI hat zu lange gebraucht. Bitte nochmal versuchen.");
        throw new UserError("KI-Fehler: " + msg);
      }
    }
  }
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError("Die KI-Antwort war unvollständig oder wurde blockiert. Bitte nochmal versuchen.");
  }
}

function cleanQuiz(quiz) {
  return (Array.isArray(quiz) ? quiz : [])
    .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2 &&
      Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length)
    .map((q) => ({ question: q.question, options: q.options.slice(0, 4), correct: q.correct, explanation: q.explanation || "" }))
    .filter((q) => q.correct < q.options.length)
    .slice(0, 8);
}

async function generateFromVideo(videoUrl) {
  const out = await askGemini({
    system: VIDEO_SYSTEM,
    schema: VIDEO_SCHEMA,
    video: true,
    parts: [
      { fileData: { fileUri: videoUrl, mimeType: "video/*" } },
      { text: "Erstelle Zusammenfassung, Lernkarten und Quiz zu diesem Video." },
    ],
  });
  const cards = (Array.isArray(out.cards) ? out.cards : [])
    .filter((c) => c && c.question && c.answer)
    .map((c) => ({ question: c.question, answer: c.answer }))
    .slice(0, 10);
  if (!out.summary || cards.length === 0) throw new UserError("Die KI hat keine Karten erstellt. Bitte nochmal versuchen.");
  return { title: out.title, summary: out.summary, cards, quiz: cleanQuiz(out.quiz) };
}

async function generateQuizFor(video) {
  const material = `Titel: ${video.title}\n\nZusammenfassung:\n${video.summary}\n\nLernkarten:\n` +
    video.cards.map((c) => `- ${c.question} → ${c.answer}`).join("\n");
  const quiz = cleanQuiz(await askGemini({ system: QUIZ_SYSTEM, schema: QUIZ_SCHEMA, parts: [{ text: material }] }));
  if (!quiz.length) throw new UserError("Die KI hat kein Quiz erstellt. Bitte nochmal versuchen.");
  return quiz;
}

// ---------- Zustand ----------
let activeId = null;          // geöffnetes Video
let folderFilter = "all";     // "all" | "none" | Fach-ID
let view = "empty";           // "empty" | "video" | "folder" | "loading"
let tab = "learn";            // "learn" | "quiz" | "all"
let session = null;           // Lernmodus
let quiz = null;              // Quizmodus

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2400);
}

function inFilter(v) {
  if (folderFilter === "all") return true;
  if (folderFilter === "none") return !v.folderId || !folderOf(v.folderId);
  return v.folderId === folderFilter;
}

// ---------- Seitenleiste ----------
function renderSidebar() {
  const videos = loadVideos();
  const folders = loadFolders();
  const count = (fid) => videos.filter((v) => v.folderId === fid).length;
  const loose = videos.filter((v) => !v.folderId || !folderOf(v.folderId)).length;
  $("#folders").innerHTML = `
    <button class="fold ${folderFilter === "all" ? "on" : ""}" data-f="all"><i style="background:var(--ink)"></i>Alle<span>${videos.length}</span></button>
    ${folders.map((f) => `<button class="fold ${folderFilter === f.id ? "on" : ""}" data-f="${esc(f.id)}"><i style="background:${esc(f.color)}"></i>${esc(f.name)}<span>${count(f.id)}</span></button>`).join("")}
    ${folders.length && loose ? `<button class="fold ${folderFilter === "none" ? "on" : ""}" data-f="none"><i style="background:var(--line)"></i>Ohne Fach<span>${loose}</span></button>` : ""}
    <button class="fold add-fold" id="newFolder">+ Neues Fach</button>`;

  const q = $("#search").value.trim().toLowerCase();
  const list = videos
    .filter(inFilter)
    .filter((v) => !q || [v.title, v.channel, v.summary, ...v.cards.flatMap((c) => [c.question, c.answer])]
      .some((t) => (t || "").toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#list").innerHTML = list.length
    ? list.map((v) => {
        const f = folderOf(v.folderId);
        const hard = v.cards.filter((c) => c.hard).length;
        return `
        <button class="item ${v.id === activeId && view === "video" ? "active" : ""}" data-id="${esc(v.id)}">
          <img src="${thumb(v.videoId)}" alt="" loading="lazy">
          <span><b>${esc(v.title || v.videoId)}</b>
          <small>${f ? `<em style="color:${esc(f.color)}">●</em> ${esc(f.name)} · ` : ""}${v.cards.length} Karten${hard ? ` · <em class="hardtag">${hard} schwer</em>` : ""}</small></span>
        </button>`;
      }).join("")
    : `<div class="lib-empty">${q ? "Nichts gefunden." : folderFilter === "all" ? "Hier landen deine Videos." : "In diesem Fach ist noch nichts."}</div>`;

  // Fach-Auswahl im Formular aktuell halten
  const sel = $("#addFolder");
  const current = sel.value;
  sel.innerHTML = `<option value="">Ohne Fach</option>` + folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  sel.value = folders.some((f) => f.id === current) ? current : (folders.some((f) => f.id === folderFilter) ? folderFilter : "");
  $("#navHome").classList.toggle("on", view === "home");
}

$("#folders").addEventListener("click", (e) => {
  if (e.target.closest("#newFolder")) return openFolderDialog();
  const b = e.target.closest(".fold");
  if (!b) return;
  folderFilter = b.dataset.f;
  if (folderFilter === "all") { renderSidebar(); return; }
  $("#addFolder").value = folderFilter === "none" ? "" : folderFilter;
  if (folderFilter === "none") renderSidebar(); else showFolder(folderFilter);
});
$("#list").onclick = (e) => { const b = e.target.closest(".item"); if (b) showVideo(b.dataset.id); };
let searchTimer; $("#search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSidebar, 150); };

$("#navHome").onclick = () => { folderFilter = "all"; renderHome(); };
$(".brand").addEventListener("click", (e) => { if (view !== "home") { e.preventDefault(); folderFilter = "all"; renderHome(); } });

// ---------- Ansichten ----------
const renderEmpty = () => renderHome();

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Noch wach?" : h < 11 ? "Guten Morgen!" : h < 17 ? "Hallo!" : h < 22 ? "Guten Abend!" : "Späte Lernrunde?";
}

function renderHome() {
  view = "home"; activeId = null; session = null; quiz = null;
  const videos = loadVideos().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const s = loadStats();
  const today = Math.floor(s.days[dayKey()] || 0);
  const streak = streakOf(s);
  const lv = levelOf(s.xp), from = xpForLevel(lv), to = xpForLevel(lv + 1);
  const cards = videos.reduce((n, v) => n + v.cards.length, 0);
  const hard = videos.reduce((n, v) => n + v.cards.filter((c) => c.hard).length, 0);
  const quizN = videos.reduce((n, v) => n + v.quiz.length, 0);
  const last = videos[0];
  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return d; });
  const mood = !videos.length ? "Los geht's mit deinem ersten Video!"
    : today >= DAILY_GOAL ? "Tagesziel geschafft, stark!"
    : streak >= 3 ? `${streak} Tage am Stück, weiter so!`
    : hard ? `${hard} ${hard === 1 ? "Karte wartet" : "Karten warten"} auf eine zweite Chance.`
    : "Bereit für eine Runde?";

  $("#view").innerHTML = `
    <div class="hello">
      <div><h1 class="serif">${greeting()}</h1><span class="hand">${mood}</span></div>
    </div>
    <div class="stats">
      <div class="stat" style="--tint:#ff6a1f"><small>Lernserie</small><div class="big-n">${streak} ${streak === 1 ? "Tag" : "Tage"} 🔥</div>
        <div class="week">${week.map((d) => `<i class="${s.days[dayKey(d)] ? "on" : ""} ${dayKey(d) === dayKey() ? "today" : ""}"><span>${"SMDMDFS"[d.getDay()]}</span></i>`).join("")}</div></div>
      <div class="stat" style="--tint:#2f7d4f"><small>Heute gelernt</small><div class="big-n">${today} <span style="font-size:18px;color:var(--muted)">/ ${DAILY_GOAL}</span></div>
        <div class="sub">${today >= DAILY_GOAL ? "Tagesziel erreicht 🎉" : `Noch ${DAILY_GOAL - today} Karten bis zum Tagesziel`}</div>
        <div class="meter"><span style="width:${Math.min(100, (today / DAILY_GOAL) * 100)}%"></span></div></div>
      <div class="stat" id="statLevel" style="--tint:#7c3aed;cursor:pointer" title="Belohnungen ansehen"><small>Level</small><div class="big-n">${lv}</div>
        <div class="sub">${s.xp} XP · noch ${to - s.xp} bis Level ${lv + 1}</div>
        <div class="meter"><span style="width:${((s.xp - from) / (to - from)) * 100}%"></span></div>
        <div class="next-reward">${nextReward(lv) ? `Nächste Belohnung: <b>${nextReward(lv).name}</b> (Level ${nextReward(lv).level})` : "Alle Belohnungen freigeschaltet!"}</div></div>
      <div class="stat" style="--tint:#2563eb"><small>Deine Sammlung</small><div class="big-n">${cards}</div>
        <div class="sub">Karten aus ${videos.length} ${videos.length === 1 ? "Video" : "Videos"} · ${quizN} Quizfragen</div></div>
    </div>
    ${videos.length ? `
    <div class="actions-row">
      <button class="act continue" id="actContinue"><img src="${thumb(last.videoId)}" alt=""><small>Weiterlernen</small><b>${esc(last.title || last.videoId)}</b></button>
      <button class="act hard" id="actHard" ${hard ? "" : "disabled"}><span class="em">🎯</span><small>Gezielt üben</small><b>${hard ? `${hard} schwierige ${hard === 1 ? "Karte" : "Karten"}` : "Keine schwierigen Karten"}</b></button>
      <button class="act mix" id="actMix" ${quizN ? "" : "disabled"}><span class="em">🎲</span><small>Zufalls-Quiz</small><b>Gemischt aus allen Fächern</b></button>
    </div>
    <div class="sec-title"><h3 class="serif">Zuletzt hinzugefügt</h3></div>
    <div class="tiles">${videos.slice(0, 8).map((v) => {
      const f = folderOf(v.folderId);
      return `<button class="tile" data-id="${esc(v.id)}"><img src="${thumb(v.videoId)}" alt="" loading="lazy"><b>${esc(v.title || v.videoId)}</b><small>${f ? `<em style="color:${esc(f.color)};font-style:normal">●</em> ${esc(f.name)} · ` : ""}${v.cards.length} Karten</small></button>`;
    }).join("")}</div>` : `
    <div class="empty">
      <div class="fan"><i></i><i></i><i></i></div>
      <h2 class="serif">Noch keine Karten in Sicht.</h2>
      <p>Kopier einen Link von YouTube, füg ihn oben ein und klick auf „Karten machen“. Für jedes Video gibt es <b>25 XP</b>, für jede gewusste Karte <b>10 XP</b>.</p>
      <span class="hand">Tipp: Leg dir links Fächer an, z. B. „Bio“ oder „Mathe“!</span>
    </div>`}`;
  $$(".tile").forEach((b) => (b.onclick = () => showVideo(b.dataset.id)));
  $("#statLevel").onclick = openRewards;
  $("#actContinue") && ($("#actContinue").onclick = () => showVideo(last.id));
  $("#actHard") && ($("#actHard").onclick = () => showPractice("hard"));
  $("#actMix") && ($("#actMix").onclick = () => showPractice("quiz"));
  renderSidebar();
}

function showPractice(mode) {
  view = "practice"; activeId = mode; session = null; quiz = null;
  tab = mode === "quiz" ? "quiz" : "learn";
  const scope = currentScope();
  $("#view").innerHTML = `
    <div class="practice-head">
      <span class="em">${mode === "quiz" ? "🎲" : "🎯"}</span>
      <div><h2 class="serif">${mode === "quiz" ? "Zufalls-Quiz" : "Schwierige Karten"}</h2>
      <p>${mode === "quiz" ? "Fragen aus all deinen Videos, bunt gemischt." : "Alles, was du zuletzt nicht wusstest, aus allen Fächern."}</p></div>
    </div>
    <div id="area"></div>`;
  if (mode === "quiz") renderQuiz(scope);
  else { startSession(scope, true); renderLearn(scope); }
  renderSidebar();
}

const LOADING_LINES = [
  "Die KI schaut sich das Video an …",
  "Sie sucht die wichtigsten Punkte heraus …",
  "Sie schreibt die Lernkarten …",
  "Und bastelt noch ein Quiz …",
];
function renderLoading(lines = LOADING_LINES, hint = "Dauert meist 10–40 Sekunden.") {
  view = "loading";
  let i = 0;
  $("#view").innerHTML = `
    <div class="loading">
      <div class="shuffle"><i></i><i></i><i></i></div>
      <h2 class="serif" id="loadLine">${lines[0]}</h2>
      <p>${hint}</p>
    </div>`;
  const timer = setInterval(() => {
    const el = $("#loadLine");
    if (!el) return clearInterval(timer);
    i = Math.min(i + 1, lines.length - 1);
    el.textContent = lines[i];
  }, 5000);
}

function folderSelect(selected, id) {
  return `<select class="chip select" id="${id}" title="Fach">
    <option value="">Ohne Fach</option>
    ${loadFolders().map((f) => `<option value="${esc(f.id)}" ${f.id === selected ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
  </select>`;
}

function showVideo(id, keepTab) {
  const v = getVideo(id);
  if (!v) return renderEmpty();
  if (activeId !== id || view !== "video") { session = null; quiz = null; }
  activeId = id;
  view = "video";
  if (!keepTab) tab = "learn";
  const f = folderOf(v.folderId);
  const paras = v.summary.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("");
  $("#view").innerHTML = `
    <div class="video-head">
      <a class="thumb" href="${esc(v.url)}" target="_blank" rel="noopener" title="Auf YouTube ansehen"><img src="${thumb(v.videoId)}" alt=""></a>
      <div>
        ${f ? `<button class="crumb" data-folder="${esc(f.id)}"><i style="background:${esc(f.color)}"></i>${esc(f.name)}</button>` : ""}
        <h2 class="serif">${esc(v.title || v.videoId)}</h2>
        <div class="meta">${v.channel ? esc(v.channel) + " · " : ""}${v.cards.length} Karten · ${v.quiz.length ? v.quiz.length + " Quizfragen · " : ""}${new Date(v.createdAt).toLocaleDateString("de")}</div>
        <div class="actions">
          ${folderSelect(v.folderId, "moveFolder")}
          <a class="chip" href="${esc(v.url)}" target="_blank" rel="noopener">Video ansehen</a>
          <button class="chip danger" id="del">Löschen</button>
        </div>
      </div>
    </div>
    <div class="summary"><span class="tag">Zusammenfassung</span>${paras}</div>
    <div class="tabs">
      <h3 class="serif">Üben</h3>
      <button class="tab ${tab === "learn" ? "on" : ""}" data-tab="learn">Lernkarten</button>
      <button class="tab ${tab === "quiz" ? "on" : ""}" data-tab="quiz">Quiz</button>
      <button class="tab ${tab === "all" ? "on" : ""}" data-tab="all">Alle Karten</button>
    </div>
    <div id="area"></div>`;
  $(".crumb")?.addEventListener("click", (e) => { folderFilter = e.currentTarget.dataset.folder; showFolder(folderFilter); });
  $("#moveFolder").onchange = (e) => {
    const fid = e.target.value || null;
    updateVideo(id, (x) => { x.folderId = fid; });
    toast(fid ? `In „${folderOf(fid).name}“ verschoben` : "Aus dem Fach genommen");
    showVideo(id, true);
  };
  $("#del").onclick = () => {
    if (!confirm("Dieses Video samt Karten löschen?")) return;
    saveVideos(loadVideos().filter((x) => x.id !== id));
    toast("Gelöscht");
    renderEmpty();
  };
  $$(".tab").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; showVideo(id, true); }));
  if (tab === "learn") renderLearn({ key: v.id, videos: [v] });
  else if (tab === "quiz") renderQuiz({ key: v.id, videos: [v] });
  else renderAllCards(v);
  renderSidebar();
}

function showFolder(fid) {
  const f = folderOf(fid);
  if (!f) { folderFilter = "all"; return renderEmpty(); }
  if (view !== "folder" || activeId !== fid) { session = null; quiz = null; }
  view = "folder";
  activeId = fid;
  const videos = loadVideos().filter((v) => v.folderId === fid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cards = videos.reduce((n, v) => n + v.cards.length, 0);
  const hard = videos.reduce((n, v) => n + v.cards.filter((c) => c.hard).length, 0);
  const quizCount = videos.reduce((n, v) => n + v.quiz.length, 0);
  if (!["learn", "quiz"].includes(tab)) tab = "learn";
  $("#view").innerHTML = `
    <div class="folder-head" style="--fc:${esc(f.color)}">
      <div class="folder-tab"></div>
      <div class="folder-body">
        <span class="label">Fach</span>
        <h2 class="serif">${esc(f.name)}</h2>
        <div class="meta">${videos.length} ${videos.length === 1 ? "Video" : "Videos"} · ${cards} Karten${hard ? ` · ${hard} schwer` : ""} · ${quizCount} Quizfragen</div>
        <div class="actions">
          <button class="chip" id="renameFolder">Umbenennen</button>
          <button class="chip" id="exportFolder" ${cards ? "" : "disabled"}>Für Anki/Quizlet exportieren</button>
          <button class="chip danger" id="deleteFolder">Fach löschen</button>
        </div>
      </div>
    </div>
    ${videos.length ? `
      <div class="tiles">${videos.map((v) => `
        <button class="tile" data-id="${esc(v.id)}"><img src="${thumb(v.videoId)}" alt="" loading="lazy"><b>${esc(v.title || v.videoId)}</b><small>${v.cards.length} Karten</small></button>`).join("")}
      </div>
      <div class="tabs">
        <h3 class="serif">Ganzes Fach üben</h3>
        <button class="tab ${tab === "learn" ? "on" : ""}" data-tab="learn">Lernkarten</button>
        <button class="tab ${tab === "quiz" ? "on" : ""}" data-tab="quiz">Quiz</button>
      </div>
      <div id="area"></div>`
    : `<div class="empty small"><p>Noch keine Videos in diesem Fach. Wähl oben beim Einfügen eines Links das Fach „${esc(f.name)}“ aus, oder verschieb ein vorhandenes Video hierher.</p></div>`}`;
  $$(".tile").forEach((b) => (b.onclick = () => showVideo(b.dataset.id)));
  $$(".tab").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; showFolder(fid); }));
  $("#renameFolder").onclick = () => openFolderDialog(f);
  $("#exportFolder").onclick = () => exportTsv(videos, f.name);
  $("#deleteFolder").onclick = () => {
    if (!confirm(`Fach „${f.name}“ löschen? Die Videos bleiben erhalten und landen in „Ohne Fach“.`)) return;
    saveFolders(loadFolders().filter((x) => x.id !== fid));
    saveVideos(loadVideos().map((v) => (v.folderId === fid ? { ...v, folderId: null } : v)));
    folderFilter = "all";
    toast("Fach gelöscht");
    renderEmpty();
  };
  if (videos.length) {
    if (tab === "learn") renderLearn({ key: "f:" + fid, videos });
    else renderQuiz({ key: "f:" + fid, videos });
  }
  renderSidebar();
}

// ---------- Alle Karten + Bearbeiten ----------
function renderAllCards(v) {
  $("#area").innerHTML = `
    <div class="grid">${v.cards.map((c, i) => `
      <div class="mini-wrap">
        <div class="mini" data-i="${i}"><div class="in">
          <div class="face front"><small>Karte ${i + 1}${c.hard ? ' · <em class="hardtag">schwer</em>' : ""}</small><div class="q">${esc(c.question)}</div></div>
          <div class="face back"><small>Antwort</small><div class="a">${esc(c.answer)}</div></div>
        </div></div>
        <div class="mini-tools"><button data-edit="${i}">Bearbeiten</button><button data-remove="${i}">Löschen</button></div>
      </div>`).join("")}
      <button class="add-card" id="addCard"><span>+</span>Karte hinzufügen</button>
    </div>
    <div class="below"><button class="chip" id="exportVideo">Für Anki/Quizlet exportieren</button></div>`;
  $$(".mini").forEach((el) => (el.onclick = () => el.classList.toggle("flip")));
  $$("[data-edit]").forEach((b) => (b.onclick = () => openCardDialog(v.id, Number(b.dataset.edit))));
  $$("[data-remove]").forEach((b) => (b.onclick = () => {
    if (!confirm("Diese Karte löschen?")) return;
    updateVideo(v.id, (x) => x.cards.splice(Number(b.dataset.remove), 1));
    toast("Karte gelöscht");
    showVideo(v.id, true);
  }));
  $("#addCard").onclick = () => openCardDialog(v.id, -1);
  $("#exportVideo").onclick = () => exportTsv([v], v.title);
}

// ---------- Lernmodus ----------
function startSession(scope, onlyHard) {
  const items = scope.videos.flatMap((v) => v.cards.map((c, i) => ({ vid: v.id, i, hard: !!c.hard })))
    .filter((it) => !onlyHard || it.hard);
  session = { key: scope.key, onlyHard, items, queue: shuffle(items.map((_, n) => n)), known: 0, firstTry: 0, missed: new Set(), flipped: false };
}

function renderLearn(scope) {
  const hardCount = scope.videos.reduce((n, v) => n + v.cards.filter((c) => c.hard).length, 0);
  const allCount = scope.videos.reduce((n, v) => n + v.cards.length, 0);
  if (!session || session.key !== scope.key) startSession(scope, false);
  const s = session;
  const modes = `
    <div class="modes">
      <button class="mode ${!s.onlyHard ? "on" : ""}" id="modeAll">Alle Karten (${allCount})</button>
      <button class="mode ${s.onlyHard ? "on" : ""}" id="modeHard" ${hardCount ? "" : "disabled"}>Nur schwierige (${hardCount})</button>
    </div>`;
  const total = s.items.length;
  if (!total) {
    $("#area").innerHTML = modes + `<div class="done"><span class="hand">Keine Karten hier.</span><p>Füg im Tab „Alle Karten“ welche hinzu.</p></div>`;
  } else if (!s.queue.length) {
    const pct = Math.round((s.firstTry / total) * 100);
    const praise = pct === 100 ? "Perfekt, alles gewusst!" : pct >= 70 ? "Stark, fast alles drin!" : pct >= 40 ? "Guter Anfang, nochmal?" : "Übung macht den Meister!";
    const hardLeft = scope.videos.reduce((n, v) => n + (getVideo(v.id)?.cards.filter((c) => c.hard).length || 0), 0);
    $("#area").innerHTML = modes + `
      <div class="done">
        <span class="hand">${praise}</span>
        <div class="score serif">${s.firstTry} / ${total}</div>
        <p>beim ersten Versuch gewusst${hardLeft ? ` · ${hardLeft} ${hardLeft === 1 ? "Karte ist" : "Karten sind"} noch als schwierig markiert` : ""}</p>
        <div class="grade">
          <button class="yes" id="again">Nochmal lernen</button>
          ${hardLeft ? `<button id="againHard">Nur schwierige üben</button>` : ""}
        </div>
      </div>`;
    $("#again").onclick = () => { startSession(fresh(scope), false); renderLearn(fresh(scope)); };
    $("#againHard") && ($("#againHard").onclick = () => { startSession(fresh(scope), true); renderLearn(fresh(scope)); });
  } else {
    const it = s.items[s.queue[0]];
    const v = getVideo(it.vid);
    const card = v.cards[it.i];
    $("#area").innerHTML = modes + `
      <div class="learn">
        <div class="progress"><span>${s.known} / ${total} gewusst</span><div class="bar"><span style="width:${(s.known / total) * 100}%"></span></div><span>${s.queue.length} übrig</span></div>
        <div class="big ${s.flipped ? "flip" : ""}" id="big" tabindex="0" role="button" aria-label="Karte umdrehen">
          <div class="in">
            <div class="face front"><small>${scope.videos.length > 1 ? esc(v.title) : "Frage"}${card.hard ? ' · <em class="hardtag">schwer</em>' : ""}</small><div class="q">${esc(card.question)}</div><div class="flip-hint">Klicken zum Umdrehen</div></div>
            <div class="face back"><small>Antwort</small><div class="a">${esc(card.answer)}</div><div class="flip-hint">Und, wusstest du's?</div></div>
          </div>
        </div>
        <div class="grade ${s.flipped ? "" : "wait"}">
          <button class="no" id="no">Nochmal</button>
          <button class="yes" id="yes">Gewusst</button>
        </div>
        <div class="keys"><kbd>Leertaste</kbd> umdrehen · <kbd>1</kbd> nochmal · <kbd>2</kbd> gewusst</div>
      </div>`;
    $("#big").onclick = flip;
    $("#no").onclick = () => grade(false);
    $("#yes").onclick = () => grade(true);
  }
  $("#modeAll").onclick = () => { startSession(fresh(scope), false); renderLearn(fresh(scope)); };
  $("#modeHard").onclick = () => { if (hardCount) { startSession(fresh(scope), true); renderLearn(fresh(scope)); } };
}

// Scope mit aktuellen Daten neu laden (Karten-Markierungen ändern sich beim Lernen)
function fresh(scope) {
  return { key: scope.key, videos: scope.videos.map((v) => getVideo(v.id)).filter(Boolean) };
}
function currentScope() {
  if (view === "video") return { key: activeId, videos: [getVideo(activeId)].filter(Boolean) };
  if (view === "folder") return { key: "f:" + activeId, videos: loadVideos().filter((v) => v.folderId === activeId) };
  if (view === "practice") return { key: "p:" + activeId, videos: loadVideos() };
  return null;
}

function flip() {
  if (!session || tab !== "learn" || !$("#big")) return;
  session.flipped = !session.flipped;
  $("#big").classList.toggle("flip", session.flipped);
  $(".learn .grade").classList.toggle("wait", !session.flipped);
}

function grade(knew) {
  const s = session;
  const big = $("#big");
  if (!s || !s.flipped || !s.queue.length || !big || s.busy) return;
  s.busy = true;
  const n = s.queue.shift();
  const it = s.items[n];
  const button = knew ? $("#yes") : $("#no");
  if (knew) {
    s.known++;
    const firstTry = !s.missed.has(n);
    if (firstTry) s.firstTry++;
    if (firstTry) updateVideo(it.vid, (v) => { if (v.cards[it.i]) delete v.cards[it.i].hard; });
    addProgress(XP.known, 1, button);
  } else {
    s.missed.add(n);
    s.queue.push(n);
    updateVideo(it.vid, (v) => { if (v.cards[it.i]) v.cards[it.i].hard = true; });
    addProgress(XP.again, 0, button);
  }
  s.flipped = false;
  big.classList.add(knew ? "go-right" : "go-left");
  setTimeout(() => {
    s.busy = false;
    renderLearn(fresh(currentScope()));
    $("#big")?.classList.add("enter");
    if (!s.queue.length && s.items.length && s.firstTry / s.items.length >= 0.8) confetti();
    renderSidebar();
  }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300);
}

// ---------- Quiz ----------
function startQuiz(scope) {
  const items = shuffle(scope.videos.flatMap((v) => v.quiz.map((q) => ({ vid: v.id, title: v.title, q }))))
    .slice(0, scope.videos.length > 1 ? 15 : 10)
    .map((it) => ({ ...it, order: shuffle(it.q.options.map((_, i) => i)) }));
  quiz = { key: scope.key, items, pos: 0, score: 0, picked: null };
}

function renderQuiz(scope) {
  const missing = scope.videos.filter((v) => !v.quiz.length);
  const total = scope.videos.reduce((n, v) => n + v.quiz.length, 0);
  if (!total) {
    $("#area").innerHTML = `
      <div class="done">
        <span class="hand">Noch kein Quiz da.</span>
        <p>${scope.videos.length > 1 ? `Für die Videos in diesem Fach gibt es noch keine Quizfragen.` : "Dieses Video wurde vor der Quiz-Funktion erstellt."} Die KI kann aus Zusammenfassung und Karten eins bauen.</p>
        <div class="grade"><button class="yes" id="makeQuiz">Quiz erstellen</button></div>
      </div>`;
    $("#makeQuiz").onclick = () => makeQuizzes(missing);
    return;
  }
  if (!quiz || quiz.key !== scope.key) startQuiz(scope);
  const z = quiz;
  const extra = missing.length ? `<div class="quiz-note">${missing.length} ${missing.length === 1 ? "Video hat" : "Videos haben"} noch kein Quiz. <button id="makeMissing">Jetzt erstellen</button></div>` : "";
  if (z.pos >= z.items.length) {
    const pct = Math.round((z.score / z.items.length) * 100);
    const praise = pct === 100 ? "Volle Punktzahl!" : pct >= 70 ? "Richtig gut!" : pct >= 40 ? "Da geht noch was!" : "Nochmal ran!";
    if (scope.videos.length === 1) updateVideo(scope.key, (v) => { v.quizBest = Math.max(v.quizBest || 0, pct); });
    const best = scope.videos.length === 1 ? getVideo(scope.key)?.quizBest : null;
    $("#area").innerHTML = extra + `
      <div class="done">
        <span class="hand">${praise}</span>
        <div class="score serif">${z.score} / ${z.items.length}</div>
        <p>richtig beantwortet${best != null ? ` · Bestwert: ${best} %` : ""}</p>
        <div class="grade"><button class="yes" id="quizAgain">Neues Quiz</button></div>
      </div>`;
    $("#quizAgain").onclick = () => { startQuiz(fresh(scope)); renderQuiz(fresh(scope)); };
    if (!z.celebrated) { z.celebrated = true; if (pct >= 80) confetti(); }
  } else {
    const it = z.items[z.pos];
    const answered = z.picked !== null;
    $("#area").innerHTML = extra + `
      <div class="quiz">
        <div class="progress"><span>Frage ${z.pos + 1} / ${z.items.length}</span><div class="bar"><span style="width:${(z.pos / z.items.length) * 100}%"></span></div><span>${z.score} richtig</span></div>
        <div class="qcard">
          <small>${scope.videos.length > 1 ? esc(it.title) : "Quiz"}</small>
          <div class="q serif">${esc(it.q.question)}</div>
          <div class="opts">${it.order.map((oi, k) => {
            let cls = "";
            if (answered) cls = oi === it.q.correct ? "right" : oi === z.picked ? "wrong" : "dim";
            return `<button class="opt ${cls}" data-o="${oi}" ${answered ? "disabled" : ""}><span>${"ABCD"[k]}</span>${esc(it.q.options[oi])}</button>`;
          }).join("")}</div>
          ${answered ? `<div class="explain ${z.picked === it.q.correct ? "ok" : "bad"}"><b>${z.picked === it.q.correct ? "Richtig!" : "Leider falsch."}</b> ${esc(it.q.explanation)}</div>` : ""}
        </div>
        <div class="grade">${answered ? `<button class="yes" id="next">${z.pos + 1 < z.items.length ? "Weiter" : "Ergebnis ansehen"}</button>` : ""}</div>
        <div class="keys"><kbd>A</kbd>–<kbd>D</kbd> antworten · <kbd>Enter</kbd> weiter</div>
      </div>`;
    $$(".opt").forEach((b) => (b.onclick = () => pick(Number(b.dataset.o))));
    $("#next") && ($("#next").onclick = nextQuestion);
  }
  $("#makeMissing") && ($("#makeMissing").onclick = () => makeQuizzes(missing));
}

function pick(optionIndex) {
  const z = quiz;
  if (!z || z.picked !== null || z.pos >= z.items.length) return;
  const button = $(`.opt[data-o="${optionIndex}"]`);
  z.picked = optionIndex;
  const right = optionIndex === z.items[z.pos].q.correct;
  if (right) z.score++;
  addProgress(right ? XP.quizRight : XP.quizWrong, 0, button);
  renderQuiz(currentScope());
}
function nextQuestion() {
  const z = quiz;
  if (!z || z.picked === null) return;
  z.pos++;
  z.picked = null;
  renderQuiz(currentScope());
}

async function makeQuizzes(videos) {
  const keep = { view, activeId };
  const back = () => goBack(keep);
  renderLoading(["Die KI liest deine Karten …", "Sie denkt sich knifflige Fragen aus …", "Und falsche Antworten, die gut klingen …"], videos.length > 1 ? `Für ${videos.length} Videos, das dauert etwas.` : "Dauert meist nur ein paar Sekunden.");
  let made = 0;
  try {
    for (const v of videos) {
      const q = await generateQuizFor(v);
      updateVideo(v.id, (x) => { x.quiz = q; });
      made++;
    }
    toast(made === 1 ? "Quiz erstellt" : `${made} Quizze erstellt`);
  } catch (err) {
    toast(err instanceof UserError ? err.message : "Fehler: " + err.message);
  }
  view = keep.view; activeId = keep.activeId; quiz = null; tab = "quiz";
  back();
}

// Zurück zur vorherigen Ansicht (nach Laden oder Fehlern)
function goBack(prev) {
  if (prev.view === "video" && getVideo(prev.activeId)) return showVideo(prev.activeId, true);
  if (prev.view === "folder" && folderOf(prev.activeId)) return showFolder(prev.activeId);
  if (prev.view === "practice") return showPractice(prev.activeId);
  renderHome();
}

// ---------- Tastatur ----------
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (tab === "learn" && session && $("#big")) {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    else if (e.key === "1" || e.key === "ArrowLeft") grade(false);
    else if (e.key === "2" || e.key === "ArrowRight") grade(true);
  } else if (tab === "quiz" && quiz && $(".quiz")) {
    const k = e.key.toLowerCase();
    const idx = "abcd".indexOf(k);
    if (idx >= 0 && quiz.picked === null) { const it = quiz.items[quiz.pos]; if (it && it.order[idx] !== undefined) pick(it.order[idx]); }
    else if ((e.key === "Enter" || e.key === " ") && quiz.picked !== null) { e.preventDefault(); nextQuestion(); }
  }
});

// ---------- Neues Video ----------
$("#add").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#addBtn"), st = $("#status");
  st.textContent = "";
  const videoId = extractVideoId($("#url").value);
  if (!videoId) { st.textContent = "Das sieht nicht nach einem YouTube-Link aus."; return; }
  const folderId = $("#addFolder").value || null;
  btn.disabled = true;
  const previous = { view, activeId };
  renderLoading();
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const [meta, result] = await Promise.all([fetchMeta(videoId), generateFromVideo(url)]);
    const video = {
      id: uid(),
      videoId, url, folderId,
      title: meta.title || result.title,
      channel: meta.channel || "",
      summary: result.summary,
      cards: result.cards,
      quiz: result.quiz,
      createdAt: new Date().toISOString(),
    };
    saveVideos([video, ...loadVideos().filter((v) => v.videoId !== videoId)]);
    $("#url").value = "";
    $("#search").value = "";
    toast(`${video.cards.length} Karten${video.quiz.length ? ` und ${video.quiz.length} Quizfragen` : ""} erstellt`);
    addProgress(XP.newVideo, 0, $("#addBtn"));
    showVideo(video.id);
  } catch (err) {
    st.textContent = err instanceof UserError ? err.message : "Unerwarteter Fehler: " + err.message;
    goBack(previous);
  } finally {
    btn.disabled = false;
  }
};

// ---------- Dialoge ----------
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

let editingFolder = null;
function openFolderDialog(folder) {
  editingFolder = folder || null;
  $("#folderTitle").textContent = folder ? "Fach umbenennen" : "Neues Fach";
  $("#folderName").value = folder ? folder.name : "";
  const chosen = folder ? folder.color : COLORS[loadFolders().length % COLORS.length];
  $("#folderColors").innerHTML = COLORS.map((c) => `<label><input type="radio" name="fcolor" value="${c}" ${c === chosen ? "checked" : ""}><span style="background:${c}"></span></label>`).join("");
  $("#folderDialog").showModal();
}
$("#folderCancel").onclick = () => $("#folderDialog").close();
$("#folderForm").onsubmit = () => {
  const name = $("#folderName").value.trim();
  if (!name) return;
  const color = $("#folderForm").querySelector("input[name=fcolor]:checked")?.value || COLORS[0];
  const folders = loadFolders();
  if (editingFolder) {
    const f = folders.find((x) => x.id === editingFolder.id);
    if (f) { f.name = name; f.color = color; }
    saveFolders(folders);
    toast("Fach gespeichert");
    showFolder(editingFolder.id);
  } else {
    const f = { id: uid(), name, color };
    saveFolders([...folders, f]);
    folderFilter = f.id;
    toast(`Fach „${name}“ angelegt`);
    showFolder(f.id);
  }
};

let editingCard = null;
function openCardDialog(videoId, index) {
  editingCard = { videoId, index };
  const c = index >= 0 ? getVideo(videoId).cards[index] : { question: "", answer: "" };
  $("#cardTitle").textContent = index >= 0 ? "Karte bearbeiten" : "Neue Karte";
  $("#cardQ").value = c.question;
  $("#cardA").value = c.answer;
  $("#cardDialog").showModal();
}
$("#cardCancel").onclick = () => $("#cardDialog").close();
$("#cardForm").onsubmit = () => {
  const question = $("#cardQ").value.trim(), answer = $("#cardA").value.trim();
  if (!question || !answer || !editingCard) return;
  const { videoId, index } = editingCard;
  updateVideo(videoId, (v) => {
    if (index >= 0) Object.assign(v.cards[index], { question, answer });
    else v.cards.push({ question, answer });
  });
  session = null;
  toast(index >= 0 ? "Karte gespeichert" : "Karte hinzugefügt");
  showVideo(videoId, true);
};

// ---------- Export / Sichern ----------
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileName = (s) => (s || "clipcards").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 50) || "clipcards";

// Tab-getrennt: Frage<TAB>Antwort – lässt sich in Anki und Quizlet importieren.
function exportTsv(videos, name) {
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, " ").trim();
  const lines = videos.flatMap((v) => v.cards.map((c) => `${clean(c.question)}\t${clean(c.answer)}`));
  download(`${fileName(name)}.txt`, lines.join("\n"), "text/plain;charset=utf-8");
  toast(`${lines.length} Karten exportiert`);
}

$("#exportBtn").onclick = () => {
  const data = { app: "clipcards", version: 2, folders: loadFolders(), videos: loadVideos() };
  download(`clipcards-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
  toast("Sicherung heruntergeladen");
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async () => {
  const file = $("#importFile").files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.videos;
    if (!Array.isArray(incoming)) throw new Error();
    if (!Array.isArray(data) && Array.isArray(data.folders)) {
      const byId = new Map(loadFolders().map((f) => [f.id, f]));
      for (const f of data.folders) if (f && f.id && f.name) byId.set(f.id, f);
      saveFolders([...byId.values()]);
    }
    const byVideo = new Map(loadVideos().map((v) => [v.videoId, v]));
    for (const v of incoming) if (v && v.videoId && Array.isArray(v.cards)) byVideo.set(v.videoId, v);
    saveVideos([...byVideo.values()]);
    renderSidebar();
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
applyTheme();
renderBadges();
renderHome();
$("#levelBadge").onclick = openRewards;
$("#rewardsClose").onclick = () => $("#rewardsDialog").close();

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
