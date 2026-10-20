// Мосты к OpenAI Realtime.
//  - Турецкая речь -> русский: gpt-realtime-translate (/v1/realtime/translations).
//  - Русская речь -> турецкий: gpt-realtime-* с инструкцией «синхронный переводчик»
//    (у translate-модели турецкий не поддерживается как язык вывода).
import WebSocket from "ws";

const API_KEY = () => process.env.OPENAI_API_KEY;
const WS_BASE = () => process.env.OPENAI_WS_BASE || "wss://api.openai.com";

export const TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || "gpt-realtime-translate";
export const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

// Реестр ВСЕХ соединений с OpenAI: сторож закрывает всё лишнее, ведётся учёт минут.
export const sockets = new Set(); // { ws, s, label, openedAt }
const DAY_LIMIT_MIN = Number(process.env.DAILY_LIMIT_MIN || 120);
let usedMs = 0;
let usedDay = new Date().toDateString();
export function usage() {
  const today = new Date().toDateString();
  if (today !== usedDay) { usedDay = today; usedMs = 0; }
  let live = 0;
  for (const x of sockets) live += Date.now() - x.openedAt;
  return { usedMin: (usedMs + live) / 60000, limitMin: DAY_LIMIT_MIN, open: sockets.size };
}
export function overLimit() { return usage().usedMin >= DAY_LIMIT_MIN; }
function track(s, ws) {
  const x = { ws, s, label: s.label, openedAt: Date.now() };
  sockets.add(x);
  console.log(`[openai] OPEN  ${s.label} (всего открыто: ${sockets.size})`);
  ws.once("close", () => {
    if (!sockets.delete(x)) return;
    const ms = Date.now() - x.openedAt;
    usedMs += ms;
    console.log(`[openai] CLOSE ${s.label} через ${Math.round(ms / 1000)} с (всего открыто: ${sockets.size}, за день ${usage().usedMin.toFixed(1)} мин)`);
  });
}
// Сторож: каждые 5 с жёстко рвёт соединения, у которых закрыт владелец, нет звука > 60 с или возраст > 15 мин.
setInterval(() => {
  const now = Date.now();
  for (const x of sockets) {
    const idle = now - (x.s.lastIn || x.openedAt);
    let why = "";
    if (x.s.closed) why = "владелец закрыт";
    else if (idle > 60000) why = "нет звука 60 с";
    else if (now - x.openedAt > 15 * 60000) why = "сессия > 15 мин";
    if (why) {
      console.log(`[openai] KILL  ${x.label}: ${why}`);
      x.s.closed = x.s.closed || why !== "сессия > 15 мин";
      try { x.ws.terminate(); } catch {}
      sockets.delete(x);
      usedMs += now - x.openedAt;
    }
  }
}, 5000);

const VOICES = ["marin", "cedar", "coral", "ash", "sage", "verse", "shimmer", "ballad"];

const INTERPRETER_PROMPT = `# Role
You are a professional simultaneous interpreter at a table where Russian and Turkish speakers talk to each other.

# Task
The incoming audio is a Russian speaker. For every utterance, speak ONLY its faithful Turkish translation.

# Rules
- Output Turkish only. Keep the speaker's first person ("I", "we"), tone, and register; natural spoken Turkish.
- You are not a participant. Never answer questions, never comment, never greet, never ask for clarification, never add words of your own. If the speaker asks a question, translate the question.
- Keep names, numbers, and places exact.
- If the audio is silence, noise, unintelligible, or a fragment without meaning, produce no speech at all.
- Be brief and fast: start speaking the translation immediately, without fillers or preambles.`;

function base({ label, onAudio, onCaption, onStatus, log = console }) {
  return {
    label,
    ws: null,
    ready: false,
    pending: [],
    closed: false,
    connecting: false,
    onAudio,
    onCaption,
    onStatus: onStatus || (() => {}),
    log,
    retryAt: 0, // не переподключаемся раньше этого момента
    backoff: 0,
  };
}

// Ошибка от OpenAI: пауза перед повтором (нет денег на счёте — 30 с, прочее — нарастающая 2..30 с)
function fail(s, code, message) {
  if (code === "daily_limit") { s.retryAt = Date.now() + 60000; s.pending.length = 0; return s.onStatus("error", message, "daily_limit"); }
  const quota = /quota|credit|billing/i.test(String(code) + " " + String(message));
  s.backoff = quota ? 30000 : Math.min(30000, s.backoff ? s.backoff * 2 : 2000);
  s.retryAt = Date.now() + s.backoff;
  s.pending.length = 0;
  s.onStatus("error", message, quota ? "no_credits" : code || "openai_error");
}

function textOf(ev) {
  if (typeof ev.delta === "string") return ev.delta;
  if (typeof ev.transcript === "string") return ev.transcript;
  if (typeof ev.text === "string") return ev.text;
  return "";
}

// ---------------------------------------------------------------- TR -> RU
export function createTurkishToRussian(opts) {
  const s = base(opts);
  let chunk = [];
  let chunkBytes = 0;
  const CHUNK = 9600; // 200 мс PCM16 @ 24 кГц

  function connect() {
    if (s.connecting || s.closed || Date.now() < s.retryAt) return;
    s.connecting = true;
    s.ready = false;
    const url = `${WS_BASE()}/v1/realtime/translations?model=${encodeURIComponent(TRANSLATE_MODEL)}`;
    if (overLimit()) { fail(s, "daily_limit", "daily limit"); s.connecting = false; return; }
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${API_KEY()}` } });
    s.ws = ws;
    track(s, ws);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            audio: {
              input: {
                transcription: { model: "gpt-realtime-whisper" },
                noise_reduction: { type: opts.far ? "far_field" : "near_field" },
              },
              output: { language: "ru" },
            },
          },
        }),
      );
      s.ready = true;
      s.connecting = false;
      s.onStatus("ok");
      while (s.pending.length) ws.send(s.pending.shift());
    });
    ws.on("message", (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case "session.output_audio.delta":
          if (ev.delta) { s.backoff = 0; s.onAudio(Buffer.from(ev.delta, "base64")); }
          break;
        case "session.output_transcript.delta":
          s.onCaption("dst", textOf(ev), false);
          break;
        case "session.output_transcript.done":
        case "session.output_transcript.completed":
          s.onCaption("dst", "", true);
          break;
        case "session.input_transcript.delta":
          s.onCaption("src", textOf(ev), false);
          break;
        case "session.input_transcript.done":
        case "session.input_transcript.completed":
          s.onCaption("src", "", true);
          break;
        case "error":
          s.log.error(`[${s.label}] OpenAI error`, ev.error?.code, ev.error?.message);
          fail(s, ev.error?.code || ev.error?.type, ev.error?.message || "OpenAI error");
          break;
      }
    });
    ws.on("close", (code, reason) => {
      s.ready = false;
      s.connecting = false;
      s.ws = null;
      if (!s.closed && code !== 1000 && code !== 1005 && Date.now() >= s.retryAt) fail(s, String(reason), String(reason));
      if (!s.closed) s.log.info?.(`[${s.label}] closed ${code} ${reason}`);
    });
    ws.on("error", (e) => {
      s.log.error(`[${s.label}] ws error`, e.message);
      fail(s, /401/.test(e.message) ? "bad_key" : "network", e.message);
    });
  }

  function sendEvent(obj) {
    const payload = JSON.stringify(obj);
    if (s.ready && s.ws?.readyState === WebSocket.OPEN) s.ws.send(payload);
    else {
      s.pending.push(payload);
      if (s.pending.length > 50) s.pending.shift(); // не копим больше ~10 с
      connect();
    }
  }

  return {
    kind: "translate",
    append(pcm) {
      s.lastIn = Date.now();
      chunk.push(pcm);
      chunkBytes += pcm.length;
      if (chunkBytes >= CHUNK) {
        const buf = Buffer.concat(chunk);
        chunk = [];
        chunkBytes = 0;
        sendEvent({ type: "session.input_audio_buffer.append", audio: buf.toString("base64") });
      }
    },
    close() {
      s.closed = true;
      try { s.ws?.terminate(); } catch {}
    },
  };
}

// ---------------------------------------------------------------- RU -> TR
export function createRussianToTurkish(opts) {
  const s = base(opts);
  const voice = VOICES[(opts.voiceIndex || 0) % VOICES.length];
  const items = [];

  function sessionUpdate() {
    const session = {
      type: "realtime",
      model: REALTIME_MODEL,
      output_modalities: ["audio"],
      instructions: INTERPRETER_PROMPT,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          noise_reduction: { type: opts.far ? "far_field" : "near_field" },
          transcription: { model: TRANSCRIBE_MODEL, language: "ru" },
          turn_detection: {
            type: "server_vad",
            threshold: opts.far ? 0.3 : 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 450),
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice },
      },
    };
    if (/realtime-2/.test(REALTIME_MODEL)) session.reasoning = { effort: "low" };
    return { type: "session.update", session };
  }

  function connect() {
    if (s.connecting || s.closed || Date.now() < s.retryAt) return;
    s.connecting = true;
    s.ready = false;
    const url = `${WS_BASE()}/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    if (overLimit()) { fail(s, "daily_limit", "daily limit"); s.connecting = false; return; }
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${API_KEY()}` } });
    s.ws = ws;
    track(s, ws);
    ws.on("open", () => {
      ws.send(JSON.stringify(sessionUpdate()));
      s.ready = true;
      s.connecting = false;
      s.onStatus("ok");
      while (s.pending.length) ws.send(s.pending.shift());
    });
    ws.on("message", (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (ev.delta) { s.backoff = 0; s.onAudio(Buffer.from(ev.delta, "base64")); }
          break;
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
          s.onCaption("dst", textOf(ev), false);
          break;
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
          s.onCaption("dst", "", true);
          break;
        case "conversation.item.input_audio_transcription.delta":
          s.onCaption("src", textOf(ev), false);
          break;
        case "conversation.item.input_audio_transcription.completed":
          // если дельт не было — шлём целиком
          s.onCaption("src", "", true, textOf(ev));
          break;
        case "conversation.item.added":
        case "conversation.item.created": {
          const id = ev.item?.id;
          if (id && !items.includes(id)) {
            items.push(id);
            // держим короткий контекст: дешевле и модель не «уплывает» в диалог
            while (items.length > 4) { // 2 последние фразы: контекст + дешёвый ввод
              const old = items.shift();
              ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: old }));
            }
          }
          break;
        }
        case "error":
          // удаление уже удалённого элемента — не страшно
          if (ev.error?.code === "item_delete_invalid_item_id" || ev.error?.code === "conversation_already_has_active_response") break;
          s.log.error(`[${s.label}] OpenAI error`, ev.error?.code, ev.error?.message);
          fail(s, ev.error?.code || ev.error?.type, ev.error?.message || "OpenAI error");
          break;
      }
    });
    ws.on("close", (code, reason) => {
      s.ready = false;
      s.connecting = false;
      s.ws = null;
      items.length = 0;
      if (!s.closed) s.log.info?.(`[${s.label}] closed ${code} ${reason}`);
    });
    ws.on("error", (e) => {
      s.log.error(`[${s.label}] ws error`, e.message);
      fail(s, /401/.test(e.message) ? "bad_key" : "network", e.message);
    });
  }

  return {
    kind: "realtime",
    append(pcm) {
      s.lastIn = Date.now();
      const payload = JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
      if (s.ready && s.ws?.readyState === WebSocket.OPEN) s.ws.send(payload);
      else {
        s.pending.push(payload);
        if (s.pending.length > 100) s.pending.shift();
        connect();
      }
    },
    close() {
      s.closed = true;
      try { s.ws?.terminate(); } catch {}
    },
  };
}
