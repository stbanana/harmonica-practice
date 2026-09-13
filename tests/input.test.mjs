import { test } from "node:test";
import assert from "node:assert/strict";
import { InputController } from "../js/input.js";

// input.js 在构造时绑定 document/window，这里给最小事件靶子以便在 Node 下跑
function mkTarget(){
  const map = new Map();
  return {
    addEventListener(type, fn){
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(fn);
    },
    fire(type, ev){
      for (const fn of map.get(type) || []) fn(ev);
    },
  };
}

function mkAudio(){
  const log = [];
  return {
    log,
    ensure(){},
    noteOn(p){ log.push(["on", p]); },
    noteOff(){ log.push(["off"]); },
  };
}

// 每个用例独立一套 DOM 靶子，避免上一个控制器的监听器串台
function mkInput(baseOct = 5){
  const audio = mkAudio();
  const target = mkTarget();
  globalThis.document = target;
  globalThis.window = target;
  return { input: new InputController({ audio, baseOct }), audio, target };
}

const mouseEv = button => ({ button, target: {}, preventDefault(){} });

const DO = 72, RE = 74, SHARP_DO = 73, LOW_DO = 60;

test("叠按后松开旧键不重播仍按住的音（回归：会听到两声）", () => {
  const { input, audio } = mkInput();
  input.pressKey("z");
  input.pressKey("x");
  assert.deepEqual(audio.log, [["on", DO], ["on", RE]]);
  audio.log.length = 0;
  input.releaseKey("z");
  assert.deepEqual(audio.log, [], "re 还按着且音高没变，不该有任何发声动作");
  assert.equal(input.activeKey(), "x");
});

test("松开栈顶键回落到下面的键并重触发", () => {
  const { input, audio } = mkInput();
  input.pressKey("z");
  input.pressKey("x");
  audio.log.length = 0;
  input.releaseKey("x");
  assert.deepEqual(audio.log, [["on", DO]]);
});

test("全部松开则收音", () => {
  const { input, audio } = mkInput();
  input.pressKey("z");
  audio.log.length = 0;
  input.releaseKey("z");
  assert.deepEqual(audio.log, [["off"]]);
  assert.equal(input.soundingPitch, null);
});

test("重按同一个键仍然重触发，起音不被吞", () => {
  const { input, audio } = mkInput();
  input.pressKey("z");
  input.releaseKey("z");
  audio.log.length = 0;
  input.pressKey("z");
  assert.deepEqual(audio.log, [["on", DO]]);
});

test("修饰键改变音高时切音重触发", () => {
  const { input, audio, target } = mkInput();
  input.pressKey("z");
  audio.log.length = 0;
  target.fire("mousedown", mouseEv(1));
  assert.deepEqual(audio.log, [["on", SHARP_DO]]);
  target.fire("mouseup", mouseEv(1));
  assert.deepEqual(audio.log, [["on", SHARP_DO], ["on", DO]]);
});

test("锁定灯已生效时按同向鼠标键不重触发（回归）", () => {
  const { input, audio, target } = mkInput();
  input.setLatch("shift", -1);
  input.pressKey("z");
  assert.deepEqual(audio.log, [["on", LOW_DO]]);
  audio.log.length = 0;
  target.fire("mousedown", mouseEv(0));
  target.fire("mouseup", mouseEv(0));
  assert.deepEqual(audio.log, [], "左键与锁定灯同为低八度，音高没变");
});

test("没有按住键时改修饰键不发声", () => {
  const { audio, target } = mkInput();
  target.fire("mousedown", mouseEv(1));
  assert.deepEqual(audio.log.filter(([kind]) => kind === "on"), []);
});

test("releaseAll 清空发声状态", () => {
  const { input, audio } = mkInput();
  input.pressKey("z");
  audio.log.length = 0;
  input.releaseAll(true);
  assert.deepEqual(audio.log, [["off"]]);
  assert.equal(input.soundingPitch, null);
  assert.deepEqual(input.held, []);
});
