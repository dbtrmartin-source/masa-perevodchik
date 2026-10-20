"use strict";
// Клиент «Стол-переводчик»
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  const T = {
    ru: {
      table: "Стол", invite: "Пригласить", copy: "Копировать", copied: "Скопировано",
      sens: "Чувствительность микрофона", sensHint: "Меньше — не ловит соседей. Больше — ловит тихую речь.",
      vol: "Громкость перевода", nohp: "Я без наушников (микрофон выключается, пока звучит перевод)",
      test: "Проверить звук", far: "Режим теста: ловить звук с колонки / ноутбука рядом (выключает фильтры шума)",
      farOn: "Режим теста включён: микрофон ловит всё вокруг, включая соседей.", empty: "Говорите — перевод появится здесь и в наушниках.",
      leave: "Выйти", micOn: "Микрофон вкл.", micOff: "Микрофон выкл.",
      you: "вы", online: "на связи", reconnecting: "переподключение…",
      alone: "Пока за столом нет собеседников на турецком. Отправьте им ссылку.",
      hidden: "Страница была свёрнута — звук мог прерваться. Держите экран включённым.",
      micDenied: "Нет доступа к микрофону. Разрешите его в настройках браузера.",
      said: "сказал(а)",
      wait: "Подождите — сейчас говорит ",
      noCredits: "Перевод остановлен: на счёте OpenAI закончились деньги. Пополните баланс на platform.openai.com → Billing.",
      badKey: "Перевод не работает: неверный ключ OpenAI (проверьте OPENAI_API_KEY в Render).",
      netErr: "Нет связи с OpenAI, пробую снова…",
      dayLimit: "Достигнут дневной лимит минут перевода. Его можно увеличить в настройках сервера (DAILY_LIMIT_MIN).",
    },
    tr: {
      table: "Masa", invite: "Davet et", copy: "Kopyala", copied: "Kopyalandı",
      sens: "Mikrofon hassasiyeti", sensHint: "Düşük — yan masadakileri almaz. Yüksek — kısık sesi de alır.",
      vol: "Çeviri ses seviyesi", nohp: "Kulaklığım yok (çeviri çalarken mikrofon kapanır)",
      test: "Sesi test et", far: "Test modu: yakındaki hoparlör / dizüstü bilgisayar sesini al (gürültü filtrelerini kapatır)",
      farOn: "Test modu açık: mikrofon etraftaki her sesi alır.", empty: "Konuşun — çeviri burada ve kulaklıkta görünecek.",
      leave: "Çık", micOn: "Mikrofon açık", micOff: "Mikrofon kapalı",
      you: "siz", online: "bağlı", reconnecting: "yeniden bağlanıyor…",
      alone: "Masada henüz Rusça konuşan yok. Onlara bağlantıyı gönderin.",
      hidden: "Sayfa arka plana alındı — ses kesilmiş olabilir. Ekranı açık tutun.",
      micDenied: "Mikrofona erişim yok. Tarayıcı ayarlarından izin verin.",
      said: "dedi",
      wait: "Lütfen bekleyin — şu anda konuşuyor: ",
      noCredits: "Çeviri durdu: OpenAI hesabında bakiye bitti. platform.openai.com → Billing üzerinden yükleyin.",
      badKey: "Çeviri çalışmıyor: OpenAI anahtarı geçersiz.",
      netErr: "OpenAI bağlantısı yok, yeniden deneniyor…",
      dayLimit: "Günlük çeviri dakika limiti doldu.",
    },
  };

  const state = {
    room: null, name: store.get("name") || "", lang: store.get("lang") || "",
    me: null, people: [], ws: null, wantOnline: false, micOn: true,
    ctx: null, capture: null, playback: null, stream: null, wakeLock: null,
    playing: false, noHeadphones: store.get("nohp") === "1", far: false,
    talkingUntil: new Map(), bubbles: new Map(), retry: 0,
  };
  const t = (k) => (T[state.lang] || T.ru)[k] || k;

  // ---------------------------------------------------------------- роутинг
  const m = location.pathname.match(/^\/r\/([a-z0-9-]{3,32})/i);
  if (!m) show("v-home");
  else { state.room = m[1].toLowerCase(); showJoin(); }

  function show(id) {
    for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
  }

  $("btn-create").onclick = () => {
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    let id = "";
    const rnd = crypto.getRandomValues(new Uint8Array(6));
    for (const b of rnd) id += abc[b % abc.length];
    location.href = `/r/${id}`;
  };

  // ---------------------------------------------------------------- вход
  function showJoin() {
    show("v-join");
    $("in-name").value = state.name;
    selectLang(state.lang);
    validate();
  }
  function selectLang(l) {
    state.lang = l;
    for (const b of document.querySelectorAll(".lang")) b.classList.toggle("sel", b.dataset.lang === l);
    validate();
  }
  function validate() {
    $("btn-join").disabled = !($("in-name").value.trim() && (state.lang === "ru" || state.lang === "tr"));
  }
  for (const b of document.querySelectorAll(".lang")) b.onclick = () => selectLang(b.dataset.lang);
  $("in-name").oninput = validate;
  $("in-name").onkeydown = (e) => { if (e.key === "Enter" && !$("btn-join").disabled) $("btn-join").click(); };

  $("btn-join").onclick = async () => {
    state.name = $("in-name").value.trim();
    store.set("name", state.name);
    store.set("lang", state.lang);
    $("join-err").hidden = true;
    $("btn-join").disabled = true;
    try {
      await startAudio();
    } catch (e) {
      console.error(e);
      $("join-err").textContent = (T[state.lang] || T.ru).micDenied + (e && e.name ? ` (${e.name})` : "");
      $("join-err").hidden = false;
      $("btn-join").disabled = false;
      return;
    }
    enterRoom();
  };

  // ---------------------------------------------------------------- аудио
  async function startAudio() {
    if (!state.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.ctx = new AC({ latencyHint: "interactive" });
    }
    const ctx = state.ctx;
    await ctx.resume();
    if (!state.playback) {
      await ctx.audioWorklet.addModule("/capture-worklet.js");
      await ctx.audioWorklet.addModule("/playback-worklet.js");
      state.playback = new AudioWorkletNode(ctx, "playback", { numberOfInputs: 0, outputChannelCount: [2] });
      state.playback.connect(ctx.destination);
      state.playback.port.onmessage = (e) => {
        if ("playing" in e.data) { state.playing = e.data.playing; applyMute(); }
      };
    }
    if (!state.stream) {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: state.far
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const src = ctx.createMediaStreamSource(state.stream);
      state.source = src;
      state.capture = new AudioWorkletNode(ctx, "capture", { numberOfOutputs: 1, outputChannelCount: [1] });
      src.connect(state.capture);
      // Safari обрабатывает узел, только если он подключён к выходу — подключаем через «немой» gain
      const sink = ctx.createGain();
      sink.gain.value = 0;
      state.capture.connect(sink).connect(ctx.destination);
      state.capture.port.onmessage = (e) => {
        if (e.data.pcm) {
          const ws = state.ws;
          if (ws && ws.readyState === 1 && state.me && ws.bufferedAmount < 256 * 1024) ws.send(e.data.pcm);
        } else if ("level" in e.data) meter(e.data.level, e.data.open);
      };
    }
    applySettings();
    keepAwake();
  }

  function applySettings() {
    const sens = Number($("in-sens").value); // 1..100
    // 100 -> порог 0.003 (очень чувствительно), 1 -> 0.12
    let threshold = 0.12 * Math.pow(0.003 / 0.12, (sens - 1) / 99);
    if (state.far) threshold = Math.min(threshold, 0.004);
    state.capture && state.capture.port.postMessage({ threshold });
    state.playback && state.playback.port.postMessage({ gain: Number($("in-vol").value) / 100 });
    store.set("sens", $("in-sens").value);
    store.set("vol", $("in-vol").value);
  }
  $("in-sens").value = store.get("sens") || 60;
  $("in-vol").value = store.get("vol") || 100;
  $("in-nohp").checked = state.noHeadphones;
  $("in-far").onchange = async () => {
    state.far = $("in-far").checked;
    // перезапускаем микрофон с другими фильтрами браузера
    if (state.stream) {
      state.stream.getTracks().forEach((tr) => tr.stop());
      try { state.source.disconnect(); state.capture.disconnect(); } catch {}
      state.stream = null;
      state.capture = null;
      try { await startAudio(); applyMute(); } catch { showWarn(t("micDenied")); }
    }
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "far", on: state.far }));
    if (state.far) showWarn(t("farOn"), 6000);
  };
  $("in-sens").oninput = applySettings;
  $("in-vol").oninput = applySettings;
  $("in-nohp").onchange = () => {
    state.noHeadphones = $("in-nohp").checked;
    store.set("nohp", state.noHeadphones ? "1" : "0");
    applyMute();
  };

  let unmuteTimer = null;
  function applyMute() {
    if (!state.capture) return;
    let muted = !state.micOn;
    if (state.noHeadphones && state.playing) muted = true;
    if (!muted && state.noHeadphones && !state.playing) {
      // небольшая пауза после перевода, чтобы хвост не попал в микрофон
      clearTimeout(unmuteTimer);
      unmuteTimer = setTimeout(() => state.capture.port.postMessage({ muted: !state.micOn }), 350);
      return;
    }
    clearTimeout(unmuteTimer);
    state.capture.port.postMessage({ muted });
  }

  function meter(level, open) {
    const ring = $("mic-ring");
    if (!ring) return;
    const v = Math.min(1, level * 8);
    ring.style.opacity = open ? String(0.35 + v * 0.65) : "0";
    ring.style.transform = `scale(${1 + (open ? v * 0.12 : 0)})`;
  }

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request("screen");
        state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
      }
    } catch {}
  }

  $("btn-test").onclick = () => {
    // короткий тон 440 Гц, чтобы проверить, что звук идёт в наушники
    const n = 24000 * 0.4;
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000 * Math.min(1, (n - i) / 2400);
    state.playback && state.playback.port.postMessage({ id: "test", pcm: pcm.buffer }, [pcm.buffer]);
  };

  // ---------------------------------------------------------------- комната
  function enterRoom() {
    show("v-room");
    document.documentElement.lang = state.lang;
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
    $("room-code").textContent = state.room.toUpperCase();
    const link = `${location.origin}/r/${state.room}`;
    $("share-link").value = link;
    $("qr").src = `/qr?u=${encodeURIComponent(link)}`;
    state.micOn = true;
    updateMicBtn();
    state.wantOnline = true;
    connect();
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    setStatus(t("reconnecting"));
    ws.onopen = () => {
      state.retry = 0;
      ws.send(JSON.stringify({ type: "join", room: state.room, name: state.name, lang: state.lang, far: state.far }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return onAudioFrame(e.data);
      const msg = JSON.parse(e.data);
      if (msg.type === "joined") {
        state.me = msg.id;
        setStatus(t("online"));
        if (!state.micOn) ws.send(JSON.stringify({ type: "mic", on: false }));
      } else if (msg.type === "roster") {
        state.people = msg.people;
        renderPeople();
      } else if (msg.type === "caption") onCaption(msg);
      else if (msg.type === "floor") { state.floor = msg.id; renderTalking(); }
      else if (msg.type === "busy") showWarn(t("wait") + msg.name, 2500);
      else if (msg.type === "warn") {
        const known = { no_credits: "noCredits", bad_key: "badKey", network: "netErr", daily_limit: "dayLimit" }[msg.code];
        showWarn(known ? t(known) : "OpenAI: " + msg.message, 12000);
      }
      else if (msg.type === "error") showWarn(msg.message, 5000);
    };
    ws.onclose = () => {
      state.me = null;
      if (state.ws === ws) state.ws = null;
      if (!state.wantOnline) return;
      setStatus(t("reconnecting"));
      const delay = Math.min(8000, 500 * Math.pow(2, state.retry++));
      setTimeout(() => state.wantOnline && !state.ws && connect(), delay);
    };
  }

  setInterval(() => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "ping" }));
  }, 20000);

  function onAudioFrame(buf) {
    const u8 = new Uint8Array(buf);
    const idLen = u8[0];
    const id = new TextDecoder().decode(u8.subarray(1, 1 + idLen));
    const pcm = buf.slice(1 + idLen); // копия — выравнивание для Int16Array
    if (pcm.byteLength % 2) return;
    state.playback && state.playback.port.postMessage({ id, pcm }, [pcm]);
    state.talkingUntil.set(id, performance.now() + 800);
    renderTalking();
  }

  function renderPeople() {
    const box = $("people");
    box.innerHTML = "";
    for (const p of state.people) {
      const el = document.createElement("span");
      el.className = "person" + (p.id === state.me ? " me" : "") + (p.mic ? "" : " off");
      el.dataset.id = p.id;
      const tag = document.createElement("span");
      tag.className = `tag ${p.lang}`;
      tag.textContent = p.lang.toUpperCase();
      el.append(tag, document.createTextNode(p.name + (p.id === state.me ? ` (${t("you")})` : "")));
      box.append(el);
    }
    const others = state.people.filter((p) => p.lang !== state.lang).length;
    if (!others) showWarn(t("alone"));
    else if ($("warn").dataset.kind === "alone") hideWarn();
  }

  function renderTalking() {
    const now = performance.now();
    for (const el of document.querySelectorAll(".person")) {
      el.classList.toggle("talking", el.dataset.id === state.floor || (state.talkingUntil.get(el.dataset.id) || 0) > now);
    }
  }
  setInterval(renderTalking, 300);

  // ---------------------------------------------------------------- субтитры
  // Каждый видит текст на своём языке: перевод чужой речи и оригинал речи «своих».
  function onCaption(c) {
    const sameLang = c.lang === state.lang;
    if (sameLang && c.kind !== "src") return;
    if (!sameLang && c.kind !== "dst") return;
    const key = `${c.from}:${c.kind}`;
    const now = performance.now();
    let b = state.bubbles.get(key);
    if (!b || b.closed || now - b.at > 3000) {
      if (!c.text && !c.full) return;
      b = createBubble(c, sameLang);
      state.bubbles.set(key, b);
    }
    if (c.text) b.txt.textContent += c.text;
    if (c.full && !b.txt.textContent.trim()) b.txt.textContent = c.full;
    b.at = now;
    if (c.final) b.closed = true;
    if (!b.txt.textContent.trim() && b.closed) b.el.remove();
    scrollFeed();
  }

  function createBubble(c, sameLang) {
    $("feed-empty") && $("feed-empty").remove();
    const el = document.createElement("div");
    el.className = "msg " + (c.from === state.me ? "mine" : sameLang ? "same" : "other");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = c.from === state.me ? t("you") : c.name;
    const txt = document.createElement("div");
    txt.className = "txt";
    el.append(who, txt);
    $("feed").append(el);
    const feed = $("feed");
    while (feed.children.length > 80) feed.firstChild.remove();
    return { el, txt, at: performance.now(), closed: false };
  }

  function scrollFeed() {
    const f = $("feed");
    f.scrollTop = f.scrollHeight;
  }

  // ---------------------------------------------------------------- кнопки
  $("btn-mic").onclick = () => {
    state.micOn = !state.micOn;
    updateMicBtn();
    applyMute();
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "mic", on: state.micOn }));
  };
  function updateMicBtn() {
    $("btn-mic").className = "mic " + (state.micOn ? "on" : "off");
    $("mic-label").textContent = t(state.micOn ? "micOn" : "micOff");
  }

  $("btn-leave").onclick = () => {
    state.wantOnline = false;
    if (state.ws) { try { state.ws.send(JSON.stringify({ type: "leave" })); } catch {} state.ws.close(); }
    state.ws = null;
    state.me = null;
    state.playback && state.playback.port.postMessage({ flush: true });
    if (state.stream) { state.stream.getTracks().forEach((tr) => tr.stop()); state.stream = null; state.capture = null; }
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    $("feed").innerHTML = "";
    state.bubbles.clear();
    showJoin();
  };

  $("btn-share").onclick = async () => {
    const link = $("share-link").value;
    if (navigator.share) {
      try { await navigator.share({ title: "RU ⇄ TR", url: link }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    $("share-panel").hidden = !$("share-panel").hidden;
    $("settings-panel").hidden = true;
  };
  // долгий тап / второй клик — показать QR, чтобы отсканировать за столом
  $("room-code").onclick = () => { $("share-panel").hidden = !$("share-panel").hidden; $("settings-panel").hidden = true; };
  $("btn-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("share-link").value); } catch { $("share-link").select(); document.execCommand("copy"); }
    $("btn-copy").textContent = t("copied");
    setTimeout(() => ($("btn-copy").textContent = t("copy")), 1500);
  };
  $("btn-settings").onclick = () => { $("settings-panel").hidden = !$("settings-panel").hidden; $("share-panel").hidden = true; };

  // ---------------------------------------------------------------- служебное
  function setStatus(s) { $("status").textContent = s; }
  let warnTimer = null;
  function showWarn(text, ms) {
    const w = $("warn");
    w.textContent = text;
    w.hidden = false;
    w.dataset.kind = text === t("alone") ? "alone" : "";
    clearTimeout(warnTimer);
    if (ms) warnTimer = setTimeout(hideWarn, ms);
  }
  function hideWarn() { $("warn").hidden = true; $("warn").dataset.kind = ""; }

  let wasHidden = false;
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) { wasHidden = true; return; }
    if (!state.wantOnline) return;
    try { await state.ctx.resume(); } catch {}
    keepAwake();
    if (wasHidden) { showWarn(t("hidden"), 6000); wasHidden = false; }
    // iOS иногда «глушит» дорожку микрофона после сворачивания — перезапускаем
    const track = state.stream && state.stream.getAudioTracks()[0];
    if (!track || track.readyState === "ended") {
      state.stream = null;
      state.capture = null;
      try { await startAudio(); applyMute(); } catch (e) { showWarn(t("micDenied")); }
    }
  });
})();
