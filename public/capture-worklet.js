// Захват микрофона: 24 кГц PCM16 + «шумовой порог».
// v7: перед началом речи досылаем 0.5 с «предзаписи» (не режем первое слово),
// держим порог открытым 1.2 с (не режем тихие места внутри фразы), после речи — 1 с хвоста.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.pos = 0;
    this.prev = 0;
    this.out = new Int16Array(2400); // 100 мс
    this.n = 0;
    this.threshold = 0.02;
    this.holdFrames = 0;
    this.open = false;
    this.muted = false;
    this.tail = 0;
    this.pre = []; // предзапись: последние 5 блоков по 100 мс, пока порог закрыт
    this.levelAcc = 0;
    this.levelCnt = 0;
    this.port.onmessage = (e) => {
      if ("threshold" in e.data) this.threshold = e.data.threshold;
      if ("muted" in e.data) { this.muted = e.data.muted; if (this.muted) this.pre = []; }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (rms > this.threshold) {
      this.open = true;
      this.holdFrames = Math.round((1.2 * sampleRate) / ch.length);
    } else if (this.holdFrames > 0) {
      this.holdFrames--;
    } else {
      this.open = false;
    }
    const pass = this.open && !this.muted;
    if (pass) this.tail = Math.round(sampleRate / ch.length);
    else if (this.tail > 0) this.tail--;
    const send = pass || (this.tail > 0 && !this.muted);

    if (pass && this.pre.length) {
      for (const b of this.pre) this.port.postMessage({ pcm: b }, [b]);
      this.pre = [];
    }

    this.levelAcc = Math.max(this.levelAcc, rms);
    if (++this.levelCnt >= 8) {
      this.port.postMessage({ level: this.levelAcc, open: pass });
      this.levelAcc = 0;
      this.levelCnt = 0;
    }

    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      let v = this.muted ? 0 : a + (b - a) * frac;
      v = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        if (send) this.port.postMessage({ pcm: this.out.buffer }, [this.out.buffer]);
        else if (!this.muted) {
          this.pre.push(this.out.buffer);
          if (this.pre.length > 5) this.pre.shift();
        }
        this.out = new Int16Array(2400);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor("capture", Capture);
