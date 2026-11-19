# ClipCards

**YouTube-Video rein, Zusammenfassung und Lernkarten raus.**

ClipCards holt das Transkript eines YouTube-Videos, lässt von Google Gemini eine kurze Zusammenfassung und 5–10 Lernkarten erstellen und speichert alles lokal. So kannst du deine Videos samt Karten später durchsuchen und wiederholen.

## Funktionen

- YouTube-Link einfügen (normale Links, `youtu.be`, Shorts)
- Transkript wird automatisch geladen (bevorzugt Deutsch, sonst Englisch)
- KI erstellt eine Zusammenfassung und 5–10 Lernkarten, immer auf Deutsch
- Karten zum Umdrehen per Klick, mit Mischen-Funktion
- Alle Videos werden gespeichert und sind durchsuchbar (Titel, Kanal, Zusammenfassung, Transkript, Karten)
- Heller und dunkler Modus

## Voraussetzungen

- [Node.js](https://nodejs.org) ab Version 22.9
- Ein kostenloser Gemini-API-Key von [Google AI Studio](https://aistudio.google.com/apikey)

## Installation

```bash
git clone https://github.com/xeminz/clipcards.git
cd clipcards
npm install
```

Lege eine Datei `.env` an (Vorlage: `.env.example`) und trage deinen Key ein:

```
GEMINI_API_KEY=dein-key
```

## Starten

```bash
npm start
```

Danach im Browser öffnen: http://localhost:3000

## Aufbau

| Datei | Inhalt |
|---|---|
| `server.js` | Node-Server: Transkript holen, Gemini aufrufen, in SQLite speichern |
| `public/index.html` | Oberfläche: Eingabe, Liste, Suche, Lernkarten |
| `clipcards.db` | Deine gespeicherten Videos und Karten (wird automatisch angelegt, nicht im Repo) |

Technik: Node.js mit eingebautem `node:sqlite`, [`@google/genai`](https://www.npmjs.com/package/@google/genai), [`youtube-transcript`](https://www.npmjs.com/package/youtube-transcript) und [`zod`](https://zod.dev).

## Hinweise

- Es funktioniert nur bei Videos mit Untertiteln (automatisch erzeugte reichen).
- Das Gratis-Kontingent von Gemini ist pro Tag begrenzt. Ist es erreicht, zeigt die App eine Meldung an.
- Das Modell kann über `GEMINI_MODEL` in der `.env` geändert werden.
- Die `.env`-Datei mit deinem Key wird nie ins Repo hochgeladen (steht in `.gitignore`).
