// Интеграционный тест без OpenAI: поднимаем мок Realtime API и проверяем маршрутизацию.
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 4911, APP_PORT = 4912;
const upstream = []; // { path, auth, events: [] , ws }

const mock = new WebSocketServer({ port: MOCK_PORT });
mock.on("connection", (ws, req) => {
  const u = { path: req.url, auth: req.headers.authorization, events: [], ws, closed: false };
  upstream.push(u);
  let appends = 0;
  ws.on("close", () => (u.closed = true));
  ws.on("message", (raw) => {
    const ev = JSON.parse(raw.toString());
    u.events.push(ev);
    const isTranslate = req.url.startsWith("/v1/realtime/translations");
    if (ev.type.endsWith("input_audio_buffer.append")) {
      appends++;
      if (appends === 2) {
        const pcm = Buffer.alloc(4800, 1).toString("base64");
        if (isTranslate) {
          ws.send(JSON.stringify({ type: "session.input_transcript.delta", delta: "Merhaba" }));
          ws.send(JSON.stringify({ type: "session.output_audio.delta", delta: pcm }));
          ws.send(JSON.stringify({ type: "session.output_transcript.delta", delta: "Привет" }));
        } else {
          for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: "conversation.item.added", item: { id: "it" + i } }));
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Привет всем" }));
          ws.send(JSON.stringify({ type: "response.output_audio.delta", delta: pcm }));
          ws.send(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "Herkese merhaba" }));
          ws.send(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Herkese merhaba" }));
        }
      }
    }
  });
});

const app = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: APP_PORT, OPENAI_API_KEY: "sk-test", OPENAI_WS_BASE: `ws://localhost:${MOCK_PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, lang, room = "test1") {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${APP_PORT}/ws`);
    const c = { ws, name, lang, id: null, audio: [], captions: [], roster: [] };
    ws.on("message", (data, bin) => {
      if (bin) {
        const idLen = data[0];
        c.audio.push({ from: data.subarray(1, 1 + idLen).toString(), bytes: data.length - 1 - idLen });
        return;
      }
      const m = JSON.parse(data.toString());
      if (m.type === "joined") { c.id = m.id; resolve(c); }
      if (m.type === "caption") c.captions.push(m);
      if (m.type === "roster") c.roster = m.people;
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", room, name, lang })));
  });
}
const speak = async (c, n = 3) => { for (let i = 0; i < n; i++) { c.ws.send(Buffer.alloc(4800)); await sleep(30); } };

try {
  await sleep(700);
  // 1. Только русские — сессий в OpenAI быть не должно
  const ru1 = await client("Дима", "ru");
  const ru2 = await client("Аня", "ru");
  await speak(ru1, 5);
  await sleep(200);
  assert.equal(upstream.length, 0, "без слушателей другого языка OpenAI не вызывается");

  // 2. Приходит турок
  const tr1 = await client("Mehmet", "tr");
  await sleep(100);
  assert.equal(ru1.roster.length, 3);

  // турок говорит -> перевод слышат только русские
  await speak(tr1, 6); // 6*4800 = 28800 байт -> 3 чанка по 200 мс
  await sleep(400);
  const tUp = upstream.find((u) => u.path.startsWith("/v1/realtime/translations"));
  assert.ok(tUp, "открыта translate-сессия");
  assert.match(tUp.path, /model=gpt-realtime-translate/);
  assert.equal(tUp.auth, "Bearer sk-test");
  assert.equal(tUp.events[0].type, "session.update");
  assert.equal(tUp.events[0].session.audio.output.language, "ru");
  const app200 = tUp.events.filter((e) => e.type === "session.input_audio_buffer.append");
  assert.ok(app200.length >= 2);
  assert.equal(Buffer.from(app200[0].audio, "base64").length, 9600, "чанки по 200 мс");
  assert.ok(ru1.audio.some((a) => a.from === tr1.id && a.bytes === 4800), "русский слышит перевод");
  assert.ok(ru2.audio.some((a) => a.from === tr1.id), "второй русский тоже");
  assert.equal(tr1.audio.length, 0, "турок не слышит перевод себя");
  assert.ok(ru1.captions.some((c) => c.kind === "dst" && c.text === "Привет"));

  // русский говорит -> перевод слышит только турок
  await speak(ru1, 3);
  await sleep(400);
  const rUp = upstream.find((u) => u.path.startsWith("/v1/realtime?"));
  assert.ok(rUp, "открыта realtime-сессия");
  assert.match(rUp.path, /model=gpt-realtime-1\.5/);
  const su = rUp.events[0];
  assert.equal(su.type, "session.update");
  assert.equal(su.session.type, "realtime");
  assert.equal(su.session.audio.input.format.rate, 24000);
  assert.equal(su.session.audio.input.turn_detection.interrupt_response, false);
  assert.match(su.session.instructions, /Turkish/);
  assert.ok(tr1.audio.some((a) => a.from === ru1.id), "турок слышит перевод русского");
  assert.equal(ru2.audio.filter((a) => a.from === ru1.id).length, 0, "русские не слышат перевод русского");
  assert.ok(tr1.captions.some((c) => c.kind === "dst" && c.text === "Herkese merhaba"));
  assert.ok(ru2.captions.some((c) => c.kind === "src" && c.full === "Привет всем"));
  const deletes = rUp.events.filter((e) => e.type === "conversation.item.delete");
  assert.equal(deletes.length, 2, "контекст обрезается до 8 элементов");
  assert.equal(deletes[0].item_id, "it0");

  // 3. Микрофон выключен — аудио не уходит
  const before = rUp.events.length;
  ru1.ws.send(JSON.stringify({ type: "mic", on: false }));
  await sleep(50);
  await speak(ru1, 3);
  await sleep(100);
  assert.equal(rUp.events.length, before, "выключенный микрофон не отправляется");

  // 4. Турок вышел — сессии закрываются
  tr1.ws.close();
  await sleep(300);
  assert.ok(tUp.closed, "translate-сессия турка закрыта");
  assert.ok(rUp.closed, "realtime-сессия русского закрыта (некому слушать)");

  // 5. Повторный вход с другим языком
  const again = await client("Mehmet", "tr");
  await sleep(100);
  assert.equal(ru1.roster.filter((p) => p.name === "Mehmet").length, 1);
  again.ws.send(JSON.stringify({ type: "join", room: "test1", name: "Mehmet", lang: "ru" }));
  await sleep(100);
  assert.equal(ru1.roster.find((p) => p.name === "Mehmet").lang, "ru");
  assert.equal(ru1.roster.length, 3, "перезаход не создаёт дубля");

  // 6. Статика и QR
  const html = await (await fetch(`http://localhost:${APP_PORT}/r/abc123`)).text();
  assert.match(html, /Стол-переводчик/);
  const qr = await (await fetch(`http://localhost:${APP_PORT}/qr?u=https://x.y/r/abc`)).text();
  assert.match(qr, /<svg/);
  const trav = await fetch(`http://localhost:${APP_PORT}/..%2f..%2fpackage.json`);
  assert.notEqual(trav.status, 200);

  console.log("✅ все проверки пройдены");
} catch (e) {
  console.error("❌", e);
  console.error(appLog);
  process.exitCode = 1;
} finally {
  app.kill();
  mock.close();
  setTimeout(() => process.exit(), 100);
}
