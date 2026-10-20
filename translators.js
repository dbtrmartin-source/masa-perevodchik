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
  };
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
    if (s.connecting || s.closed) return;
    s.connecting = true;
    s.ready = false;
    const url = `${WS_BASE()}/v1/realtime/translations?model=${encodeURIComponent(TRANSLATE_MODEL)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${API_KEY()}` } });
    s.ws = ws;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            audio: {
              input: {
                transcription: { model: "gpt-realtime-whisper" },
                noise_reduction: { type: "near_field" },
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
          if (ev.delta) s.onAudio(Buffer.from(ev.delta, "base64"));
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
          s.log.error(`[${s.label}] OpenAI error`, ev.error || ev);
          s.onStatus("error", ev.error?.message || "OpenAI error");
          break;
      }
    });
    ws.on("close", (code, reason) => {
      s.ready = false;
      s.connecting = false;
      s.ws = null;
      if (!s.closed) s.log.info?.(`[${s.label}] closed ${code} ${reason}`);
    });
    ws.on("error", (e) => {
      s.log.error(`[${s.label}] ws error`, e.message);
      s.onStatus("error", e.message);
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
      try { s.ws?.close(); } catch {}
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
          noise_reduction: { type: "near_field" },
          transcription: { model: TRANSCRIBE_MODEL, language: "ru" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
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
    if (s.connecting || s.closed) return;
    s.connecting = true;
    s.ready = false;
    const url = `${WS_BASE()}/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${API_KEY()}` } });
    s.ws = ws;
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
          if (ev.delta) s.onAudio(Buffer.from(ev.delta, "base64"));
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
            while (items.length > 8) {
              const old = items.shift();
              ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: old }));
            }
          }
          break;
        }
        case "error":
          // удаление уже удалённого элемента — не страшно
          if (ev.error?.code === "item_delete_invalid_item_id") break;
          s.log.error(`[${s.label}] OpenAI error`, ev.error || ev);
          s.onStatus("error", ev.error?.message || "OpenAI error");
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
      s.onStatus("error", e.message);
    });
  }

  return {
    kind: "realtime",
    append(pcm) {
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
      try { s.ws?.close(); } catch {}
    },
  };
}
