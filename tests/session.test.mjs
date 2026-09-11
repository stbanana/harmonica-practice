import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeSession } from "../js/session.js";
import { buildSong } from "../js/music.js";

const mkSong = (rawNotes, baseOct = 5) => buildSong({
  title: "t", source: "demo", bpm: 60,
  notes: rawNotes.map(([pitch, startBeat, durBeats]) => ({ pitch, startBeat, durBeats })),
}, baseOct);

// ---------- 跟练模式 ----------

test("跟练：按对才前进，提前按也算", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [74, 1, 1], [76, 2, 1]]), "follow");
  // 时钟钳制在下一音符
  assert.equal(s.clampClock(100), 0);
  assert.equal(s.press(74, -5).result, "wrong"); // 音不对，不前进
  assert.equal(s.press(72, -5).result, "hit");   // 提前按也算（等待式）
  assert.equal(s.clampClock(100), 1);
  const r = s.press(74, 0.5);
  assert.equal(r.result, "hit");
  assert.equal(r.note.pitch, 74);
  assert.equal(s.stats.wrong, 1);
  assert.equal(s.stats.combo, 2);
  s.press(76, 2);
  assert.equal(s.finished, true);
  assert.equal(s.stats.maxCombo, 3);
});

test("跟练：等价指法（结果音高相同）判通过", () => {
  // 高do C6：逗号 与 右+z 都产生音高 84
  const s = new PracticeSession(mkSong([[84, 0, 1]]), "follow");
  assert.equal(s.press(84, -1).result, "hit"); // 主逻辑只比音高
});

test("跟练：超域音符到点自动跳过（免判定）", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [110, 1, 1], [74, 2, 1]]), "follow");
  // 110 超域 → outOfRange；fitOctave 不会移（72/74 已是主域）…若移位则此测试调整
  const over = s.rt.find(n => n.outOfRange);
  assert.ok(over, "110 应为超域");
  s.press(72, 0);
  assert.equal(s.nextNote().pitch, 74); // 超域音符不是 nextNote
  s.tick(5);                            // 钳制外的真实时间扫过它
  assert.equal(over.judged, true);
  assert.equal(over.result, "auto");
  assert.equal(s.stats.miss, 0);        // 跟练不计 miss
});

// ---------- 节奏模式 ----------

test("节奏：判定窗 perfect/good/miss/extra", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [74, 1, 1]]), "rhythm");
  let r = s.press(72, 0.02);
  assert.equal(r.result, "perfect");
  assert.equal(Math.abs(r.deltaMs), 20);
  r = s.press(74, 1.2);   // +200ms → good
  assert.equal(r.result, "good");
  assert.equal(s.stats.perfect, 1);
  assert.equal(s.stats.good, 1);
  assert.equal(s.stats.combo, 2);
  assert.equal(s.finished, true);
});

test("节奏：窗口过期未按 → miss 并断连击", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1]]), "rhythm");
  s.press(72, -0.1); // 提前 100ms → good
  assert.equal(s.stats.good, 1);
  const s2 = new PracticeSession(mkSong([[72, 0, 1], [74, 1, 1]]), "rhythm");
  s2.tick(0.5);      // 第一个音符过期
  assert.equal(s2.stats.miss, 1);
  assert.equal(s2.rt[0].result, "miss");
  s2.press(72, 0.8); // 已过期的不再可判
  assert.equal(s2.press(72, 0.8).result, "extra");
});

test("节奏：多余按键计数但不断连击", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1]]), "rhythm");
  assert.equal(s.press(67, 0).result, "extra");
  assert.equal(s.stats.extra, 1);
  assert.equal(s.stats.combo, 0);
  s.press(72, 0.01);
  assert.equal(s.stats.combo, 1);
});

test("节奏：音高相同的相邻音符各判各的", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [72, 1, 1]]), "rhythm");
  assert.equal(s.press(72, 0).result, "perfect");
  assert.equal(s.press(72, 1).result, "perfect");
  assert.equal(s.press(72, 2).result, "extra"); // 都已判定
  assert.equal(s.finished, true);
});

test("准确率与评分公式", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [74, 1, 1], [76, 2, 1], [77, 3, 1], [79, 4, 1]]), "rhythm");
  s.press(72, 0);      // perfect 100
  s.press(74, 1.1);    // good 60
  s.press(76, 2.2);    // good 60
  s.tick(4.5);         // 77、79 miss（窗口 4.3 全过期）
  assert.equal(s.score(), 220);
  assert.equal(s.accuracy(), (1 + 0.6 * 2) / 5);
  assert.equal(s.stats.miss, 2);
  assert.equal(s.stats.maxCombo, 3);
});

test("重练 reset 恢复初始状态", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1]]), "rhythm");
  s.press(72, 0);
  assert.equal(s.finished, true);
  s.reset();
  assert.equal(s.finished, false);
  assert.equal(s.rt[0].judged, false);
  assert.deepEqual(s.stats, { perfect: 0, good: 0, miss: 0, wrong: 0, extra: 0, combo: 0, maxCombo: 0 });
});
