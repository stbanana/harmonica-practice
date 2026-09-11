// 练习会话状态机 —— 纯模块（无 DOM），时钟由宿主注入。
// follow（跟练）：下一音符停靠判定线等待，按对（音高匹配）才前进；
// rhythm（节奏）：连续滚动，±80ms perfect / ±300ms good / 窗口关闭 miss。

export class PracticeSession {
  constructor(song, mode, opts = {}){
    this.song = song;
    this.mode = mode; // "follow" | "rhythm"
    this.perfectMs = opts.perfectMs ?? 80;
    this.goodMs = opts.goodMs ?? 300;
    this.reset();
  }

  reset(){
    // rt = 运行时音符状态（judged/result/judgedAt 不写回 song，重练可重来）
    this.rt = this.song.notes.map(n => ({ ...n, judged: false, result: null, judgedAt: null, deltaMs: null }));
    this.stats = { perfect: 0, good: 0, miss: 0, wrong: 0, extra: 0, combo: 0, maxCombo: 0 };
    this.finished = false;
    this.followNow = 0;
    this._lastWall = null;
  }

  nextNote(){
    return this.rt.find(n => !n.judged && !n.outOfRange) || null;
  }

  // 跟练模式的独立时间轴：宿主每帧用墙钟时间推进。
  // 只按真实流逝时间前进（可乘速度），且永不超过下一待按音符的开始时刻——
  // 因此等待期间时间轴冻结，命中后从停靠点按音符时序继续，不会跳拍。
  startFollow(atSec){
    this.followNow = atSec;
    this._lastWall = null;
  }

  // 暂停/恢复后调用：让下一次 advance 以当前墙钟为基准重新计时
  syncFollowWall(){
    this._lastWall = null;
  }

  advanceFollow(wallNow, speed = 1){
    if (this._lastWall === null){ this._lastWall = wallNow; return; }
    const dt = Math.max(wallNow - this._lastWall, 0);
    this._lastWall = wallNow;
    const n = this.nextNote();
    const target = n ? n.startSec : Infinity;
    this.followNow = Math.min(this.followNow + dt * speed, target);
  }

  // 宿主在每次按下（新 onset）时调用；now 为歌曲时间（秒）
  press(pitch, now){
    if (this.finished) return { result: "extra" };
    if (this.mode === "follow") return this._pressFollow(pitch, now);
    return this._pressRhythm(pitch, now);
  }

  _pressFollow(pitch, now){
    const n = this.nextNote();
    if (!n) return { result: "extra" };
    if (pitch === n.pitch){
      n.judged = true; n.result = "hit"; n.judgedAt = now;
      this.stats.perfect++; // 跟练的「命中」计入 perfect，结算屏按模式改标签
      this.stats.combo++;
      if (this.stats.combo > this.stats.maxCombo) this.stats.maxCombo = this.stats.combo;
      this._checkFinished(now);
      return { result: "hit", note: n };
    }
    this.stats.wrong++;
    return { result: "wrong" };
  }

  _pressRhythm(pitch, now){
    const win = this.goodMs / 1000;
    let best = null, bestAbs = Infinity;
    for (const n of this.rt){
      if (n.startSec > now + win + 0.2) break; // 已按 startSec 排序
      if (n.judged || n.outOfRange) continue;
      if (n.startSec + win < now) continue;
      if (n.pitch !== pitch) continue;
      const a = Math.abs(n.startSec - now);
      if (a < bestAbs){ best = n; bestAbs = a; }
    }
    if (best){
      const deltaMs = Math.round(bestAbs * 1000);
      const res = deltaMs <= this.perfectMs ? "perfect" : "good";
      best.judged = true; best.result = res; best.judgedAt = now; best.deltaMs = deltaMs;
      this.stats[res]++;
      this.stats.combo++;
      if (this.stats.combo > this.stats.maxCombo) this.stats.maxCombo = this.stats.combo;
      this._checkFinished(now);
      return { result: res, note: best, deltaMs };
    }
    this.stats.extra++;
    return { result: "extra" };
  }

  // 宿主每帧调用。跟练模式传入钳制后的 now（等待时不判 miss）。
  tick(now){
    if (this.finished) return;
    const win = this.goodMs / 1000;
    for (const n of this.rt){
      if (n.judged) continue;
      if (n.startSec + win >= now) continue; // 后面的都还没到期（已排序）
      if (n.outOfRange){
        n.judged = true; n.result = "auto"; n.judgedAt = now;
      } else if (this.mode === "rhythm"){
        n.judged = true; n.result = "miss"; n.judgedAt = now;
        this.stats.miss++;
        this.stats.combo = 0;
      }
      // follow 模式下可判定音符永不过期（等待玩家）
    }
    this._checkFinished(now);
  }

  _checkFinished(now){
    if (!this.finished && this.rt.every(n => n.judged)) this.finished = true;
  }

  progress(){
    const total = this.rt.length || 1;
    return Math.round(this.rt.filter(n => n.judged).length / total * 100);
  }

  accuracy(){
    const denom = this.song.judgeableCount;
    if (!denom) return null;
    return (this.stats.perfect + 0.6 * this.stats.good) / denom;
  }

  score(){
    return this.stats.perfect * 100 + this.stats.good * 60;
  }
}
