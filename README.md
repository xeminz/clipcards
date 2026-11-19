# ClipCards

**YouTube-Video rein, Zusammenfassung und Lernkarten raus.**

👉 **Website:** https://xeminz.github.io/clipcards/
👉 **App direkt im Browser:** https://xeminz.github.io/clipcards/app/

ClipCards lässt Google Gemini ein YouTube-Video ansehen und macht daraus eine kurze Zusammenfassung und 5–10 Lernkarten, immer auf Deutsch. Alles läuft im Browser: Es gibt keine Anmeldung und keinen Server, und deine Karten bleiben auf deinem Gerät.

## Funktionen

- YouTube-Link einfügen (normale Links, `youtu.be`, Shorts)
- KI schaut sich das Video direkt an, Untertitel sind nicht nötig
- Zusammenfassung + 5–10 Lernkarten auf Deutsch, auch bei englischen Videos
- Karten zum Umdrehen, mit Mischen-Funktion
- Gespeicherte Videos durchsuchen (Titel, Zusammenfassung, Karten)
- Sichern und Wiederherstellen als JSON-Datei
- Als App installierbar (PWA) auf Windows, Mac, Linux, Android und iPhone, startet auch offline

## Nutzung

1. [App öffnen](https://xeminz.github.io/clipcards/app/)
2. Beim ersten Start einen **kostenlosen** Gemini-API-Key eintragen ([hier erstellen](https://aistudio.google.com/apikey))
3. YouTube-Link einfügen und auf „Los“ klicken

Der Key wird nur im eigenen Browser gespeichert und geht ausschließlich an Google.

## Installieren

Auf der [Website](https://xeminz.github.io/clipcards/) auf **„App laden“** klicken. Alternativ:

- **Chrome / Edge (Windows, Mac, Linux, Android):** Installieren-Symbol in der Adressleiste
- **iPhone / iPad:** in Safari „Teilen“ → „Zum Home-Bildschirm“

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Website mit Download-Bereich |
| `app/index.html`, `app/app.js` | Die App: Gemini-Aufruf, Speicher im Browser, Lernkarten |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installierbare App (PWA) und Offline-Start |
| `dev-server.mjs` | Lokale Vorschau ohne Abhängigkeiten |

Reines HTML/CSS/JavaScript ohne Build-Schritt und ohne Abhängigkeiten. Gehostet über GitHub Pages.

## Lokal ausprobieren

```bash
node dev-server.mjs
```

Danach http://localhost:5173/clipcards/ öffnen.

## Hinweise

- Das Video muss öffentlich sein.
- Das Gratis-Kontingent von Gemini ist pro Tag begrenzt. Sehr lange Videos (über ca. 30 Minuten) können es sprengen.
- Die Karten liegen im Browser-Speicher. Mit „Sichern“ kannst du sie als Datei exportieren und auf einem anderen Gerät wiederherstellen.
