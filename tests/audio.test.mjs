import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleUrl, samplePitches, SAMPLE_MIN, SAMPLE_MAX } from "../js/audio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_DIR = path.join(root, "audio", "harmonica");

test("采样音高范围：59..97 连续 39 个", () => {
  const ps = samplePitches();
  assert.equal(SAMPLE_MIN, 59);
  assert.equal(SAMPLE_MAX, 97);
  assert.equal(ps.length, 39);
  assert.equal(ps[0], 59);
  assert.equal(ps[ps.length - 1], 97);
});

test("sampleUrl 生成正确文件名（升号写作 s）", () => {
  assert.equal(sampleUrl(59), "audio/harmonica/Harmonica_B3.ogg");
  assert.equal(sampleUrl(60), "audio/harmonica/Harmonica_C4.ogg");
  assert.equal(sampleUrl(70), "audio/harmonica/Harmonica_As4.ogg");
  assert.equal(sampleUrl(72), "audio/harmonica/Harmonica_C5.ogg");
  assert.equal(sampleUrl(84), "audio/harmonica/Harmonica_C6.ogg");
  assert.equal(sampleUrl(96), "audio/harmonica/Harmonica_C7.ogg");
  assert.equal(sampleUrl(97), "audio/harmonica/Harmonica_Cs7.ogg");
});

test("磁盘采样与映射一一对应（无缺口、无多余）", () => {
  const files = new Set(fs.readdirSync(SAMPLE_DIR));
  const expected = samplePitches().map(p => path.basename(sampleUrl(p)));
  assert.equal(new Set(expected).size, 39, "映射存在重复文件名");
  const missing = expected.filter(f => !files.has(f));
  assert.deepEqual(missing, [], "缺失采样文件");
  const extra = [...files].filter(f => f.endsWith(".ogg") && !expected.includes(f));
  assert.deepEqual(extra, [], "多余的采样文件");
});
