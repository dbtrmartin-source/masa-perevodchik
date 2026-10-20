// Захват микрофона: понижаем частоту до 24 кГц, PCM16, «шумовой порог» (gate),
// чтобы голоса соседей по столу не уходили в перевод.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.pos = 0; // дробная позиция чтения во входном потоке
    this.prev = 0;
    this.out = new Int16Array(2400); // 100 мс
    this.n = 0;
    this.threshold = 0.02; // RMS-порог
    this.holdFrames = 0;
    this.open = false;
    this.muted = false;
    this.tail = 0;
    this.levelAcc = 0;
    this.levelCnt = 0;
    this.port.onmessage = (e) => {
      if ("threshold" in e.data) this.threshold = e.data.threshold;
      if ("muted" in e.data) this.muted = e.data.muted;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    // RMS блока для порога и индикатора
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (rms > this.threshold) {
      this.open = true;
      this.holdFrames = Math.round((0.7 * sampleRate) / ch.length); // держим 700 мс после речи
    } else if (this.holdFrames > 0) {
      this.holdFrames--;
    } else {
      this.open = false;
    }
    const pass = this.open && !this.muted;
    // после речи досылаем 1 с тишины (чтобы модель поняла конец фразы), дальше молчим — не платим за тишину
    if (pass) this.tail = Math.round(sampleRate / ch.length);
    else if (this.tail > 0) this.tail--;
    const send = pass || (this.tail > 0 && !this.muted);

    this.levelAcc = Math.max(this.levelAcc, rms);
    if (++this.levelCnt >= 8) {
      this.port.postMessage({ level: this.levelAcc, open: pass });
      this.levelAcc = 0;
      this.levelCnt = 0;
    }

    // линейная интерполяция sampleRate -> 24000
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      // pos отсчитывается так, что ch[i-1] — предыдущий сэмпл
      let v = pass ? a + (b - a) * frac : 0;
      v = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        if (send) this.port.postMessage({ pcm: this.out.buffer }, [this.out.buffer]);
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
