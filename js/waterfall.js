// 瀑布流渲染器 —— canvas + rAF，8 列对应物理键 z x c v b n m ，
// 音符块按音区着色（低=橙 中=绿 高=蓝 高高=紫），#音带中键徽标。

import { PHYS_KEYS, KEY_LABELS, DEG, pitchName } from "./music.js";

const REG_COLOR = { "低": "#e67e22", "中": "#3fa573", "高": "#3498db", "高高": "#9b59b6" };
const GRAY = "#5a6270";
const ACCENT = "#3fa573";
const PX_PER_SEC = 140;
const COL_INSET = 4;

export class Waterfall {
  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = 0; this.H = 0; this.dpr = 1;
    this.fx = [];
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  resize(){
    const el = this.canvas;
    const w = el.clientWidth, h = el.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    if (w === 0 || h === 0) return;
    el.width = Math.round(w * this.dpr);
    el.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.W = w; this.H = h;
  }

  // ---- 特效 ----
  flashText(text, color){ this.fx.push({ kind: "text", text, color, t0: this._animT }); }
  ring(col, color){ this.fx.push({ kind: "ring", col, color, t0: this._animT }); }
  colFlash(col, color){ this.fx.push({ kind: "col", col, color, t0: this._animT }); }

  // ---- 主渲染 ----
  // now     歌曲时间（秒，可为负 = 预备倒数；跟练模式为钳制后时钟）
  // session PracticeSession（含 rt 运行时音符）
  // st      { animT, playing, started }
  render(now, session, st){
    this._animT = st.animT;
    const ctx = this.ctx, W = this.W, H = this.H;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const colW = W / PHYS_KEYS.length;
    const hitY = H - 14;

    this._drawBackdrop(hitY);
    this._drawColumnHeads(colW);
    if (session) this._drawNotes(now, session, st, colW, hitY);
    this._drawHitLine(hitY, session, st, colW);
    this._drawNextHint(session, st.started, hitY);
    if (session && now < 0) this._drawCountdown(now);
    if (!st.started) this._drawCenterHint("按 空格 或点击「▶ 开始」");
    else if (!st.playing) this._drawCenterHint("已暂停 · 空格继续");
    this._drawFx(colW, hitY);
  }

  _drawBackdrop(hitY){
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, hitY - 90, 0, hitY);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(0, hitY - 90, this.W, 90);
  }

  _drawColumnHeads(colW){
    const ctx = this.ctx;
    ctx.font = "600 11px Consolas, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(139,147,161,0.85)";
    for (let i = 0; i < KEY_LABELS.length; i++){
      ctx.fillText(KEY_LABELS[i], i * colW + colW / 2, 14);
    }
  }

  _drawNotes(now, session, st, colW, hitY){
    const ctx = this.ctx;
    const next = session.nextNote();
    for (const n of session.rt){
      const bottom = hitY - (n.startSec - now) * PX_PER_SEC;
      if (bottom < -10) break;            // 后面的音符还在更上方（已按 startSec 排序）
      const h = Math.max(18, n.durSec * PX_PER_SEC);
      const top = bottom - h;
      if (top > this.H + 30) continue;    // 已滚出画面下方

      const x = n.col * colW + COL_INSET;
      const w = colW - COL_INSET * 2;

      const pc = ((n.pitch % 12) + 12) % 12;
      let fill, alpha = 0.92, label = DEG[pc], sub = pitchName(n.pitch);
      if (n.outOfRange){ fill = GRAY; alpha = n.judged ? 0.18 : 0.35; label = pitchName(n.pitch); sub = "超音域·免判定"; }
      else fill = REG_COLOR[n.reg] || GRAY;

      if (n.judged){
        const age = Math.max(0, now - (n.judgedAt ?? now));
        if (n.result === "miss"){ fill = GRAY; alpha = 0.45; }
        else if (n.result === "auto"){ fill = GRAY; alpha = 0.18; }
        else alpha = Math.max(0.12, 0.92 - age / 0.6);
      } else if (n === next && session.mode === "follow" && Math.abs(bottom - hitY) < 2.5){
        alpha = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(st.animT * 6)); // 停靠脉动
      }

      ctx.globalAlpha = alpha;
      this._roundRect(x, top, w, h, 6);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.stroke();

      // 左侧音区色条（超域灰色则略）
      if (!n.outOfRange){
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        this._roundRect(x + 3, top + 4, 3, Math.max(4, h - 8), 2);
        ctx.fill();
      }

      // 停靠等待的外发光
      if (n === next && session.mode === "follow" && !n.judged && Math.abs(bottom - hitY) < 2.5){
        ctx.globalAlpha = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(st.animT * 6));
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = fill;
        this._roundRect(x - 3, top - 3, w + 6, h + 6, 8);
        ctx.stroke();
      }
      ctx.globalAlpha = Math.max(alpha, 0.4); // 文字随块透明度，但保底可读

      // 唱名 + 修饰键文字 + 音名
      const mods = [];
      if (!n.outOfRange && n.combo){
        if (n.combo.shift === -1) mods.push(["左键", "#ffd9a8"]);
        else if (n.combo.shift === 1) mods.push(["右键", "#a8d4f2"]);
        if (n.combo.sharp) mods.push(["中键", "#dcb7ef"]);
      }
      const cx = x + w / 2;
      ctx.fillStyle = n.outOfRange ? "#c7ccd4" : "#fff";
      if (h >= 22){
        ctx.font = "700 12.5px system-ui, 'Microsoft YaHei UI'";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, cx, h < 34 ? top + h / 2 : top + 13);
      }
      if (!n.outOfRange && h >= 44){
        if (mods.length){
          this._drawModLine(mods, cx, top + 29);
          if (h >= 60){
            ctx.font = "9.5px Consolas, monospace";
            ctx.fillStyle = "rgba(255,255,255,0.55)";
            ctx.fillText(sub, cx, top + h - 10);
          }
        } else {
          ctx.font = "10px Consolas, monospace";
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.fillText(sub, cx, top + 29);
        }
      }

      // 中键徽标：仅在放不下修饰键文字的短块上作为 # 提示
      if (n.combo && n.combo.sharp && !n.outOfRange && h >= 22 && h < 44){
        ctx.beginPath();
        ctx.arc(x + w - 9, top + 9, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = "#9b59b6";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "700 9px system-ui";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("♯", x + w - 9, top + 9.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  // 块内修饰键文字行（各修饰键独立着色）
  _drawModLine(mods, cx, y){
    const ctx = this.ctx;
    ctx.font = "10px system-ui, 'Microsoft YaHei UI'";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const segs = [];
    mods.forEach((m, i) => {
      if (i) segs.push(["＋", "rgba(255,255,255,0.5)"]);
      segs.push(m);
    });
    const total = segs.reduce((s, [t]) => s + ctx.measureText(t).width, 0);
    let px = cx - total / 2;
    for (const [t, c] of segs){
      ctx.fillStyle = c;
      ctx.fillText(t, px, y);
      px += ctx.measureText(t).width;
    }
  }

  // 判定线上方的「下一音」独立文字行
  _drawNextHint(session, started, hitY){
    if (!started || !session) return;
    const n = session.nextNote();
    if (!n || !n.combo) return;
    const ctx = this.ctx;
    const parts = [["下一音", "rgba(255,255,255,0.72)"]];
    if (n.combo.shift === -1) parts.push(["左键", "#ffd9a8"]);
    else if (n.combo.shift === 1) parts.push(["右键", "#a8d4f2"]);
    if (n.combo.sharp) parts.push(["中键", "#dcb7ef"]);
    const keyName = n.combo.key === "," ? "，" : n.combo.key.toUpperCase();
    parts.push(["键[" + keyName + "]", "rgba(255,255,255,0.92)"]);

    ctx.font = "600 13px system-ui, 'Microsoft YaHei UI'";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const segs = [];
    parts.forEach((p, i) => {
      if (i) segs.push(["＋", "rgba(255,255,255,0.45)"]);
      segs.push(p);
    });
    const total = segs.reduce((s, [t]) => s + ctx.measureText(t).width, 0);
    const pad = 14, chipH = 26, y = hitY - 38;
    ctx.globalAlpha = 0.92;
    this._roundRect(this.W / 2 - total / 2 - pad, y, total + pad * 2, chipH, 13);
    ctx.fillStyle = "rgba(12,14,19,0.66)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    let px = this.W / 2 - total / 2;
    for (const [t, c] of segs){
      ctx.fillStyle = c;
      ctx.fillText(t, px, y + chipH / 2 + 0.5);
      px += ctx.measureText(t).width;
    }
    ctx.globalAlpha = 1;
  }

  _drawHitLine(hitY, session, st, colW){
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(63,165,115,0.9)";
    ctx.fillRect(0, hitY, this.W, 2.5);
    ctx.fillStyle = "rgba(63,165,115,0.15)";
    ctx.fillRect(0, hitY + 2.5, this.W, 12);

    // 目标列刻痕
    const n = session && session.nextNote();
    if (n && st.started){
      const cx = n.col * colW + colW / 2;
      const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(st.animT * 6));
      ctx.globalAlpha = pulse;
      ctx.beginPath();
      ctx.moveTo(cx - 7, hitY - 14);
      ctx.lineTo(cx + 7, hitY - 14);
      ctx.lineTo(cx, hitY - 4);
      ctx.closePath();
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  _drawCountdown(now){
    const ctx = this.ctx;
    const n = Math.ceil(-now);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#e6e9ee";
    ctx.font = "700 56px system-ui, 'Microsoft YaHei UI'";
    ctx.fillText(String(n), this.W / 2, this.H * 0.42);
    ctx.font = "14px system-ui, 'Microsoft YaHei UI'";
    ctx.fillStyle = "#8b93a1";
    ctx.fillText("预备…", this.W / 2, this.H * 0.42 + 44);
    ctx.globalAlpha = 1;
  }

  _drawCenterHint(text){
    const ctx = this.ctx;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "14px system-ui, 'Microsoft YaHei UI'";
    ctx.fillStyle = "rgba(139,147,161,0.9)";
    ctx.fillText(text, this.W / 2, this.H / 2);
  }

  _drawFx(colW, hitY){
    const ctx = this.ctx, t = this._animT ?? 0;
    this.fx = this.fx.filter(f => t - f.t0 < 0.8);
    for (const f of this.fx){
      const age = t - f.t0;
      if (f.kind === "text"){
        const a = Math.max(0, 1 - age / 0.7);
        ctx.globalAlpha = a;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = "800 24px system-ui, 'Microsoft YaHei UI'";
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, this.W / 2, this.H * 0.3);
      } else if (f.kind === "ring"){
        const a = Math.max(0, 1 - age / 0.5);
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(f.col * colW + colW / 2, hitY, 6 + age * 120, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = f.color;
        ctx.stroke();
      } else if (f.kind === "col"){
        const a = Math.max(0, 1 - age / 0.3) * 0.3;
        ctx.globalAlpha = a;
        ctx.fillStyle = f.color;
        ctx.fillRect(f.col * colW, 0, colW, this.H);
      }
      ctx.globalAlpha = 1;
    }
  }

  _roundRect(x, y, w, h, r){
    const ctx = this.ctx;
    if (typeof ctx.roundRect === "function"){
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
    }
  }
}
