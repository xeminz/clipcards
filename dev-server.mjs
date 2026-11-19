// Lokale Vorschau: node dev-server.mjs  →  http://localhost:5173/clipcards/
// Bedient den Ordner unter /clipcards/, genau wie GitHub Pages.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") { res.writeHead(302, { Location: "/clipcards/" }); return res.end(); }
  if (!p.startsWith("/clipcards/")) { res.writeHead(404); return res.end(); }
  let file = path.resolve(root, "." + p.slice("/clipcards".length));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`ClipCards-Vorschau: http://localhost:${port}/clipcards/`));
