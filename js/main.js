// 主控制器 —— 模式切换、曲目管理、时钟、判定接线、HUD、设置持久化。

import { audio } from "./audio.js";
import { InputController } from "./input.js";
import { Waterfall } from "./waterfall.js";
import { PracticeSession } from "./session.js";
import { SheetView } from "./sheetview.js";
import { parseMidi, buildSongFromMidi, summarizeChannels } from "./midi.js";
import {
  PHYS_KEYS, KEY_DEG, NAME12, DEG,
  pitchName, degName, regOf,
} from "./music.js";

const $ = id => document.getElementById(id);

// ---------- 状态 ----------
const settings = (() => {
  try { return JSON.parse(localStorage.getItem("hp_settings")) || {}; }
  catch (e) { return {}; }
})();

const state = {
  mode: ["free", "waterfall", "sheet"].includes(settings.lastMode) ? settings.lastMode : "free",
  sub: "rhythm",
  baseOct: 5,        // 固定「中音do = C5」，与采样音域（MIDI 59–97）对齐
  speed: settings.speed ?? 1,
  themeMode: ["auto", "dark", "light"].includes(settings.theme) ? settings.theme : "auto",
  rawSongs: [],      // {id, title, build(baseOct) → Song}
  currentIdx: 0,
  song: null,
  session: null,
  started: false,
  overlayShown: false,
  auditioning: false,   // 试听（自动演奏）状态
  auditionNote: null,   // 试听中当前正在发声的音符对象（用于判断是否需要重新起音）
};

// ---------- 时钟（速度倍率作用于歌曲时间；判定在歌曲时间轴上进行） ----------
const clock = {
  base: 0, speed: state.speed, leadIn: 3,
  playing: false, pausedAt: -3, prevA: null, prevN: 0,

  start(){
    this.base = audio.now();
    this.playing = true;
    this.prevA = null;
  },
  pause(){ this.pausedAt = this.songNow(); this.playing = false; },
  resume(){ this.base = audio.now() - (this.pausedAt + this.leadIn) / this.speed; this.playing = true; this.prevA = null; },
  stop(){ this.playing = false; this.pausedAt = -this.leadIn; },
  setSpeed(s){
    if (this.playing){
      const n = this.songNow();
      this.speed = s;
      this.base = audio.now() - (n + this.leadIn) / s;
      this.prevA = null;
    } else this.speed = s;
  },
  songNow(){
    const a = audio.now();
    if (!this.playing){ this.prevA = a; return this.pausedAt; }
    let n = (a - this.base) * this.speed - this.leadIn;
    if (this.prevA !== null && Math.abs(a - this.prevA) > 2){
      n = this.prevN; // 时间线跳变（performance → AudioContext），保持歌曲时间连续
      this.base = a - (n + this.leadIn) / this.speed;
    }
    this.prevA = a; this.prevN = n;
    return n;
  },
  // 重定基：让 songNow() 等于 t（切换时间线来源时用，保持进度不跳变）
  setSongTime(t){
    this.base = audio.now() - (t + this.leadIn) / this.speed;
    this.prevA = null; this.prevN = t; this.pausedAt = t;
  },
};

// ---------- DOM ----------
const els = {
  tabs: [...document.querySelectorAll("#modeTabs .tab")],
  subBtns: [...document.querySelectorAll("#practiceSeg button")],
  volumeRange: $("volumeRange"), muteBtn: $("muteBtn"),
  themeBtn: $("themeBtn"), panicBtn: $("panicBtn"),
  songSel: $("songSel"), importMidiBtn: $("importMidiBtn"), midiFile: $("midiFile"),
  channelWrap: $("channelWrap"), channelSel: $("channelSel"),
  speedSel: $("speedSel"), playBtn: $("playBtn"), resetBtn: $("resetBtn"), auditionBtn: $("auditionBtn"),
  hud: $("hud"), hudProgressBar: $("hudProgressBar"), hudProgress: $("hudProgress"),
  hudCombo: $("hudCombo"), hudAcc: $("hudAcc"), hudScore: $("hudScore"),
  freeStage: $("freeStage"), nowNameBig: $("nowNameBig"), nowComboBig: $("nowComboBig"),
  pianoStrip: $("pianoStrip"),
  wfCanvas: $("wfCanvas"),
  endOverlay: $("endOverlay"), endTitle: $("endTitle"), endStats: $("endStats"),
  endRestartBtn: $("endRestartBtn"), endCloseBtn: $("endCloseBtn"),
  sheetViewer: $("sheetViewer"), sheetImg: $("sheetImg"),
  importSheetBtn: $("importSheetBtn"), sheetFile: $("sheetFile"), clearSheetBtn: $("clearSheetBtn"),
  zoomInBtn: $("zoomInBtn"), zoomOutBtn: $("zoomOutBtn"), fitBtn: $("fitBtn"), resetViewBtn: $("resetViewBtn"),
  nowName: $("nowName"), nowCombo: $("nowCombo"),
  gate: $("gate"), gateBar: $("gateBar"), gateText: $("gateText"),
  gateTitle: $("gateTitle"), gateRetry: $("gateRetry"),
  lampLeft: $("lampLeft"), lampRight: $("lampRight"), lampMid: $("lampMid"),
  virtualKeys: $("virtualKeys"),
  toast: $("toast"),
};

const waterfall = new Waterfall(els.wfCanvas);
const keyCells = new Map(); // key → .gkey 元素

// ---------- Toast ----------
let toastTimer;
function toast(msg){
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2400);
}

// ---------- 设置持久化 ----------
let saveTimer;
function saveSettings(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("hp_settings", JSON.stringify({
        volume: +els.volumeRange.value,
        muted: audio.muted,
        speed: clock.speed,
        theme: state.themeMode,
        lastMode: state.mode,
      }));
    } catch (e) {}
  }, 300);
}

// ---------- 输入 ----------
const input = new InputController({ audio, baseOct: state.baseOct, onEvent: handleInput });

function handleInput(e){
  refreshNowDisplay(e.snapshot);
  if (e.type === "keyonset" && state.mode === "waterfall" && clock.playing && state.session && !state.auditioning){
    judgePress(e);
  }
}

function refreshNowDisplay(s){
  let name = "—", combo = "等待按键…";
  if (s.activeKey){
    const p = s.pitch, reg = regOf(p, state.baseOct);
    name = reg + degName(p) + "  " + pitchName(p);
    const mods = [];
    if (s.shift === -1) mods.push("按住左键");
    else if (s.shift === 1) mods.push("按住右键");
    if (s.sharp) mods.push("中键(升半音)");
    mods.push(s.activeKey === "," ? "键[，]" : "键[" + s.activeKey.toUpperCase() + "]");
    combo = "按下 " + mods.join(" + ") + " = " + pitchName(p) + "（" + reg + "音区）";
  }
  els.nowName.textContent = name;
  els.nowCombo.textContent = combo;
  els.nowNameBig.textContent = name;
  els.nowComboBig.textContent = combo;

  els.lampLeft.classList.toggle("on-left", s.shift === -1);
  els.lampRight.classList.toggle("on-right", s.shift === 1);
  els.lampMid.classList.toggle("on-mid", s.sharp);
  els.lampLeft.classList.toggle("latched", s.latch.shift === -1);
  els.lampRight.classList.toggle("latched", s.latch.shift === 1);
  els.lampMid.classList.toggle("latched", s.latch.sharp);

  for (const [k, el] of keyCells) el.classList.toggle("down", s.held.includes(k));
  if (state.mode === "free") highlightPiano(s.pitch);
}

function judgePress(e){
  const now = state.sub === "follow" ? state.session.followNow : clock.songNow();
  const r = state.session.press(e.pitch, now);
  if (r.result === "hit" || r.result === "perfect" || r.result === "good"){
    const color = r.result === "perfect" ? "#f5b041" : "#3fa573";
    waterfall.ring(r.note.col, color);
    const label = state.sub === "follow"
      ? "命中！"
      : (r.result === "perfect" ? `PERFECT ${fmtDelta(r.deltaMs)}` : `GOOD ${fmtDelta(r.deltaMs)}`);
    waterfall.flashText(label, color);
  } else if (r.result === "wrong"){
    waterfall.colFlash(PHYS_KEYS.indexOf(e.key), "#c0392b");
    waterfall.flashText("指法不对", "#c0392b");
    shakeKey(e.key);
  }
  // extra：节奏模式的多余按键仅计数，不打断
}

function fmtDelta(ms){
  return (ms >= 0 ? "+" : "−") + Math.abs(ms) + "ms";
}

function shakeKey(key){
  const el = keyCells.get(key);
  if (!el) return;
  el.classList.remove("shake");
  void el.offsetWidth; // 重启动画
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 350);
}

// ---------- 曲目 ----------
const BUILTIN_SONGS = [
  { id: "see-you-again", title: "See You Again", file: "See You Again.mid" },
  { id: "yilu-xiangbei", title: "一路向北",      file: "一路向北.mid" },
  { id: "chun-riying", title: "春日影",      file: "春日影.mid" },
];

// 统一入口：内置曲目与导入的 MIDI 走同一构造与解析路径
function makeMidiEntry({ id, title, parsed }){
  return {
    id, title, parsed, channelSel: undefined,
    build(baseOct){ return buildSongFromMidi(this.parsed, this.channelSel, baseOct, this.title); },
  };
}

// 启动时拉取并解析内置 MIDI；单个失败跳过并提示、不抛出（幂等：重试时不重复添加）
async function initSongs(){
  for (const s of BUILTIN_SONGS){
    if (state.rawSongs.some(e => e.id === s.id)) continue;
    try {
      const res = await fetch(encodeURI("audio/songs/" + s.file));
      if (!res.ok) throw new Error("HTTP " + res.status);
      const parsed = parseMidi(await res.arrayBuffer());
      if (!parsed.tracks.length) throw new Error("没有可用音符");
      state.rawSongs.push(makeMidiEntry({ id: s.id, title: s.title, parsed }));
    } catch (err) {
      toast(`内置曲目「${s.title}」加载失败：${err.message}`);
    }
  }
  rebuildSongSel();
}

function rebuildSongSel(){
  els.songSel.innerHTML = "";
  state.rawSongs.forEach((s, i) => {
    const op = document.createElement("option");
    op.value = i; op.textContent = s.title;
    els.songSel.appendChild(op);
  });
  els.songSel.value = state.currentIdx;
}

function loadSong(idx){
  if (idx < 0 || idx >= state.rawSongs.length) return;
  state.currentIdx = idx;
  const entry = state.rawSongs[idx];
  state.song = entry.build(state.baseOct);
  els.songSel.value = idx;
  rebuildChannelSel(entry);
  resetSession();
}

function resetSession(){
  clock.stop();
  clock.leadIn = state.sub === "rhythm" ? 3 : 2;
  clock.pausedAt = -clock.leadIn;
  state.session = state.song ? new PracticeSession(state.song, state.sub) : null;
  if (state.session) state.session.startFollow(-clock.leadIn);
  state.started = false;
  state.overlayShown = false;
  hideOverlay();
  clearTargetHighlight();
  clearAudition();
  updatePlayBtn();
  lastHudKey = "";
}

function restartSession(){
  state.session.reset();
  state.session.startFollow(-clock.leadIn);
  state.overlayShown = false;
  hideOverlay();
  state.started = true;
  clock.start();
  updatePlayBtn();
}

// ---------- 播放控制 ----------
function togglePlay(){
  if (!state.session || !state.song) return;
  if (state.auditioning){ stopAudition(true); return; } // 行为3：点「开始」退出试听并继续练习
  if (!state.started){
    state.started = true;
    audio.ensure();
    clock.start();
  } else if (clock.playing){
    clock.pause();
  } else if (state.session.finished){
    restartSession();
    return;
  } else {
    audio.ensure();
    clock.resume();
    state.session.syncFollowWall(); // 跟练时间轴以恢复时刻为新基准，避免大步跳进
  }
  updatePlayBtn();
}

// 空格键 = 「开始/暂停」传输控制，与播放按钮一致（含试听态：退出试听进入练习）
function updatePlayBtn(){
  els.playBtn.textContent = state.auditioning
    ? "▶ 开始练习"
    : (!state.started ? "▶ 开始" : (clock.playing ? "⏸ 暂停" : "▶ 继续"));
}

function updateAuditionBtn(){
  els.auditionBtn.classList.toggle("active", state.auditioning);
  els.auditionBtn.textContent = state.auditioning ? "试听中" : "试听";
}

// ---------- 试听（自动演奏） ----------
// 当前歌曲时间：练习+跟练走事件驱动时间轴，其余（含试听）走连续时钟
function songTime(){
  return (state.sub === "follow" && !state.auditioning)
    ? state.session.followNow
    : clock.songNow();
}

// 最后一个 startSec <= now 且尚未结束的音符（单声部当前应发声音）
function currentAuditionNote(now){
  if (!state.session) return null;
  let last = null;
  for (const n of state.session.rt){
    if (n.startSec > now) break;
    last = n;
  }
  return (last && now < last.startSec + last.durSec) ? last : null;
}

function updateAuditionAudio(now){
  const n = currentAuditionNote(now);
  if (n === state.auditionNote) return; // 仍是同一音符（含 null）→ 不动
  state.auditionNote = n;
  const p = (n && audio.has(n.pitch)) ? n.pitch : null; // 无采样的音视为静音
  if (p === null) audio.noteOff(0.06);
  else audio.noteOn(p); // 即使音高与上一音相同也重新起音，还原「连续按下」的听感
}

function startAudition(){
  if (!state.session || !state.song || state.auditioning) return;
  audio.ensure();
  let t;
  if (!state.started || state.session.finished){
    // 未开始（或已结束）：从头，含预备倒数
    state.session.reset();
    state.session.startFollow(-clock.leadIn);
    state.overlayShown = false;
    hideOverlay();
    t = -clock.leadIn;
  } else {
    t = songTime(); // 行为2：沿用当前进度，不从头
  }
  state.started = true;
  state.auditioning = true;
  state.auditionNote = null;
  input.setEnabled(false);
  document.body.classList.add("auditioning");
  clock.setSongTime(t);
  clock.playing = true;
  clearTargetHighlight();
  updatePlayBtn(); updateAuditionBtn();
}

// 退出试听回到练习：resume=true 继续播放（点「开始」），false 暂停等待（再点「试听」）
function stopAudition(resume){
  if (!state.auditioning) return;
  const t = clock.songNow();
  state.auditioning = false;
  state.auditionNote = null;
  audio.noteOff(0.05);
  input.setEnabled(true);
  document.body.classList.remove("auditioning");
  state.session.skipBefore(t); // 试听略过的音符记为「跳过」，不计入准确率
  state.started = true;
  updateAuditionBtn();
  if (state.session.finished){ // 已播到结尾：直接从头重练
    restartSession();
    return;
  }
  if (state.sub === "follow"){
    state.session.followNow = t;
    state.session.syncFollowWall();
  }
  clock.setSongTime(t);
  clock.playing = !!resume;
  clearTargetHighlight();
  updatePlayBtn();
}

// 无条件清理试听态（重置会话、离开瀑布流模式时用）
function clearAudition(){
  if (state.auditioning){
    state.auditioning = false;
    state.auditionNote = null;
    audio.noteOff(0.05);
  }
  if (!input.enabled) input.setEnabled(true);
  document.body.classList.remove("auditioning");
  updateAuditionBtn();
}

// 试听播放到曲终：退出试听并回到初始态（按键恢复、按钮复位，可再次开始或试听）
function endAudition(){
  clock.stop();
  state.auditionNote = null;
  state.auditioning = false;
  audio.noteOff(0.05);
  if (!input.enabled) input.setEnabled(true);
  document.body.classList.remove("auditioning");
  resetSession(); // 重置会话 + 清高亮 + 刷新按钮（含 updateAuditionBtn）
  toast("试听结束");
}

// ---------- HUD ----------
let lastHudKey = "";
function updateHUD(){
  const s = state.session;
  if (!s) return;
  const acc = s.accuracy();
  const key = [s.progress(), s.stats.combo, acc === null ? -1 : acc.toFixed(3), s.score()].join("|");
  if (key === lastHudKey) return;
  lastHudKey = key;
  els.hudProgress.textContent = s.progress() + "%";
  els.hudProgressBar.style.width = s.progress() + "%";
  els.hudCombo.textContent = s.stats.combo;
  els.hudAcc.textContent = acc === null ? "—" : Math.round(acc * 100) + "%";
  els.hudScore.textContent = s.score();
}

let lastTargetCol = -1, lastTargetLamps = "";
function updateTargetHighlight(now){
  // 仅在会话已开始时高亮：练习时高亮「下一音」，试听时高亮「正在吹」的音
  let n = null;
  if (state.started && state.session){
    n = state.auditioning ? currentAuditionNote(now) : state.session.nextNote();
  }
  const col = n ? n.col : -1;
  const lampKey = n && n.combo ? `${n.combo.shift}|${n.combo.sharp}` : "";
  if (col === lastTargetCol && lampKey === lastTargetLamps) return;
  lastTargetCol = col; lastTargetLamps = lampKey;
  for (const [, el] of keyCells) el.classList.remove("target");
  if (n && n.combo) keyCells.get(n.combo.key).classList.add("target");
  els.lampLeft.classList.toggle("hint-left", !!(n && n.combo && n.combo.shift === -1));
  els.lampRight.classList.toggle("hint-right", !!(n && n.combo && n.combo.shift === 1));
  els.lampMid.classList.toggle("hint-mid", !!(n && n.combo && n.combo.sharp));
}

// 清空按键行/修饰灯上的高亮（退出瀑布流、重置会话时调用），避免高亮残留
function clearTargetHighlight(){
  lastTargetCol = -1; lastTargetLamps = "";
  for (const [, el] of keyCells) el.classList.remove("target");
  els.lampLeft.classList.remove("hint-left");
  els.lampRight.classList.remove("hint-right");
  els.lampMid.classList.remove("hint-mid");
}

// ---------- 结算 ----------
function checkFinish(now){
  const s = state.session;
  if (!s || state.overlayShown || !s.finished) return;
  if (now < state.song.durationSec + 0.4) return;
  clock.pause();
  showEndOverlay();
  updatePlayBtn();
}

function showEndOverlay(){
  state.overlayShown = true;
  const s = state.session, st = s.stats;
  const auto = s.rt.filter(n => n.result === "auto").length;
  const rows = [];
  const add = (dt, dd) => rows.push(`<dt>${dt}</dt><dd>${dd}</dd>`);
  if (state.sub === "follow"){
    add("命中", st.perfect);
    add("错按", st.wrong);
    add("免判定（超音域）", auto);
    add("最大连击", st.maxCombo);
  } else {
    add("Perfect", st.perfect);
    add("Good", st.good);
    add("Miss", st.miss);
    add("错按（音不对）", st.wrong);
    add("多余按键", st.extra);
    add("准确率", Math.round((s.accuracy() || 0) * 100) + "%");
    add("最大连击", st.maxCombo);
    add("评分", s.score());
  }
  if (st.skipped) add("跳过", st.skipped);
  els.endStats.innerHTML = rows.join("");
  els.endTitle.textContent = state.sub === "follow" ? "练习完成！" : "演奏完成！";
  els.endOverlay.classList.remove("hidden");
}

function hideOverlay(){
  els.endOverlay.classList.add("hidden");
  state.overlayShown = false;
}

// ---------- MIDI 导入 ----------
async function importMidiFile(file){
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseMidi(buf);
    if (!parsed.tracks.length) throw new Error("文件里没有可用音符");
    const entry = makeMidiEntry({
      id: "midi-" + Date.now(),
      title: file.name.replace(/\.(mid|midi)$/i, "") || "MIDI 曲目",
      parsed,
    });
    state.rawSongs.push(entry);
    rebuildSongSel();
    loadSong(state.rawSongs.length - 1);
    toast(`已导入「${entry.title}」`);
  } catch (err) {
    toast("导入失败：" + err.message);
  }
}

function rebuildChannelSel(entry){
  const sel = els.channelSel;
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "auto"; auto.textContent = "自动选择";
  sel.appendChild(auto);
  for (const c of summarizeChannels(entry.parsed)){
    const op = document.createElement("option");
    op.value = c.channel;
    op.textContent = `通道 ${c.channel}（${c.noteCount} 音）`;
    sel.appendChild(op);
  }
  const merge = document.createElement("option");
  merge.value = "merge"; merge.textContent = "合并全部通道";
  sel.appendChild(merge);
  sel.value = entry.channelSel === undefined ? "auto" : String(entry.channelSel);
}

// ---------- 简谱模式 ----------
const sheetView = new SheetView(els.sheetViewer, {
  img: els.sheetImg, onToast: toast, onChange: () => {},
});

document.addEventListener("paste", e => {
  if (state.mode === "sheet") sheetView.handlePaste(e);
});

// ---------- 模式切换 ----------
function setMode(mode){
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  els.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === mode));
  els.hud.hidden = mode !== "waterfall";
  if (mode !== "waterfall"){
    clock.stop();
    state.started = false;
    clearTargetHighlight();
    clearAudition();
    updatePlayBtn();
  } else {
    if (!state.song) loadSong(state.currentIdx);
    requestAnimationFrame(() => waterfall.resize());
  }
  saveSettings();
}

// ---------- 渲染循环 ----------
function frame(){
  requestAnimationFrame(frame);
  const animT = performance.now() / 1000;
  if (state.mode === "waterfall" && state.session){
    if (clock.playing && state.sub === "follow" && !state.auditioning){
      state.session.advanceFollow(animT, clock.speed);
    }
    const now = songTime();
    if (clock.playing && !state.auditioning) state.session.tick(now);
    if (clock.playing && state.auditioning){
      updateAuditionAudio(now);
      if (now > state.song.durationSec + 0.5) endAudition();
    }
    waterfall.render(now, state.session, { animT, playing: clock.playing, started: state.started, auditioning: state.auditioning });
    updateHUD();
    updateTargetHighlight(now);
    if (!state.auditioning) checkFinish(now);
  }
}
requestAnimationFrame(frame);

// ---------- 自由模式：音高条与虚拟键（移植原测试台） ----------
function rebuildStrip(){
  els.pianoStrip.innerHTML = "";
  const rows = [
    { reg: "低", label: "低八度" },
    { reg: "中", label: "中音" },
    { reg: "高", label: "高八度" },
    { reg: "高高", label: "高高音区" },
  ];
  const minP = state.baseOct * 12;          // 低音do
  const maxP = (state.baseOct + 3) * 12 + 1; // 高高音#do
  for (const { reg, label } of rows){
    const row = document.createElement("div");
    row.className = "strip-row";
    const lab = document.createElement("span");
    lab.className = "strip-label reg-" + (reg === "低" ? "low" : reg === "中" ? "mid" : reg === "高" ? "high" : "top");
    lab.textContent = label;
    row.appendChild(lab);
    const keys = document.createElement("div");
    keys.className = "piano";
    for (let p = minP; p <= maxP; p++){
      if (regOf(p, state.baseOct) !== reg) continue;
      const el = document.createElement("div");
      el.className = "pk" + (NAME12[p % 12].includes("#") ? " sharps" : "");
      el.dataset.p = p;
      el.textContent = pitchName(p);
      el.title = reg + degName(p) + " (" + pitchName(p) + ")";
      keys.appendChild(el);
    }
    row.appendChild(keys);
    els.pianoStrip.appendChild(row);
  }
}

function highlightPiano(p){
  document.querySelectorAll(".pk").forEach(el => {
    el.classList.toggle("on", p !== null && parseInt(el.dataset.p, 10) === p);
  });
}

function buildVirtualKeys(){
  PHYS_KEYS.forEach(k => {
    const d = document.createElement("div");
    d.className = "gkey";
    const nm = k === "," ? "高do" : DEG[KEY_DEG[k]];
    const kbd = k === "," ? "，" : k.toUpperCase();
    d.innerHTML = `<kbd>${kbd}</kbd><span class="nm">${nm}</span>`;
    // preventDefault 会抑制兼容鼠标事件，鼠标点虚拟键不会触发修饰键（与原版一致）
    d.addEventListener("pointerdown", ev => { ev.preventDefault(); input.pressKey(k); });
    d.addEventListener("pointerup", () => input.releaseKey(k));
    d.addEventListener("pointerleave", () => {
      if (input.held.includes(k)) input.releaseKey(k);
    });
    keyCells.set(k, d);
    els.virtualKeys.appendChild(d);
  });
}

// ---------- 控件绑定 ----------
els.tabs.forEach(t => t.addEventListener("click", () => setMode(t.dataset.tab)));

els.subBtns.forEach(b => b.addEventListener("click", () => {
  if (state.sub === b.dataset.sub) return;
  state.sub = b.dataset.sub;
  els.subBtns.forEach(x => x.classList.toggle("active", x === b));
  if (state.mode === "waterfall" && state.song) resetSession();
}));

els.volumeRange.addEventListener("input", e => {
  audio.setVolume(+e.target.value / 100);
  saveSettings();
});
if (settings.volume !== undefined) els.volumeRange.value = settings.volume;

els.muteBtn.addEventListener("click", () => {
  audio.setMuted(!audio.muted);
  els.muteBtn.classList.toggle("active", audio.muted);
  els.muteBtn.textContent = audio.muted ? "已静音" : "静音";
  saveSettings();
});

const themeLabels = { auto: "主题：自动", dark: "主题：深色", light: "主题：浅色" };
function applyTheme(mode){
  state.themeMode = mode;
  const dark = mode === "dark" || (mode === "auto" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  els.themeBtn.textContent = themeLabels[mode];
  saveSettings();
}
els.themeBtn.addEventListener("click", () => {
  applyTheme({ auto: "dark", dark: "light", light: "auto" }[state.themeMode]);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.themeMode === "auto") applyTheme("auto"); // 跟随系统切换
});

els.panicBtn.addEventListener("click", () => input.releaseAll(true));

els.songSel.addEventListener("change", e => loadSong(+e.target.value));

els.importMidiBtn.addEventListener("click", () => els.midiFile.click());
els.midiFile.addEventListener("change", e => {
  const f = e.target.files[0];
  if (f) importMidiFile(f);
  e.target.value = "";
});

els.channelSel.addEventListener("change", e => {
  const entry = state.rawSongs[state.currentIdx];
  if (!entry || !entry.parsed) return;
  const v = e.target.value;
  entry.channelSel = v === "auto" ? undefined : (v === "merge" ? "merge" : +v);
  loadSong(state.currentIdx);
});

els.speedSel.addEventListener("change", e => {
  clock.setSpeed(+e.target.value);
  saveSettings();
});
if (settings.speed !== undefined) els.speedSel.value = String(settings.speed);

els.playBtn.addEventListener("click", togglePlay);
els.auditionBtn.addEventListener("click", () => {
  if (state.auditioning) stopAudition(false); // 开关：再点退出试听，回到练习（暂停等待）
  else startAudition();
});
els.resetBtn.addEventListener("click", () => { if (state.session) resetSession(); });

els.endRestartBtn.addEventListener("click", restartSession);
els.endCloseBtn.addEventListener("click", hideOverlay);

els.importSheetBtn.addEventListener("click", () => els.sheetFile.click());
els.sheetFile.addEventListener("change", e => {
  const f = e.target.files[0];
  if (f) sheetView.loadFromBlob(f);
  e.target.value = "";
});
els.clearSheetBtn.addEventListener("click", () => sheetView.clear());
els.zoomInBtn.addEventListener("click", () => sheetView.zoomBy(1.25));
els.zoomOutBtn.addEventListener("click", () => sheetView.zoomBy(1 / 1.25));
els.fitBtn.addEventListener("click", () => sheetView.fitWidth());
els.resetViewBtn.addEventListener("click", () => sheetView.resetView());

// 修饰灯 = 触屏/鼠标点击的锁定开关（游戏内等价于按住对应鼠标键）
els.lampLeft.addEventListener("click", () => input.setLatch("shift", input.latch.shift === -1 ? 0 : -1));
els.lampRight.addEventListener("click", () => input.setLatch("shift", input.latch.shift === 1 ? 0 : 1));
els.lampMid.addEventListener("click", () => input.setLatch("sharp", !input.latch.sharp));

document.addEventListener("keydown", e => {
  if (e.code === "Space" && state.mode === "waterfall"){
    e.preventDefault();
    if (!e.repeat) togglePlay();
  } else if (e.key === "Escape"){
    hideOverlay();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && clock.playing){
    clock.pause();
    audio.noteOff(0.05);
    state.auditionNote = null;
    updatePlayBtn();
  }
});

// ---------- 音源门控加载 ----------
function onLoadProgress(done, total){
  els.gateBar.style.width = (total ? done / total * 100 : 0) + "%";
  els.gateText.textContent = `${done} / ${total}`;
}
function boot(isRetry){
  const audioP = isRetry ? audio.retry() : audio.init(onLoadProgress);
  Promise.all([audioP, initSongs()]).then(([{ failed }]) => {
    if (failed.length) toast(`有 ${failed.length} 个音源加载失败，对应音高将无声`);
    els.gate.classList.add("hidden");
    if (state.mode === "waterfall") loadSong(state.currentIdx);
  }).catch(err => {
    els.gate.classList.add("error");
    els.gateTitle.textContent = "音源加载失败";
    els.gateText.textContent = String((err && err.message) || err);
    els.gateRetry.hidden = false;
  });
}
els.gateRetry.addEventListener("click", () => {
  els.gate.classList.remove("error");
  els.gateTitle.textContent = "音源加载中…";
  els.gateRetry.hidden = true;
  boot(true);
});

// ---------- 启动 ----------
applyTheme(state.themeMode);
buildVirtualKeys();
rebuildStrip();
sheetView.restoreFromCache();
els.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === state.mode));
document.body.dataset.mode = state.mode;
els.hud.hidden = state.mode !== "waterfall";
updateAuditionBtn();
refreshNowDisplay(input.snapshot());
boot(false);
