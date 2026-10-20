// Сервер «Стол-переводчик»: комнаты по ссылке, ретрансляция речи в OpenAI и раздача перевода.
import "./env.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { createTurkishToRussian, createRussianToTurkish } from "./translators.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 30); // защита ключа от перерасхода
const LANGS = new Set(["ru", "tr"]);

if (!process.env.OPENAI_API_KEY) console.warn("⚠️  OPENAI_API_KEY не задан — перевод работать не будет.");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");
  if (url.pathname === "/qr") {
    const u = url.searchParams.get("u") || "";
    if (u.length > 300) return send(res, 400, "too long", "text/plain");
    const svg = await QRCode.toString(u, { type: "svg", margin: 1, width: 240 });
    return send(res, 200, svg, "image/svg+xml");
  }
  let p = url.pathname;
  if (p === "/" || p.startsWith("/r/")) p = "/index.html";
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "no", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
});

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

// ------------------------------------------------------------------ комнаты
/** rooms: id -> Map<participantId, Participant> */
const rooms = new Map();
let activeSessions = 0;
let voiceCounter = 0;

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1 << 20 });

wss.on("connection", (ws) => {
  const p = { id: randomBytes(4).toString("hex"), ws, room: null, name: "", lang: "", mic: true, translator: null, voice: voiceCounter++ };
  p.idBuf = Buffer.from(p.id);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return onAudio(p, data);
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "join") return join(p, msg);
    if (msg.type === "leave") return leave(p);
    if (msg.type === "mic") { p.mic = !!msg.on; broadcastRoster(p.room); }
    if (msg.type === "ping") json(ws, { type: "pong" });
  });
  ws.on("close", () => leave(p));
  ws.on("error", () => {});
});

function join(p, msg) {
  const room = String(msg.room || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  const name = String(msg.name || "").trim().slice(0, 32);
  const lang = String(msg.lang || "");
  if (!room || !name || !LANGS.has(lang)) return json(p.ws, { type: "error", message: "bad_join" });
  leave(p);
  p.room = room;
  p.name = name;
  p.lang = lang;
  p.mic = true;
  if (!rooms.has(room)) rooms.set(room, new Map());
  rooms.get(room).set(p.id, p);
  json(p.ws, { type: "joined", id: p.id, room });
  broadcastRoster(room);
  log(`join ${room} ${name} (${lang})`);
}

function leave(p) {
  if (!p.room) return;
  const room = p.room;
  stopTranslator(p);
  const members = rooms.get(room);
  members?.delete(p.id);
  p.room = null;
  if (members && members.size === 0) rooms.delete(room);
  else broadcastRoster(room);
  log(`leave ${room} ${p.name}`);
}

function hasListeners(p) {
  const members = rooms.get(p.room);
  if (!members) return false;
  for (const q of members.values()) if (q.lang !== p.lang && q.ws.readyState === 1) return true;
  return false;
}

function onAudio(p, data) {
  if (!p.room || !p.mic) return;
  if (!hasListeners(p)) return stopTranslator(p); // слушать некому — не тратим деньги
  if (!p.translator) {
    if (activeSessions >= MAX_SESSIONS) return;
    startTranslator(p);
  }
  p.translator.append(Buffer.from(data));
}

function startTranslator(p) {
  activeSessions++;
  const opts = {
    label: `${p.room}/${p.name}`,
    voiceIndex: p.voice,
    onAudio: (pcm) => relayAudio(p, pcm),
    onCaption: (kind, text, final, full) => relayCaption(p, kind, text, final, full),
    onStatus: (state, message) => { if (state === "error") json(p.ws, { type: "warn", message }); },
    log: console,
  };
  p.translator = p.lang === "tr" ? createTurkishToRussian(opts) : createRussianToTurkish(opts);
}

function stopTranslator(p) {
  if (!p.translator) return;
  p.translator.close();
  p.translator = null;
  activeSessions--;
}

function relayAudio(p, pcm) {
  const members = rooms.get(p.room);
  if (!members) return;
  const header = Buffer.from([p.idBuf.length]);
  const frame = Buffer.concat([header, p.idBuf, pcm]);
  for (const q of members.values()) {
    if (q.lang !== p.lang && q.ws.readyState === 1) q.ws.send(frame, { binary: true });
  }
}

function relayCaption(p, kind, text, final, full) {
  const members = rooms.get(p.room);
  if (!members) return;
  const msg = { type: "caption", from: p.id, name: p.name, lang: p.lang, kind, text, final: !!final };
  if (full) msg.full = full;
  for (const q of members.values()) json(q.ws, msg);
}

function broadcastRoster(room) {
  const members = rooms.get(room);
  if (!members) return;
  const people = [...members.values()].map((q) => ({ id: q.id, name: q.name, lang: q.lang, mic: q.mic }));
  for (const q of members.values()) json(q.ws, { type: "roster", people });
  // кто-то ушёл — закрываем лишние сессии
  for (const q of members.values()) if (q.translator && !hasListeners(q)) stopTranslator(q);
}

function json(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

// heartbeat, чтобы прокси (Render и пр.) не рвали неактивные сокеты
setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping();
}, 25000);

server.listen(PORT, () => log(`Стол-переводчик: http://localhost:${PORT}`));

export { server, rooms };
