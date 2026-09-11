import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pitchFromCombo, comboFromPitch, playableRange, fitOctave, buildSong,
  pitchName, degName, regOf,
} from "../js/music.js";

// ---------- 正向映射（与原测试台 pitchFrom 行为一致） ----------

test("pitchFromCombo 与原测试台一致", () => {
  assert.equal(pitchFromCombo("z", 0, false, 5), 72);  // 中do = C5
  assert.equal(pitchFromCombo("x", 0, false, 5), 74);
  assert.equal(pitchFromCombo("m", 0, false, 5), 83);  // 中si
  assert.equal(pitchFromCombo("z", 0, true, 5), 73);   // 中键 do → C#5
  assert.equal(pitchFromCombo("z", -1, false, 5), 60); // 左键 do → C4 低do
  assert.equal(pitchFromCombo(",", 0, false, 5), 84);  // 逗号 → 高do C6
  assert.equal(pitchFromCombo(",", 1, false, 5), 96);  // 右+逗号 → 高高do
  assert.equal(pitchFromCombo(",", 1, true, 5), 97);   // 右+中+逗号 → 高高#do
  assert.equal(pitchFromCombo("z", 1, false, 5), 84);  // 等价指法：右+z 也是高do
});

// ---------- 反向映射（引导指法，取游戏规则原文的逗号指法） ----------

test("comboFromPitch 标准指法", () => {
  assert.deepEqual(comboFromPitch(60, 5), { key: "z", shift: -1, sharp: false }); // 低do
  assert.deepEqual(comboFromPitch(73, 5), { key: "z", shift: 0, sharp: true });   // 中#do
  assert.deepEqual(comboFromPitch(79, 5), { key: "b", shift: 0, sharp: false });  // 中sol
  assert.deepEqual(comboFromPitch(84, 5), { key: ",", shift: 0, sharp: false });  // 高do = 逗号
  assert.deepEqual(comboFromPitch(87, 5), { key: "x", shift: 1, sharp: true });   // 高#re = 右+中+x
  assert.deepEqual(comboFromPitch(95, 5), { key: "m", shift: 1, sharp: false });  // 高si
  assert.deepEqual(comboFromPitch(96, 5), { key: ",", shift: 1, sharp: false });  // 高高do = 右+逗号
  assert.deepEqual(comboFromPitch(97, 5), { key: ",", shift: 1, sharp: true });   // 高高#do
});

test("comboFromPitch 超域返回 null", () => {
  assert.equal(comboFromPitch(59, 5), null);
  assert.equal(comboFromPitch(98, 5), null);
  assert.equal(comboFromPitch(0, 5), null);
});

test("comboFromPitch → pitchFromCombo 全域往返（baseOct 3~7）", () => {
  for (const baseOct of [3, 4, 5, 6, 7]){
    const { min, max } = playableRange(baseOct);
    for (let p = min; p <= max; p++){
      const c = comboFromPitch(p, baseOct);
      assert.ok(c, `p=${p} baseOct=${baseOct} 应可演奏`);
      assert.equal(pitchFromCombo(c.key, c.shift, c.sharp, baseOct), p,
        `往返失败 p=${p} baseOct=${baseOct}`);
    }
    // 域外一点即不可演奏
    assert.equal(comboFromPitch(min - 1, baseOct), null);
    assert.equal(comboFromPitch(max + 1, baseOct), null);
  }
});

// ---------- 音区/音名 ----------

test("regOf / degName / pitchName", () => {
  assert.equal(regOf(60, 5), "低");
  assert.equal(regOf(72, 5), "中");
  assert.equal(regOf(84, 5), "高");
  assert.equal(regOf(96, 5), "高高");
  assert.equal(degName(73), "#do");
  assert.equal(pitchName(60), "C4");
  assert.equal(pitchName(97), "C#7");
});

// ---------- fitOctave ----------

test("fitOctave 选择入域最多的整体偏移", () => {
  assert.equal(fitOctave([], 5), 0);
  assert.equal(fitOctave([72, 74, 76], 5), 0);
  assert.equal(fitOctave([60], 7), 24);          // baseOct7 域 84..121
  assert.equal(fitOctave([84], 3), -12);         // 域 36..73，平手取 |o| 小
  assert.equal(fitOctave([60, 108], 5), 0);      // 平手：0 与 ±12/±24 同分 → 取 0
  assert.equal(fitOctave([108, 110], 5), -24);   // 84/86 双入域，-12 只入域一个
});

// ---------- buildSong ----------

test("buildSong：演示曲目展开（固定 bpm）", () => {
  const song = buildSong({
    title: "t", source: "demo", bpm: 60,
    notes: [
      { pitch: 72, startBeat: 0, durBeats: 1 },
      { pitch: 74, startBeat: 1, durBeats: 1 },
    ],
  }, 5);
  assert.equal(song.judgeableCount, 2);
  assert.equal(song.notes.length, 2);
  assert.equal(song.notes[0].startSec, 0);
  assert.equal(song.notes[1].startSec, 1);
  assert.equal(song.notes[0].durSec, 1);
  assert.equal(song.durationSec, 2);
  assert.equal(song.notes[0].reg, "中");
  assert.deepEqual(song.notes[0].combo, { key: "z", shift: 0, sharp: false });
});

test("buildSong：MIDI 传入的 startSec/durSec 优先生效", () => {
  const song = buildSong({
    title: "m", source: "midi", bpm: 120,
    notes: [{ pitch: 72, startSec: 1.5, durSec: 0.25, startBeat: 99, durBeats: 99 }],
  }, 5);
  assert.equal(song.notes[0].startSec, 1.5);
  assert.equal(song.notes[0].durSec, 0.25);
});

test("buildSong：超域音符整体移位 + 残余标免判定", () => {
  const song = buildSong({
    title: "x", source: "midi", bpm: 120,
    notes: [
      { pitch: 72, startSec: 0, durSec: 0.5 },
      { pitch: 108, startSec: 0.5, durSec: 0.5 },
      { pitch: 111, startSec: 1.0, durSec: 0.5 },
    ],
  }, 5);
  // 候选偏移：0 → 1 分；-12 → 2 分（60/96 入域）；-24 → 2 分（48 出域）；取 |o| 小的 -12
  assert.equal(song.octaveOffset, -12);
  assert.equal(song.notes[0].pitch, 60);
  assert.equal(song.notes[1].pitch, 96);
  assert.equal(song.notes[1].outOfRange, false);
  assert.deepEqual(song.notes[1].combo, { key: ",", shift: 1, sharp: false });
  assert.equal(song.notes[2].pitch, 99);
  assert.equal(song.notes[2].outOfRange, true);
  assert.equal(song.notes[2].combo, null);
  assert.ok(song.notes[2].col >= 0, "超域音符也有显示列");
  assert.equal(song.judgeableCount, 2);
});
