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
  s.startFollow(0);
  s.advanceFollow(100);                // 真实时间大步前进，时间轴停在第一音符
  assert.equal(s.followNow, 0);
  assert.equal(s.press(74, s.followNow).result, "wrong"); // 音不对，不前进
  assert.equal(s.press(72, s.followNow).result, "hit");   // 提前按也算（等待式）
  s.advanceFollow(101);                // 命中后走了 1 秒 → 停在下一音符（startSec=1）
  s.tick(s.followNow);
  assert.equal(s.followNow, 1);
  const r = s.press(74, s.followNow);
  assert.equal(r.result, "hit");
  assert.equal(r.note.pitch, 74);
  assert.equal(s.stats.wrong, 1);
  assert.equal(s.stats.combo, 2);
  s.advanceFollow(102);
  s.press(76, s.followNow);
  assert.equal(s.finished, true);
  assert.equal(s.stats.maxCombo, 3);
});

test("跟练：等待期间时间轴冻结，命中后从停靠点续走（回归：等待越久不应跳拍）", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [74, 1, 1], [76, 2, 1]]), "follow");
  s.startFollow(0);
  s.advanceFollow(8);                  // 第一音符停在 0
  assert.equal(s.followNow, 0);
  s.advanceFollow(15);                 // 等了 7 秒 —— 时间轴纹丝不动
  assert.equal(s.followNow, 0);
  s.tick(s.followNow);                 // 等待中的音符永不过期
  assert.equal(s.stats.miss, 0);
  s.press(72, s.followNow);            // 命中
  s.advanceFollow(15.5);               // 命中后 0.5 秒：下一音符（1s 处）应只走到一半
  assert.equal(s.followNow, 0.5);
  s.advanceFollow(16.0);
  assert.equal(s.followNow, 1.0);      // 恰好停靠，而不是跳到真实时间 16s
});

test("跟练：等价指法（结果音高相同）判通过", () => {
  // 高do C6：逗号 与 右+z 都产生音高 84
  const s = new PracticeSession(mkSong([[84, 0, 1]]), "follow");
  s.startFollow(0);
  assert.equal(s.press(84, -1).result, "hit"); // 主逻辑只比音高
});

test("跟练：超域音符到点自动跳过（免判定）", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [110, 1, 1], [74, 2, 1]]), "follow");
  const over = s.rt.find(n => n.outOfRange);
  assert.ok(over, "110 应为超域");
  s.startFollow(0);
  s.advanceFollow(100);
  s.press(72, s.followNow);            // 命中第一音
  assert.equal(s.nextNote().pitch, 74); // 超域音符不是 nextNote
  s.advanceFollow(102);                // 时间轴走向下一音符（2s 处）
  s.tick(s.followNow);                 // 途中扫过超域音符（1.3s 已过期）→ auto
  assert.equal(over.judged, true);
  assert.equal(over.result, "auto");
  assert.equal(s.stats.miss, 0);       // 跟练不计 miss
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
  assert.deepEqual(s.stats, { perfect: 0, good: 0, miss: 0, wrong: 0, extra: 0, combo: 0, maxCombo: 0, skipped: 0 });
});

// ---------- skipBefore（试听退出：略过已播过的音符） ----------

test("skipBefore：t 之前的未判定音符记为跳过，不计入下一音与准确率分母", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [74, 1, 1], [76, 2, 1], [77, 3, 1]]), "rhythm");
  s.press(72, 0);          // 第 1 音 perfect
  s.skipBefore(2.5);       // 跳过 74(1s)、76(2s)
  assert.equal(s.stats.skipped, 2);
  assert.equal(s.stats.perfect, 1);
  assert.equal(s.nextNote().pitch, 77);
  assert.equal(s.accuracy(), 1 / 2); // 分母 = judgeableCount(4) - skipped(2)
  assert.equal(s.finished, false);
  s.press(77, 3);
  assert.equal(s.finished, true);
});

test("skipBefore：已判定音符不受影响；t 之后的音符不被跳过", () => {
  const s = new PracticeSession(mkSong([[72, 0, 1], [74, 2, 1]]), "rhythm");
  s.skipBefore(1.5);       // 仅 72@0 在 1.5 之前
  assert.equal(s.stats.skipped, 1);
  assert.equal(s.rt[0].result, "skip");
  assert.equal(s.rt[1].judged, false);
  assert.equal(s.nextNote().pitch, 74);
});

test("skipBefore：t 之前的超域音符结清为 auto，不计入跳过与分母", () => {
  const song = buildSong({
    title: "x", source: "midi", bpm: 60,
    notes: [
      { pitch: 72, startSec: 0, durSec: 0.5 },
      { pitch: 130, startSec: 0.5, durSec: 0.5 }, // 超域
      { pitch: 74, startSec: 1, durSec: 0.5 },
    ],
  }, 5);
  const s = new PracticeSession(song, "rhythm");
  assert.equal(song.judgeableCount, 2);
  s.skipBefore(0.9);
  assert.equal(s.stats.skipped, 1);                        // 只算可判定的 72
  assert.equal(s.rt.find(n => n.outOfRange).result, "auto");
  assert.equal(s.accuracy(), 0 / 1);                       // 分母 = 2 - 1
});
