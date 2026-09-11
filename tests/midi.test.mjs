import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMidi, buildSongFromMidi, bestChannel, summarizeChannels } from "../js/midi.js";

// ---------- SMF 字节构造工具 ----------

const u32be = v => Buffer.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const u16be = v => Buffer.from([(v >>> 8) & 255, v & 255]);
const vlq = v => {
  const bytes = [v & 0x7f];
  v >>>= 7;
  while (v){ bytes.unshift((v & 0x7f) | 0x80); v >>>= 7; }
  return Buffer.from(bytes);
};
const chunk = (id, body) => Buffer.concat([Buffer.from(id, "ascii"), u32be(body.length), body]);
const d = v => vlq(v);
const on = (pitch, vel = 64) => Buffer.from([0x90, pitch, vel]);
const off = pitch => Buffer.from([0x80, pitch, 0]);
const metaTempo = us => Buffer.from([0xFF, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255]);
const metaEOT = () => Buffer.from([0xFF, 0x2F, 0x00]);

function smf({ format = 0, division = 480, tracks = [] }){
  const header = chunk("MThd", Buffer.concat([u16be(format), u16be(tracks.length), u16be(division)]));
  return Buffer.concat([header, ...tracks.map(t => chunk("MTrk", t))]);
}

const ev = (...parts) => Buffer.concat(parts);

// ---------- 基础解析 ----------

test("format 0：音符与默认 120bpm 时长", () => {
  const buf = smf({
    tracks: [ev(
      d(0), on(60), d(480), off(60),
      d(0), on(64), d(480), off(64),
      d(0), metaEOT(),
    )],
  });
  const p = parseMidi(buf);
  assert.equal(p.format, 0);
  assert.equal(p.tpq, 480);
  assert.equal(p.tracks.length, 1);
  assert.equal(p.tracks[0].notes.length, 2);
  assert.deepEqual(p.tracks[0].notes[0], { pitch: 60, ch: 0, startTick: 0, durTick: 480 });
  assert.deepEqual(p.tracks[0].notes[1], { pitch: 64, ch: 0, startTick: 480, durTick: 480 });
  assert.equal(p.bpm, 120);
  assert.equal(p.tickToSec(480), 0.5);   // 480 tick = 1 拍 = 0.5s
  assert.equal(p.tickToSec(960), 1.0);
});

test("running status + velocity 0 作为 note-off", () => {
  const buf = smf({
    tracks: [ev(
      d(0), on(60),
      d(240), Buffer.from([62, 64]),   // running status: note-on 62
      d(240), Buffer.from([62, 0]),    // running status: note-off（vel 0）
      d(0), off(60),
      d(0), metaEOT(),
    )],
  });
  const p = parseMidi(buf);
  const notes = p.tracks[0].notes;
  assert.equal(notes.length, 2);
  const n62 = notes.find(n => n.pitch === 62);
  const n60 = notes.find(n => n.pitch === 60);
  assert.deepEqual(n62, { pitch: 62, ch: 0, startTick: 240, durTick: 240 });
  assert.deepEqual(n60, { pitch: 60, ch: 0, startTick: 0, durTick: 480 });
});

test("tempo 变化的分段换算", () => {
  const buf = smf({
    tracks: [ev(
      d(0), metaTempo(500000),          // 120bpm @ tick 0
      d(0), on(60), d(480), off(60),
      d(0), metaTempo(1000000),         // 60bpm @ tick 480
      d(0), on(62), d(480), off(62),
      d(0), metaEOT(),
    )],
  });
  const p = parseMidi(buf);
  assert.equal(p.tickToSec(480), 0.5);
  assert.equal(p.tickToSec(960), 1.5);  // 0.5 + 1.0
  const song = buildSongFromMidi(p, 1, 5, "t");
  const n62 = song.notes.find(n => n.pitch === 62);
  assert.equal(n62.startSec, 0.5);
  assert.equal(n62.durSec, 1.0);
});

test("曲终未闭合的音符按最后 tick 收口", () => {
  const buf = smf({ tracks: [ev(d(0), on(60), d(480), metaEOT())] });
  const p = parseMidi(buf);
  assert.deepEqual(p.tracks[0].notes, [{ pitch: 60, ch: 0, startTick: 0, durTick: 480 }]);
});

test("SMPTE division 报错", () => {
  const buf = smf({ division: 0xE728, tracks: [ev(d(0), metaEOT())] });
  assert.throws(() => parseMidi(buf), /SMPTE/);
});

test("非 MIDI 文件报错", () => {
  assert.throws(() => parseMidi(Buffer.from("hello world!!")), /MThd/);
});

test("format 1：tempo 轨（无音符）不影响通道选择", () => {
  const buf = smf({
    format: 1,
    tracks: [
      ev(d(0), metaTempo(500000), d(0), metaEOT()),
      ev(d(0), on(72), d(480), off(72), d(0), metaEOT()),
    ],
  });
  const p = parseMidi(buf);
  assert.equal(p.tracks.length, 1);      // 无音符轨不进列表
  assert.equal(bestChannel(p), 1);
  assert.equal(p.bpm, 120);
  const song = buildSongFromMidi(p, undefined, 5, "t");
  assert.equal(song.notes.length, 1);
  assert.equal(song.notes[0].pitch, 72);
});

// ---------- 和弦归并 / 音域适配 / 合并 ----------

test("和弦取最高音（起始 ≤30ms 归并）", () => {
  const buf = smf({
    tracks: [ev(
      d(0), on(60), d(0), on(64), d(0), on(67),
      d(480), off(60), d(0), off(64), d(0), off(67),
      d(0), metaEOT(),
    )],
  });
  const p = parseMidi(buf);
  assert.equal(p.tracks[0].notes.length, 3);   // 解析层保留全部
  const song = buildSongFromMidi(p, 1, 5, "t");
  assert.equal(song.notes.length, 1);          // 归并成单音
  assert.equal(song.notes[0].pitch, 67);       // 最高音
});

test("音域适配：整体移位到可演奏域", () => {
  const buf = smf({ tracks: [ev(d(0), on(108), d(480), off(108), d(0), metaEOT())] });
  const p = parseMidi(buf);
  const song = buildSongFromMidi(p, 1, 5, "t");
  assert.equal(song.notes[0].pitch, 96);       // C8 → 高高do
  assert.deepEqual(song.notes[0].combo, { key: ",", shift: 1, sharp: false });
});

test("merge 合并多通道（不含鼓通道）", () => {
  const drum = ev(d(0), Buffer.from([0x99, 38, 64]), d(240), Buffer.from([0x89, 38, 0]), d(0), metaEOT()); // 通道 10
  const mel = ev(d(0), on(72), d(240), off(72), d(0), metaEOT());
  const buf = smf({ format: 1, tracks: [drum, mel] });
  const p = parseMidi(buf);
  assert.equal(p.tracks.length, 2);
  const song = buildSongFromMidi(p, "merge", 5, "t");
  assert.equal(song.notes.length, 1);
  assert.equal(song.notes[0].pitch, 72);       // 鼓通道被过滤
});

test("按通道汇总并正确选默认通道（排除鼓通道 10）", () => {
  const buf = smf({
    format: 1,
    tracks: [
      ev(d(0), on(72), d(480), off(72), d(0), metaEOT()),                       // 通道 1，1 音
      ev(d(0), Buffer.from([0x91, 60, 64]), d(480), Buffer.from([0x81, 60, 0]), d(0), metaEOT()), // 通道 2，1 音
      ev(d(0), Buffer.from([0x99, 38, 64]), d(120), Buffer.from([0x89, 38, 0]),
         d(120), Buffer.from([0x99, 42, 64]), d(120), Buffer.from([0x89, 42, 0]), d(0), metaEOT()), // 通道 10 鼓，2 音
    ],
  });
  const p = parseMidi(buf);
  const chs = summarizeChannels(p);
  assert.deepEqual(chs.map(c => c.channel), [1, 2, 10]);
  assert.deepEqual(chs.map(c => c.noteCount), [1, 1, 2]);
  assert.equal(bestChannel(p), 1);          // 通道 10 被排除，1 与 2 同分 → 取序号小的 1
  const song = buildSongFromMidi(p, 2, 5, "t"); // 显式选通道 2
  assert.equal(song.notes.length, 1);
  assert.equal(song.notes[0].pitch, 60);
});

test("选中通道起始时间平移到 0（第一个音符非 0 秒也强制从头倒数）", () => {
  const buf = smf({
    tracks: [ev(
      d(960), on(60), d(960), off(60),         // 第一个音符 960 tick = 1s 处
      d(480), on(64), d(480), off(64),         // 第二个在 2400 tick = 2.5s 处
      d(0), metaEOT(),
    )],
  });
  const p = parseMidi(buf);
  const song = buildSongFromMidi(p, 1, 5, "t");
  assert.equal(song.notes[0].startSec, 0);     // 平移到 0
  assert.equal(song.notes[1].startSec, 1.5);   // 相对间隔不变（2.5 - 1.0）
  assert.equal(song.notes[0].pitch, 60);
});
