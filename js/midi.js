// 最小 Standard MIDI File 解析器 —— 纯模块（无 DOM），可在 Node 中单测。
// 支持 format 0/1、VLQ、running status、note-on vel0 = note-off、tempo map；
// 不支持 SMPTE 时序（division 高位为 1 时报错）。

import { buildSong as finalizeSong } from "./music.js";

class Reader {
  constructor(view){ this.v = view; this.pos = 0; }
  u8(){ return this.v.getUint8(this.pos++); }
  u16(){ const x = this.v.getUint16(this.pos); this.pos += 2; return x; }
  u32(){ const x = this.v.getUint32(this.pos); this.pos += 4; return x; }
  str(n){ let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  vlq(){
    let v = 0;
    for (;;){
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
  }
  bytes(n){
    n = Math.min(n, this.v.byteLength - this.pos);
    const out = new Uint8Array(this.v.buffer, this.pos, Math.max(0, n));
    this.pos += n;
    return out;
  }
  skip(n){ this.pos += n; }
}

function decodeText(bytes){
  try { return new TextDecoder("utf-8").decode(bytes); }
  catch (e) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

function parseTrack(r, trackEnd, tempoEvents){
  let tick = 0, running = 0;
  const open = new Map(); // ch*128+pitch → {pitch, ch, startTick}
  const notes = [];
  let name = "";

  const closeNote = (key, atTick) => {
    const o = open.get(key);
    if (!o) return;
    open.delete(key);
    notes.push({ pitch: o.pitch, ch: o.ch, startTick: o.startTick, durTick: Math.max(0, atTick - o.startTick) });
  };

  while (r.pos < trackEnd){
    tick += r.vlq();
    let status = r.u8();
    if (status < 0x80){
      if (!running) break; // 损坏数据，放弃本轨剩余部分
      r.pos--;             // 数据字节回退，按 running status 处理
      status = running;
    } else if (status < 0xF0){
      running = status;
    }

    const type = status & 0xF0, ch = status & 0x0F;

    if (type === 0x90 && r.v.getUint8(r.pos + 1) > 0){
      const pitch = r.u8(), vel = r.u8();
      const key = ch * 128 + pitch;
      closeNote(key, tick); // 重复 note-on：先闭合上一个
      open.set(key, { pitch, ch, startTick: tick });
    } else if (type === 0x80 || type === 0x90){
      const pitch = r.u8();
      r.skip(1); // velocity / 0
      closeNote(ch * 128 + pitch, tick);
    } else if (type === 0xA0 || type === 0xB0 || type === 0xE0){
      r.skip(2);
    } else if (type === 0xC0 || type === 0xD0){
      r.skip(1);
    } else if (status === 0xFF){
      running = 0;
      const metaType = r.u8();
      const len = r.vlq();
      if (metaType === 0x51 && len === 3){
        const b = r.bytes(3);
        tempoEvents.push({ tick, usPerQ: (b[0] << 16) | (b[1] << 8) | b[2] });
      } else if (metaType === 0x03){
        name = decodeText(r.bytes(len)).trim();
      } else if (metaType === 0x2F){
        r.skip(len);
        break; // End of Track
      } else {
        r.skip(len);
      }
    } else if (status === 0xF0 || status === 0xF7){
      running = 0;
      r.skip(r.vlq());
    } else {
      break; // 未知状态字节，放弃本轨剩余部分
    }
  }
  r.pos = trackEnd;
  for (const [key, o] of open) closeNote(key, tick);
  return { name, notes };
}

function toArrayBuffer(data){
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)){
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new Error("MIDI 数据必须是 ArrayBuffer 或 TypedArray");
}

export function parseMidi(data){
  const r = new Reader(new DataView(toArrayBuffer(data)));
  if (r.str(4) !== "MThd") throw new Error("不是有效的 MIDI 文件（缺少 MThd）");
  const headerLen = r.u32();
  const format = r.u16();
  const nTracks = r.u16();
  const division = r.u16();
  if (division & 0x8000) throw new Error("不支持 SMPTE 时序的 MIDI 文件");
  const tpq = division || 480;
  r.skip(Math.max(0, headerLen - 6));

  const tempoEvents = [{ tick: 0, usPerQ: 500000 }]; // 缺省 120bpm
  const tracks = [];
  let durationTick = 0;

  while (r.pos < r.v.byteLength - 8){
    const id = r.str(4);
    const len = r.u32();
    if (r.pos + len > r.v.byteLength) break; // 截断的文件，尽力解析
    if (id === "MTrk"){
      const trackEnd = r.pos + len;
      const t = parseTrack(r, trackEnd, tempoEvents);
      if (t.notes.length){
        tracks.push({ name: t.name, noteCount: t.notes.length, notes: t.notes });
        for (const n of t.notes) durationTick = Math.max(durationTick, n.startTick + n.durTick);
      }
    } else {
      r.skip(len); // 未知 chunk 跳过
    }
  }

  tempoEvents.sort((a, b) => a.tick - b.tick);
  const bpm = Math.round(60e6 / tempoEvents[0].usPerQ);
  const tickToSec = makeTickToSec(tempoEvents, tpq);

  return { format, tpq, nTracks, tracks, tempoEvents, durationTick, bpm, tickToSec };
}

export function makeTickToSec(tempoEvents, tpq){
  return function tickToSec(tick){
    let sec = 0, prevTick = 0, usPerQ = tempoEvents[0].usPerQ;
    for (const e of tempoEvents){
      if (e.tick >= tick) break;
      sec += (e.tick - prevTick) * usPerQ / tpq / 1e6;
      prevTick = e.tick;
      usPerQ = e.usPerQ;
    }
    return sec + (tick - prevTick) * usPerQ / tpq / 1e6;
  };
}

// 默认音轨：非鼓轨（通道 10）中音符最多的一轨
export function bestTrackIndex(parsed){
  let best = -1, bestCount = 0;
  parsed.tracks.forEach((t, i) => {
    const count = t.notes.filter(n => n.ch !== 9).length;
    if (count > bestCount){ best = i; bestCount = count; }
  });
  return best < 0 && parsed.tracks.length ? 0 : best;
}

// 和弦 → 单音：起始相差 ≤30ms 的音符归为一组，取最高音（旋律几乎总在最上声部）
function reduceToMelody(events, tickToSec){
  const sorted = events.slice().sort((a, b) => a.startTick - b.startTick);
  const out = [];
  let group = null;
  for (const e of sorted){
    const startSec = tickToSec(e.startTick);
    if (group && startSec - group.startSec <= 0.03){
      if (e.pitch > group.top.pitch) group.top = e;
    } else {
      group = { startSec, top: e, startTick: e.startTick };
      out.push(group);
    }
  }
  return out.map(g => {
    const startSec = tickToSec(g.startTick);
    const durSec = tickToSec(g.top.startTick + g.top.durTick) - tickToSec(g.top.startTick);
    return {
      pitch: g.top.pitch,
      startSec,
      durSec: Math.max(0.05, durSec),
      startBeat: g.startTick / 480, // 占位；buildSong 优先使用 startSec
      durBeats: g.top.durTick / 480,
    };
  });
}

// trackSel: 索引 | "merge" | undefined（自动选择）
export function buildSongFromMidi(parsed, trackSel, baseOct, title){
  let events;
  if (trackSel === "merge"){
    events = parsed.tracks.flatMap(t => t.notes).filter(n => n.ch !== 9);
  } else {
    const idx = trackSel === undefined || trackSel === null ? bestTrackIndex(parsed) : trackSel;
    if (idx < 0 || idx >= parsed.tracks.length) throw new Error("没有可用的音轨");
    events = parsed.tracks[idx].notes;
  }
  if (!events.length) throw new Error("该 MIDI 文件（音轨）没有音符");

  const raw = {
    title: title || "MIDI 曲目",
    source: "midi",
    bpm: parsed.bpm,
    notes: reduceToMelody(events, parsed.tickToSec),
  };
  return finalizeSong(raw, baseOct);
}
