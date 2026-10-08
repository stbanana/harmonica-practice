// 真实口琴采样引擎 —— 门控加载 39 个 .ogg（B3–C#7），按键播放对应采样。
// 对外 API 与旧合成引擎一致：ensure / now / noteOn / noteOff / panic / setVolume / setMuted / muted。

export const SAMPLE_MIN = 59;  // B3
export const SAMPLE_MAX = 97;  // C#7
const LETTER = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"];
const CONCURRENCY = 6;
const FADE_IN = 0.008;         // 8ms 淡入防爆音
const SAMPLE_GAIN = 0.9;

export function sampleUrl(p){
  const pc = ((p % 12) + 12) % 12;
  return `audio/harmonica/Harmonica_${LETTER[pc]}${Math.floor(p / 12) - 1}.ogg`;
}

export function samplePitches(){
  const out = [];
  for (let p = SAMPLE_MIN; p <= SAMPLE_MAX; p++) out.push(p);
  return out;
}

class AudioEngine {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.voice = null;
    this.muted = false;
    this._volume = 0.8;
    this.buffers = new Map(); // pitch → AudioBuffer
    this._failed = [];
    this._initPromise = null;
    this._onProgress = null;
    this._ready = false;
  }

  ensure(){
    if (!this.ctx){
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this._volume;
        this.master.connect(this.ctx.destination);
      } catch (e) { /* 无音频环境时静默降级 */ }
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  isReady(){ return this._ready; }

  // 该音高是否已有采样（试听时用于跳过无声的超域音）
  has(p){ return this.buffers.has(p); }

  now(){
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  setVolume(v){
    this._volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this._volume;
  }

  // 门控加载：并发拉取并解码全部采样，边加载边回调 onProgress(done, total, failed)
  init(onProgress){
    if (onProgress) this._onProgress = onProgress;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  retry(){
    this._initPromise = null;
    this._failed = [];
    return this.init();
  }

  async _doInit(){
    this.ensure();
    const total = samplePitches().length;
    const report = () => { if (this._onProgress) this._onProgress(this.buffers.size, total, this._failed.length); };
    report();
    const pending = samplePitches().filter(p => !this.buffers.has(p));
    let next = 0;
    const worker = async () => {
      while (next < pending.length){
        const p = pending[next++];
        await this._loadOne(p);
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, worker));
    this._ready = true;
    report();
    return { failed: this._failed.slice() };
  }

  async _loadOne(p){
    for (let attempt = 0; attempt < 2; attempt++){ // 失败重试一次
      try {
        const res = await fetch(sampleUrl(p));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = await res.arrayBuffer();
        this.buffers.set(p, await this.ctx.decodeAudioData(buf));
        return;
      } catch (e) {
        if (attempt === 1) this._failed.push(p);
      }
    }
  }

  noteOn(p){
    if (!this.ctx || !this.buffers.has(p)) return;
    this._releasePrev(0.02);
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(p);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(SAMPLE_GAIN, t + FADE_IN);
    src.connect(g); g.connect(this.master);
    src.start(t);
    this.voice = { src, g };
  }

  noteOff(release = 0.08){
    this._releasePrev(release);
  }

  panic(){
    this._releasePrev(0.01);
  }

  _releasePrev(release){
    const v = this.voice;
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setValueAtTime(Math.max(v.g.gain.value, 0.0001), t);
      v.g.gain.exponentialRampToValueAtTime(0.0001, t + release);
    } catch (e) {}
    try { v.src.stop(t + release + 0.02); } catch (e) {}
    this.voice = null;
  }
}

export const audio = new AudioEngine();
