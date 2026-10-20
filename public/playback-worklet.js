// Воспроизведение перевода: отдельная очередь на каждого говорящего, всё сводится в один выход.
class Playback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = 24000 / sampleRate; // шаг по входному (24 кГц) потоку на один выходной сэмпл
    this.sources = new Map(); // id -> { chunks: Float32Array[], idx, pos, started, buffered }
    this.gain = 1;
    this.wasPlaying = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.gain !== undefined) this.gain = d.gain;
      if (d.flush) this.sources.clear();
      if (d.pcm) {
        const i16 = new Int16Array(d.pcm);
        const f = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
        let s = this.sources.get(d.id);
        if (!s) {
          s = { chunks: [], pos: 0, started: false, buffered: 0, last: 0 };
          this.sources.set(d.id, s);
        }
        s.chunks.push(f);
        s.buffered += f.length;
        // слишком большое отставание (> 6 с) — выкидываем старое, чтобы не копилась задержка
        while (s.buffered > 24000 * 6 && s.chunks.length > 1) {
          s.buffered -= s.chunks[0].length;
          s.chunks.shift();
          s.pos = 0;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    let playing = false;
    for (const [id, s] of this.sources) {
      if (!s.started) {
        if (s.buffered < 2400) continue; // 100 мс джиттер-буфер
        s.started = true;
      }
      for (let i = 0; i < out.length; i++) {
        if (!s.chunks.length) break;
        let c = s.chunks[0];
        const k = Math.floor(s.pos);
        const frac = s.pos - k;
        const a = c[k];
        let b = k + 1 < c.length ? c[k + 1] : s.chunks[1] ? s.chunks[1][0] : a;
        out[i] += (a + (b - a) * frac) * this.gain;
        s.pos += this.step;
        while (s.chunks.length && s.pos >= s.chunks[0].length) {
          s.pos -= s.chunks[0].length;
          s.buffered -= s.chunks[0].length;
          s.chunks.shift();
        }
        playing = true;
      }
      if (!s.chunks.length) {
        s.started = false;
        s.buffered = 0;
        s.pos = 0;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    // дублируем в остальные каналы
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      this.port.postMessage({ playing });
    }
    return true;
  }
}
registerProcessor("playback", Playback);
