// 输入控制器 —— 键盘 + 鼠标修饰键捕获，行为与原《口琴钢琴测试台.html》一致：
// 单音（后按优先）、松修饰键切音重触发、blur 全部释放、contextmenu/中键滚动抑制。
// 与原版不同处：给 UI 控件（[data-ui]）上的鼠标按下豁免修饰键处理；
// 并把每次状态变化以事件形式上报（onEvent），供「正在吹」显示与练习判定使用。

import { PHYS_KEYS, pitchFromCombo } from "./music.js";

function btnState(button){
  return button === 1 ? "middle" : button === 2 ? "right" : button === 0 ? "left" : null;
}

export class InputController {
  constructor({ audio, baseOct, onEvent }){
    this.audio = audio;
    this.baseOct = baseOct;
    this.onEvent = onEvent || (()=>{});

    this.held = [];          // 按住的物理键（后按优先，单音）
    this.mouseShift = 0;     // -1 左键 / 0 / +1 右键
    this.mouseSharp = false; // 中键
    this.latch = { shift: 0, sharp: false }; // 触屏/点击修饰灯的锁定状态

    this._bind();
  }

  setBaseOct(o){ this.baseOct = o; }

  get shift(){ return this.mouseShift !== 0 ? this.mouseShift : this.latch.shift; }
  get sharp(){ return this.mouseSharp || this.latch.sharp; }

  activeKey(){ return this.held.length ? this.held[this.held.length - 1] : null; }

  currentPitch(){
    const k = this.activeKey();
    return k ? pitchFromCombo(k, this.shift, this.sharp, this.baseOct) : null;
  }

  snapshot(){
    return {
      activeKey: this.activeKey(),
      pitch: this.currentPitch(),
      shift: this.shift, sharp: this.sharp,
      held: this.held.slice(),
      latch: { ...this.latch },
    };
  }

  setLatch(part, value){
    if (part === "shift") this.latch.shift = value;
    else if (part === "sharp") this.latch.sharp = !!value;
    this.updateMods();
  }

  pressKey(key){
    this.audio.ensure();
    if (!this.held.includes(key)) this.held.push(key);
    const p = this.currentPitch();
    this.audio.noteOn(p);
    this._emit("keyonset", key, p);
  }

  releaseKey(key){
    const i = this.held.indexOf(key);
    if (i >= 0) this.held.splice(i, 1);
    const p = this.currentPitch();
    if (!this.held.length) this.audio.noteOff(0.08);
    else this.audio.noteOn(p);
    this._emit("keyoff", this.activeKey(), p);
  }

  // 修饰键变化：若仍有按住键则切音重触发（与原版一致），但不作为新的判定 onset
  updateMods(){
    const p = this.currentPitch();
    if (this.held.length){
      this.audio.ensure();
      this.audio.noteOn(p);
    }
    this._emit("mods", this.activeKey(), p);
  }

  releaseAll(alsoVoice){
    this.held = [];
    this.mouseShift = 0; this.mouseSharp = false;
    if (alsoVoice) this.audio.noteOff(0.08);
    this._emit("releaseall", null, null);
  }

  _emit(type, key, pitch){
    this.onEvent({ type, key, pitch, snapshot: this.snapshot() });
  }

  _bind(){
    document.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      if (PHYS_KEYS.includes(k)){
        e.preventDefault();
        if (!e.repeat) this.pressKey(k);
      }
    });
    document.addEventListener("keyup", e => {
      const k = e.key.toLowerCase();
      if (PHYS_KEYS.includes(k)){
        e.preventDefault();
        this.releaseKey(k);
      }
    });
    window.addEventListener("blur", () => this.releaseAll(true));

    document.addEventListener("mousedown", e => {
      const b = btnState(e.button);
      if (!b) return;
      if (e.target.closest && e.target.closest("[data-ui]")) return; // UI 控件豁免
      if (b === "left") this.mouseShift = -1;
      else if (b === "right"){ this.mouseShift = 1; e.preventDefault(); }
      else if (b === "middle"){ this.mouseSharp = true; e.preventDefault(); }
      else return;
      this.audio.ensure();
      this.updateMods();
    });
    document.addEventListener("mouseup", e => {
      const b = btnState(e.button);
      if (b === "left" && this.mouseShift === -1) this.mouseShift = 0;
      else if (b === "right" && this.mouseShift === 1) this.mouseShift = 0;
      else if (b === "middle") this.mouseSharp = false;
      else return;
      this.updateMods();
    });
    document.addEventListener("contextmenu", e => e.preventDefault());
  }
}
