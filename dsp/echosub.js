// Remove do áudio compartilhado o que o próprio app tocou (as vozes da call).
// ref = o que o app toca nos alto-falantes; cap = áudio do computador capturado (contém uma cópia atrasada do ref).
// 1) acha o atraso por correlação acumulada (a ~8 kHz, aos poucos, para não travar o áudio) e só "trava" depois de
//    várias buscas seguidas apontarem o mesmo atraso (evita falsos positivos);
// 2) um filtro adaptativo curto (NLMS, 16 coeficientes) ajusta ganho e atraso fino e subtrai a cópia.
class EchoSub {
  constructor(sr) {
    this.D = Math.max(1, Math.round(sr / 8000));
    this.K = 16; this.mu = 0.1;
    this.R = 32768; this.ref = new Float32Array(this.R); this.wi = 0;
    this.N = 16384; this.dr = new Float32Array(this.N); this.dc = new Float32Array(this.N); this.di = 0; this.dcount = 0;
    this.acR = 0; this.acC = 0; this.acN = 0; this.r1 = 0; this.r2 = 0; this.c1 = 0; this.c2 = 0; // pré-ênfase
    this.W = 6000; this.maxLag = 2400; this.sinceScan = 0; this.busy = false; this.scanned = false;
    this.sc = new Float32Array(this.W); this.sr_ = new Float32Array(this.W + this.maxLag); this.pre = new Float64Array(this.W + this.maxLag + 1);
    this.corr = new Float32Array(this.maxLag + 1); this.acc = new Float32Array(this.maxLag + 1); this.lagI = 0; this.ec = 0;
    this.w = new Float32Array(this.K); this.delay = -1; this.pw = 0;
    this.cand = -1; this.streak = 0; this.bad = 0; this.locked = false;
  }
  _resync() {
    const m = this.R - 1, base = Math.max(0, this.delay - (this.K >> 1)); let p = 0;
    for (let k = 0; k < this.K; k++) { const x = this.ref[(this.wi - 1 - base - k) & m]; p += x * x; }
    this.pw = p;
  }
  process(r, c, pred) { // processa um bloco; em pred[] fica a cópia estimada para subtrair do capturado
    const n = r.length, m = this.R - 1, dm = this.N - 1, K = this.K;
    const base = this.delay < 0 ? 0 : Math.max(0, this.delay - (K >> 1));
    for (let i = 0; i < n; i++) {
      this.ref[this.wi & m] = r[i]; this.wi++;
      this.acR += r[i]; this.acC += c[i];
      if (++this.acN === this.D) { // decimação + pré-ênfase (derivada segunda): deixa a música "tonal" menos dominante na correlação
        const a = this.acR / this.D, b = this.acC / this.D;
        this.dr[this.di] = a - 2 * this.r1 + this.r2; this.dc[this.di] = b - 2 * this.c1 + this.c2;
        this.r2 = this.r1; this.r1 = a; this.c2 = this.c1; this.c1 = b;
        this.di = (this.di + 1) & dm; this.dcount++; this.sinceScan++; this.acR = this.acC = this.acN = 0;
      }
      if (this.delay < 0) { pred[i] = 0; continue; }
      const nw = this.ref[(this.wi - 1 - base) & m], ow = this.ref[(this.wi - 1 - base - K) & m];
      this.pw += nw * nw - ow * ow;
      let y = 0;
      for (let k = 0; k < K; k++) y += this.w[k] * this.ref[(this.wi - 1 - base - k) & m];
      pred[i] = y;
      if (this.pw > K * 1e-6) {
        const g = (this.mu * (c[i] - y)) / (this.pw + 1e-6);
        for (let k = 0; k < K; k++) this.w[k] += g * this.ref[(this.wi - 1 - base - k) & m];
      }
    }
    this._resync();
    this._scanStep();
  }
  _scanStep() {
    const W = this.W, L = this.maxLag, dm = this.N - 1;
    if (!this.busy) {
      if (this.dcount < W + L + 400 || (this.scanned && this.sinceScan < 8000)) return; // 1ª busca com ~1 s de áudio; depois a cada ~1 s
      const end = this.di; this.ec = 0; this.pre[0] = 0;
      for (let i = 0; i < W; i++) { this.sc[i] = this.dc[(end - W + i) & dm]; this.ec += this.sc[i] * this.sc[i]; }
      for (let j = 0; j < W + L; j++) { const v = this.dr[(end - W - L + j) & dm]; this.sr_[j] = v; this.pre[j + 1] = this.pre[j] + v * v; }
      this.busy = true; this.lagI = 0; this.sinceScan = 0; return;
    }
    for (let q = 0; q < 12 && this.lagI <= L; q++, this.lagI++) {
      let acc = 0; const off = L - this.lagI;
      for (let i = 0; i < W; i++) acc += this.sc[i] * this.sr_[i + off];
      const er = this.pre[off + W] - this.pre[off];
      this.corr[this.lagI] = er / W > 1e-12 && this.ec > 0 ? acc / Math.sqrt(this.ec * er + 1e-18) : 0;
    }
    if (this.lagI > L) { this.busy = false; this.scanned = true; this._decide(); }
  }
  _decide() {
    const L = this.maxLag; let best = 0, bv = -1, sum = 0;
    for (let l = 0; l <= L; l++) { this.acc[l] = this.acc[l] * 0.7 + this.corr[l]; sum += Math.abs(this.acc[l]); if (this.acc[l] > bv) { bv = this.acc[l]; best = l; } }
    const mean = sum / (L + 1);
    this.lastStat = [best * this.D, +bv.toFixed(2), +(bv / mean).toFixed(1)];
    const strong = bv > 0.4 && bv > 6 * mean;
    if (strong && this.cand >= 0 && Math.abs(best - this.cand) <= 2) this.streak++; else this.streak = strong ? 1 : 0;
    this.cand = strong ? best : -1;
    if (this.streak >= 2) {
      const nd = best * this.D; this.bad = 0;
      if (this.delay < 0 || Math.abs(nd - this.delay) > this.D) {
        if (this.delay < 0 || Math.abs(nd - this.delay) > this.K / 2) this.w.fill(0);
        this.delay = nd; this._resync();
      }
      this.locked = true;
    } else if (this.locked && !strong && ++this.bad >= 8) { this.delay = -1; this.w.fill(0); this.locked = false; this.acc.fill(0); } // perdeu o eco: volta a só deixar passar
  }
}
if (typeof registerProcessor !== "undefined") {
  registerProcessor("echosub", class extends AudioWorkletProcessor {
    constructor() { super(); this.es = new EchoSub(sampleRate); this.r = new Float32Array(128); this.c = new Float32Array(128); this.p = new Float32Array(128); }
    process(inputs, outputs) {
      const cap = inputs[0], ref = inputs[1], out = outputs[0], n = out[0].length;
      if (this.r.length !== n) { this.r = new Float32Array(n); this.c = new Float32Array(n); this.p = new Float32Array(n); }
      this.r.fill(0); this.c.fill(0);
      if (ref && ref.length) { for (const ch of ref) for (let i = 0; i < n; i++) this.r[i] += ch[i] / ref.length; }
      if (cap && cap.length) { for (const ch of cap) for (let i = 0; i < n; i++) this.c[i] += ch[i] / cap.length; }
      this.es.process(this.r, this.c, this.p);
      if ((this.t = (this.t || 0) + n) >= sampleRate) { this.t = 0; this.port.postMessage({ locked: this.es.locked, delay: this.es.delay / sampleRate, stat: this.es.lastStat || null }); } // 1x por segundo: estado do filtro
      for (let ch = 0; ch < out.length; ch++) {
        const src = cap && cap.length ? cap[Math.min(ch, cap.length - 1)] : null;
        for (let i = 0; i < n; i++) out[ch][i] = (src ? src[i] : 0) - this.p[i];
      }
      return true;
    }
  });
}
if (typeof module !== "undefined") module.exports = { EchoSub };