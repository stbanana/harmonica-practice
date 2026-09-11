// 合成音频引擎 —— 单音口琴音色（移植原三角波并加一层泛音 + 轻微颤音）。
// AudioContext 在首次用户手势时创建（即使静音也要创建：节奏模式的时钟依赖它）。

class AudioEngine {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.voice = null;
    this.muted = false;
    this._volume = 0.8;
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

  now(){
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  freq(p){ return 440 * Math.pow(2, (p - 69) / 12); }

  setVolume(v){
    this._volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this._volume;
  }

  noteOn(p){
    if (!this.ctx) return;
    this._releasePrev(0.02);
    const t = this.ctx.currentTime;
    const f = this.freq(p);

    const o1 = this.ctx.createOscillator(); o1.type = "triangle"; o1.frequency.value = f;
    const o2 = this.ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 2;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.15;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.3, t + 0.008);

    // 颤音：约 5 音分，120ms 后淡入
    const lfo = this.ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 5.5;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.linearRampToValueAtTime(f * 0.0029, t + 0.15);
    lfo.connect(lfoGain);
    lfoGain.connect(o1.frequency);
    lfoGain.connect(o2.frequency);

    o2.connect(g2); g2.connect(env); o1.connect(env);
    env.connect(this.master);
    o1.start(t); o2.start(t); lfo.start(t);
    this.voice = { o1, o2, lfo, env };
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
      v.env.gain.cancelScheduledValues(t);
      v.env.gain.setValueAtTime(Math.max(v.env.gain.value, 0.0001), t);
      v.env.gain.exponentialRampToValueAtTime(0.0001, t + release);
    } catch (e) {}
    try { v.o1.stop(t + release + 0.02); } catch (e) {}
    try { v.o2.stop(t + release + 0.02); } catch (e) {}
    try { v.lfo.stop(t + release + 0.02); } catch (e) {}
    this.voice = null;
  }
}

export const audio = new AudioEngine();
