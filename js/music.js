// 音高 / 唱名 / 音区 / 按键组合换算 —— 纯模块（无 DOM），可在 Node 中单测。
// 正向 pitchFromCombo 与原《口琴钢琴测试台.html》的 pitchFrom 行为一致。

export const NAME12 = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
export const DEG = ["do","#do","re","#re","mi","fa","#fa","sol","#sol","la","#la","si"];
export const KEY_DEG = { "z":0, "x":2, "c":4, "v":5, "b":7, "n":9, "m":11 };
export const KEY_BY_PC = { 0:"z", 2:"x", 4:"c", 5:"v", 7:"b", 9:"n", 11:"m" };
export const WHITE_PCS = new Set([0,2,4,5,7,9,11]);
export const PHYS_KEYS = ["z","x","c","v","b","n","m",","];
export const KEY_LABELS = ["Z","X","C","V","B","N","M","，"];

export function pitchName(p){ return NAME12[((p%12)+12)%12] + (Math.floor(p/12)-1); }
export function degName(p){ return DEG[((p%12)+12)%12]; }

export function regOf(p, b){
  const d = Math.floor(p/12)-1 - b;
  return d<=-1 ? "低" : d===0 ? "中" : d===1 ? "高" : "高高";
}

// 正向：按键组合 → MIDI 音高（移植原 pitchFrom）
export function pitchFromCombo(key, shift, sharp, baseOct){
  const pc = KEY_DEG[key] ?? 0;
  const oct = baseOct + shift + (key === "," ? 1 : 0);
  return (oct + 1) * 12 + pc + (sharp ? 1 : 0);
}

export function playableRange(baseOct){
  return { min: baseOct * 12, max: (baseOct + 3) * 12 + 1 };
}

// 反向：MIDI 音高 → 标准引导指法（null = 超出可演奏域）。
// 高do 取游戏规则原文指法「逗号」，高高do/#do 取「右键+逗号」「右键+中+逗号」；
// 等价指法（如 右键+z 也能吹高do）判定时同样通过——判定按结果音高匹配。
export function comboFromPitch(p, baseOct){
  let rel = p - (baseOct + 1) * 12;
  if (rel === 25) return { key: ",", shift: 1, sharp: true };
  if (rel === 24) return { key: ",", shift: 1, sharp: false };
  if (rel === 12) return { key: ",", shift: 0, sharp: false };
  if (rel < -12 || rel > 25) return null;
  let shift = 0;
  if (rel < 0) { shift = -1; rel += 12; }
  else if (rel >= 12) { shift = 1; rel -= 12; }
  if (WHITE_PCS.has(rel)) return { key: KEY_BY_PC[rel], shift, sharp: false };
  return { key: KEY_BY_PC[rel - 1], shift, sharp: true };
}

// 整体八度适配：在 ±24 半音内选一个偏移，使入域音符最多（平手取偏移绝对值小者）。
export function fitOctave(pitches, baseOct){
  const { min, max } = playableRange(baseOct);
  let best = 0, bestScore = -1;
  for (const off of [0, 12, -12, 24, -24]){
    let score = 0;
    for (const p of pitches){
      const q = p + off;
      if (q >= min && q <= max) score++;
    }
    if (score > bestScore || (score === bestScore && Math.abs(off) < Math.abs(best))){
      best = off; bestScore = score;
    }
  }
  return best;
}

// 把原始曲目数据（内置演示 / MIDI 解析结果）构造成完整的 Song。
// raw = { title, source:"demo"|"midi", bpm, notes:[{pitch, startBeat, durBeats, startSec?, durSec?}] }
// MIDI 的 startSec/durSec 由 tempo map 预先算好传入；演示曲目用固定 bpm 推算。
export function buildSong(raw, baseOct){
  const offset = fitOctave(raw.notes.map(n => n.pitch), baseOct);
  const { min, max } = playableRange(baseOct);
  const secPerBeat = raw.bpm ? 60 / raw.bpm : 0.5;
  const notes = raw.notes.map((n, i) => {
    const pitch = n.pitch + offset;
    const startSec = n.startSec ?? n.startBeat * secPerBeat;
    const durSec = n.durSec ?? n.durBeats * secPerBeat;
    const combo = comboFromPitch(pitch, baseOct);
    // 超域音符的显示列：钳回域内后取列，避免渲染时无列可用
    const dispP = Math.min(max, Math.max(min, pitch));
    const dispCombo = combo || comboFromPitch(dispP, baseOct);
    const col = PHYS_KEYS.indexOf(dispCombo.key);
    return {
      idx: i, pitch, startBeat: n.startBeat ?? 0, durBeats: n.durBeats ?? 0,
      startSec, durSec, combo, outOfRange: !combo,
      reg: regOf(pitch, baseOct), col,
    };
  }).sort((a, b) => a.startSec - b.startSec);
  const durationSec = notes.length
    ? Math.max(...notes.map(n => n.startSec + n.durSec)) : 0;
  return {
    title: raw.title, source: raw.source, bpm: raw.bpm, octaveOffset: offset,
    notes, durationSec,
    judgeableCount: notes.filter(n => !n.outOfRange).length,
  };
}
