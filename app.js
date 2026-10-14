'use strict';

// ---------- settings ----------
const STORAGE_KEY = 'travel-timer:v1';
const RING_LENGTH = 2 * Math.PI * 88; // must match r="88" in index.html
const STOPWATCH_LAP_MS = 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const DEFAULT_MODE = 'japan';
const LEGACY_MODE = 'world'; // sessions saved before versions existed
const DEFAULT_DAILY_GOAL_MIN = 60;
const UNNAMED_TASK = '(名前なし)';

const RANKS = [
  { hours: 0, title: '旅の準備中' },
  { hours: 1, title: 'はじめての旅人' },
  { hours: 5, title: 'バックパッカー' },
  { hours: 15, title: '世界を歩く旅人' },
  { hours: 40, title: '冒険家' },
  { hours: 100, title: '旅の達人' },
];

const CHEERS = [
  'いい集中でした!',
  '着実に前へ進んでいます。',
  'コツコツが一番の近道です。',
  'お疲れさまでした!',
  'この調子でいきましょう!',
];

const CITY_INFO = {
  '東京': { emoji: '🗼', note: 'すべてのはじまりの街' },
  '名古屋': { emoji: '🏯', note: 'ひつまぶしと味噌カツの街' },
  '新大阪': { emoji: '🐙', note: 'たこ焼きと食い倒れの街・大阪の玄関口' },
  '岡山': { emoji: '🍑', note: '桃太郎伝説のふるさと' },
  '広島': { emoji: '⛩️', note: '宮島の厳島神社とお好み焼き' },
  '博多': { emoji: '🍜', note: '豚骨ラーメンと明太子' },
  '熊本': { emoji: '🐻', note: '熊本城とくまモンの街' },
  '鹿児島中央': { emoji: '🌋', note: '桜島と黒豚の街' },
  '大阪': { emoji: '🐙', note: 'たこ焼きと食い倒れの街' },
  '福岡': { emoji: '🍜', note: '屋台とラーメンの街' },
  'ソウル': { emoji: '🌶️', note: '韓国の首都。屋台グルメが人気' },
  '上海': { emoji: '🥟', note: '小籠包と夜景の国際都市' },
  '香港': { emoji: '🌃', note: '百万ドルの夜景と飲茶' },
  'バンコク': { emoji: '🐘', note: '寺院と屋台の街' },
  'シンガポール': { emoji: '🦁', note: 'マーライオンのいる都市国家' },
  'ドバイ': { emoji: '🐪', note: '砂漠に建つ超高層ビルの街' },
  'パリ': { emoji: '🥐', note: 'エッフェル塔とクロワッサンの街' },
};

// legs: [from, to, approximate distance in km]
// kmPerMin: shinkansen ~300 km/h vs airplane ~900 km/h is about 1:3
const MODES = {
  japan: {
    label: '国内版',
    vehicle: '新幹線',
    ticket: '乗車券',
    collect: 'kippu', // shinkansen: collect train tickets
    collectTitle: '旅のきっぷ',
    kmPerMin: 3,
    legs: [
      ['東京', '名古屋', 366],
      ['名古屋', '新大阪', 149],
      ['新大阪', '岡山', 161],
      ['岡山', '広島', 145],
      ['広島', '博多', 248],
      ['博多', '熊本', 118],
      ['熊本', '鹿児島中央', 138],
    ],
  },
  world: {
    label: '海外版',
    vehicle: '飛行機',
    ticket: '搭乗券',
    collect: 'stamps', // airplane: collect passport stamps
    collectTitle: '旅のパスポート',
    kmPerMin: 10,
    legs: [
      ['東京', '大阪', 400],
      ['大阪', '福岡', 560],
      ['福岡', 'ソウル', 540],
      ['ソウル', '上海', 870],
      ['上海', '香港', 1250],
      ['香港', 'バンコク', 1710],
      ['バンコク', 'シンガポール', 1430],
      ['シンガポール', 'ドバイ', 5840],
      ['ドバイ', 'パリ', 5250],
    ],
  },
};

function makeCity(name, km) {
  return { name, km, ...(CITY_INFO[name] || { emoji: '📍', note: '' }) };
}

for (const mode of Object.values(MODES)) {
  mode.cities = [makeCity(mode.legs[0][0], 0)];
  for (const [, to, km] of mode.legs) {
    mode.cities.push(makeCity(to, mode.cities[mode.cities.length - 1].km + km));
  }
  mode.routeKm = mode.cities[mode.cities.length - 1].km;
}

// ---------- state ----------
const $ = (id) => document.getElementById(id);

let store = loadStore();
let currentMode = store.lastMode;
let loggedSeconds = sumSecondsByMode(store.sessions);
let targetMin = 25; // 0 means stopwatch
let timer = { status: 'idle', baseMs: 0, startedAt: 0 }; // status: idle | running | paused
let audioCtx = null;
let lastReached = -1; // -1 = unknown yet, so no false "arrived" message

// ---------- storage ----------
function isValidSession(s) {
  return s
    && typeof s.task === 'string'
    && typeof s.date === 'string'
    && Number.isFinite(s.seconds)
    && s.seconds > 0;
}

function defaultGoals() {
  return Object.fromEntries(
    Object.entries(MODES).map(([key, mode]) => [key, mode.cities[mode.cities.length - 1].name]),
  );
}

function emptyStore() {
  return {
    sessions: [],
    lastTask: '',
    lastMode: DEFAULT_MODE,
    goals: defaultGoals(),
    dailyGoalMin: DEFAULT_DAILY_GOAL_MIN,
    active: null,
  };
}

function validActive(a) {
  if (!a || (a.status !== 'running' && a.status !== 'paused')) return null;
  const ok = Number.isFinite(a.baseMs) && a.baseMs >= 0
    && Number.isFinite(a.startedAt)
    && Number.isInteger(a.targetMin) && a.targetMin >= 0 && a.targetMin <= 300
    && MODES[a.mode];
  if (!ok) return null;
  return {
    status: a.status,
    baseMs: a.baseMs,
    startedAt: a.startedAt,
    targetMin: a.targetMin,
    mode: a.mode,
    task: typeof a.task === 'string' ? a.task : '',
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    const base = emptyStore();

    if (Array.isArray(parsed.sessions)) {
      base.sessions = parsed.sessions
        .filter(isValidSession)
        .map((s) => ({ ...s, mode: MODES[s.mode] ? s.mode : LEGACY_MODE }));
    }
    if (typeof parsed.lastTask === 'string') base.lastTask = parsed.lastTask;
    if (MODES[parsed.lastMode]) base.lastMode = parsed.lastMode;
    for (const [key, mode] of Object.entries(MODES)) {
      const goal = parsed.goals && parsed.goals[key];
      if (mode.cities.slice(1).some((c) => c.name === goal)) base.goals[key] = goal;
    }
    const daily = parsed.dailyGoalMin;
    if (Number.isInteger(daily) && daily >= 1 && daily <= 1440) base.dailyGoalMin = daily;
    base.active = validActive(parsed.active);
    return base;
  } catch {
    return emptyStore();
  }
}

function sumSecondsByMode(sessions) {
  const sums = Object.fromEntries(Object.keys(MODES).map((key) => [key, 0]));
  for (const s of sessions) sums[s.mode] += s.seconds;
  return sums;
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

// keep a running/paused session so a reload does not lose it
function persist() {
  store.active = timer.status === 'idle'
    ? null
    : {
      status: timer.status,
      baseMs: timer.baseMs,
      startedAt: timer.startedAt,
      targetMin,
      mode: currentMode,
      task: $('task').value,
    };
  return saveStore();
}

function restoreActive() {
  const a = store.active;
  if (!a) return;
  currentMode = a.mode;
  targetMin = a.targetMin;
  timer = { status: a.status, baseMs: a.baseMs, startedAt: a.startedAt };
  $('task').value = a.task;
}

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, '0');

function fmtClock(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtDuration(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

function fmtKm(km, round = Math.floor) {
  return `${round(km).toLocaleString('ja-JP')} km`;
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(key) {
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
}

// ---------- journey maths ----------
// total distance of one version; sessionMin is the running session (current version only)
function kmFor(key, sessionMin = 0) {
  return (loggedSeconds[key] / 60 + sessionMin) * MODES[key].kmPerMin;
}

// number of cities reached, not counting the start city
function reachedCount(key, km) {
  return MODES[key].cities.slice(1).filter((c) => c.km <= km).length;
}

function goalCity(key) {
  return MODES[key].cities.find((c) => c.name === store.goals[key]);
}

// stamp date per city, derived from the session history (so it can never drift)
function computeStamps(key) {
  const mode = MODES[key];
  const stamps = { [mode.cities[0].name]: '' };
  let km = 0;
  for (const s of store.sessions) {
    if (s.mode !== key) continue;
    km += (s.seconds / 60) * mode.kmPerMin;
    for (const city of mode.cities) {
      if (city.km <= km && !(city.name in stamps)) stamps[city.name] = s.date;
    }
  }
  return stamps;
}

// ---------- study statistics ----------
function totalSecondsAll() {
  return Object.values(loggedSeconds).reduce((a, b) => a + b, 0);
}

function secondsOn(key) {
  return store.sessions.reduce((sum, s) => (s.date === key ? sum + s.seconds : sum), 0);
}

function rankIndex(totalSec) {
  let idx = 0;
  RANKS.forEach((rank, i) => {
    if (totalSec >= rank.hours * 3600) idx = i;
  });
  return idx;
}

// consecutive days with a session, ending today (or yesterday if today has none yet)
function streakDays() {
  const days = new Set(store.sessions.map((s) => s.date));
  const d = new Date();
  if (!days.has(dateKey(d))) d.setDate(d.getDate() - 1);
  let count = 0;
  while (days.has(dateKey(d))) {
    count += 1;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

// ---------- sound and effects ----------
function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function playTones(freqs, step) {
  if (!audioCtx) return;
  try {
    freqs.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const start = audioCtx.currentTime + i * step;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + step * 0.9);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + step);
    });
  } catch {
    // sound is optional
  }
}

const beep = () => playTones([880, 1175], 0.25);
const fanfare = () => playTones([523, 659, 784, 1047], 0.18);

function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = el('div', 'confetti');
  box.setAttribute('aria-hidden', 'true');
  const colors = ['#c2410c', '#0e7490', '#f5b301', '#ec4899', '#22c55e', '#3b82f6'];
  for (let i = 0; i < 48; i += 1) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    piece.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    box.append(piece);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4500);
}

// ---------- timer logic ----------
function elapsedMs() {
  return timer.baseMs + (timer.status === 'running' ? Date.now() - timer.startedAt : 0);
}

function targetMs() {
  return targetMin * 60 * 1000;
}

function onMain() {
  if (timer.status === 'running') {
    timer.baseMs = elapsedMs();
    timer.status = 'paused';
  } else {
    timer.startedAt = Date.now();
    timer.status = 'running';
    primeAudio();
    setMessage('');
  }
  persist();
  render();
}

function finish(auto) {
  const mode = MODES[currentMode];
  // an auto-finish may be noticed late (tab asleep), so date it by when the timer really ended
  const endedAt = auto ? new Date(timer.startedAt + targetMs() - timer.baseMs) : new Date();
  const seconds = Math.round((auto ? targetMs() : elapsedMs()) / 1000);
  const taskInput = $('task').value.trim();
  const task = taskInput || UNNAMED_TASK;
  const day = dateKey(endedAt);

  const before = {
    km: kmFor(currentMode),
    total: totalSecondsAll(),
    today: secondsOn(day),
  };

  timer = { status: 'idle', baseMs: 0, startedAt: 0 };
  lastReached = -1;

  if (seconds < 1) {
    persist();
    render();
    return;
  }

  store.sessions.push({ task, seconds, mode: currentMode, date: day, at: endedAt.getTime() });
  store.lastTask = taskInput;
  loggedSeconds[currentMode] += seconds;
  const saved = persist();

  const kmAfter = kmFor(currentMode);
  const parts = [];
  if (auto) parts.push('時間になりました!');
  parts.push(`${task} ${fmtDuration(seconds)} を記録。${mode.vehicle}で +${fmtKm(kmAfter - before.km, Math.round)}`);

  const arrived = mode.cities.slice(1).filter((c) => c.km > before.km && c.km <= kmAfter);
  if (arrived.length > 0) parts.push(`🎫 スタンプ獲得: ${arrived.map((c) => c.name).join('、')}`);

  const goal = goalCity(currentMode);
  const goalReached = before.km < goal.km && kmAfter >= goal.km;
  if (goalReached) parts.push(`🎉 目的地 ${goal.name} に到着!`);

  const dailySec = store.dailyGoalMin * 60;
  const dailyReached = before.today < dailySec && before.today + seconds >= dailySec;
  if (dailyReached) parts.push('🎯 今日の目標を達成!');

  if (rankIndex(before.total + seconds) > rankIndex(before.total)) {
    parts.push(`🏅 称号アップ: ${RANKS[rankIndex(before.total + seconds)].title}`);
  }
  if (!goalReached && !dailyReached) parts.push(CHEERS[store.sessions.length % CHEERS.length]);
  if (!saved) parts.push('(このブラウザーでは保存できませんでした)');

  setMessage(parts.join(' '));

  if (goalReached || dailyReached) {
    fanfare();
    confetti();
  } else if (auto) {
    beep();
  }
  render();
}

function onReset() {
  if (elapsedMs() > 10000 && !window.confirm('今回の時間は記録せずに、リセットしますか?')) return;
  timer = { status: 'idle', baseMs: 0, startedAt: 0 };
  lastReached = -1;
  setMessage('');
  persist();
  render();
}

function onClear() {
  if (!window.confirm('すべての記録を消します。元に戻せません。よろしいですか?')) return;
  store.sessions = [];
  store.lastTask = '';
  loggedSeconds = sumSecondsByMode(store.sessions);
  lastReached = -1;
  saveStore();
  setMessage('記録をすべて消しました。');
  render();
}

function setTarget(min) {
  if (timer.status !== 'idle') return;
  targetMin = min;
  render();
}

function setMode(key) {
  if (timer.status !== 'idle' || !MODES[key]) return;
  currentMode = key;
  store.lastMode = key;
  lastReached = -1;
  saveStore();
  render();
}

function onGoalChange(event) {
  const mode = MODES[currentMode];
  if (!mode.cities.slice(1).some((c) => c.name === event.target.value)) return;
  store.goals[currentMode] = event.target.value;
  saveStore();
  render();
}

function onDailyGoalChange(event) {
  const value = Math.floor(Number(event.target.value));
  if (Number.isFinite(value) && value >= 1 && value <= 1440) {
    store.dailyGoalMin = value;
    saveStore();
  }
  render();
}

function tick() {
  if (timer.status === 'running' && targetMin > 0 && elapsedMs() >= targetMs()) {
    finish(true);
    return;
  }
  renderLive();
}

// ---------- rendering ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setMessage(text) {
  $('message').textContent = text;
}

function hintText(km, active) {
  const mode = MODES[currentMode];
  const next = mode.cities.find((c) => c.km > km);
  if (!next) return '全行程を完走しました!';
  if (!active && targetMin > 0 && km + targetMin * mode.kmPerMin >= next.km) {
    return `この${targetMin}分で ${next.name} ${next.emoji} に到着!`;
  }
  const toNext = fmtDuration(Math.ceil((next.km - km) / mode.kmPerMin) * 60);
  return `次の ${next.name} ${next.emoji} まで あと ${toNext}`;
}

function renderLive() {
  const mode = MODES[currentMode];
  const ms = elapsedMs();
  const active = timer.status !== 'idle';
  let clock;
  let progress;

  if (targetMin > 0) {
    clock = fmtClock(Math.ceil(Math.max(0, targetMs() - ms) / 1000));
    progress = Math.min(1, ms / targetMs());
    $('time-sub').textContent = '残り時間';
  } else {
    clock = fmtClock(Math.floor(ms / 1000));
    progress = (ms % STOPWATCH_LAP_MS) / STOPWATCH_LAP_MS;
    $('time-sub').textContent = '経過時間 (リング1周 = 1時間)';
  }

  $('time').textContent = clock;
  $('ring-fg').style.strokeDashoffset = String(RING_LENGTH * (1 - progress));
  document.title = timer.status === 'running' ? `${clock} 旅するタイマー` : '旅するタイマー';

  const sessionMin = active ? (targetMin > 0 ? Math.min(ms, targetMs()) : ms) / 60000 : 0;
  const totalKm = kmFor(currentMode, sessionMin);

  $('time-gain').textContent = active
    ? `この回 +${(sessionMin * mode.kmPerMin).toFixed(1)} km`
    : `${mode.vehicle}: 1分 = ${mode.kmPerMin} km`;
  $('hint').textContent = hintText(totalKm, active);

  const reached = reachedCount(currentMode, totalKm);
  if (lastReached >= 0 && timer.status === 'running' && reached > lastReached) {
    const city = mode.cities[reached];
    setMessage(`${mode.vehicle}が ${city.name} に到着! ${city.emoji}`);
  }
  lastReached = reached;

  renderJourney(totalKm);
}

function renderJourney(totalKm) {
  const mode = MODES[currentMode];
  const cities = mode.cities;
  const goal = goalCity(currentMode);

  // ticket
  $('ticket-kind').textContent = `${mode.ticket} · ${mode.vehicle}`;
  $('from-emoji').textContent = cities[0].emoji;
  $('from-name').textContent = cities[0].name;
  $('to-emoji').textContent = goal.emoji;
  $('to-name').textContent = goal.name;
  $('to-note').textContent = goal.note;
  $('fact-done').textContent = fmtKm(totalKm);

  const left = goal.km - totalKm;
  const ratio = Math.min(1, totalKm / goal.km);
  if (left > 0) {
    $('fact-left').textContent = fmtKm(left, Math.ceil);
    $('fact-eta').textContent = fmtDuration(Math.ceil(left / mode.kmPerMin) * 60);
    $('goal-pct').textContent = `${Math.floor(ratio * 100)}% 進みました`;
  } else {
    $('fact-left').textContent = '到着!';
    $('fact-eta').textContent = '—';
    $('goal-pct').textContent = goal === cities[cities.length - 1]
      ? `🎉 ${goal.name}に到着! ${mode.label}を完走しました。`
      : `🎉 ${goal.name}に到着済み! 次の目的地を選ぼう。`;
  }
  $('goal-fill').style.width = `${(ratio * 100).toFixed(2)}%`;
  $('goal-progress').setAttribute('aria-valuenow', String(Math.floor(ratio * 100)));

  // current leg
  let fromCity;
  let toCity;
  let fraction;
  let text;

  if (totalKm >= mode.routeKm) {
    fromCity = cities[cities.length - 2];
    toCity = cities[cities.length - 1];
    fraction = 1;
    text = `${toCity.name}に到着しました! 東京から ${fmtKm(mode.routeKm)} の${mode.label}が完成です。`;
  } else {
    let i = 0;
    while (totalKm >= cities[i + 1].km) i += 1;
    fromCity = cities[i];
    toCity = cities[i + 1];
    fraction = (totalKm - fromCity.km) / (toCity.km - fromCity.km);
    const minutes = Math.ceil((toCity.km - totalKm) / mode.kmPerMin);
    text = `${toCity.name}まで あと ${fmtKm(toCity.km - totalKm, Math.ceil)} (勉強 約${fmtDuration(minutes * 60)})`;
  }

  $('track').dataset.mode = currentMode;
  $('leg-from').textContent = fromCity.name;
  $('leg-to').textContent = toCity.name;
  $('plane').style.setProperty('--p', fraction.toFixed(4));
  $('train').style.setProperty('--p', fraction.toFixed(4));
  $('track-done').style.width = `${(fraction * 100).toFixed(2)}%`;
  $('journey-text').textContent = text;

  const others = Object.keys(MODES).filter((key) => key !== currentMode);
  $('other-totals').textContent = others.map((key) => `${MODES[key].label} ${fmtKm(kmFor(key))}`).join(' / ');
}

function renderControls() {
  const idle = timer.status === 'idle';

  document.querySelectorAll('.mode').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === currentMode));
    btn.disabled = !idle;
  });

  document.querySelectorAll('.chip').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.min) === targetMin));
    btn.disabled = !idle;
  });

  const custom = $('custom-min');
  custom.disabled = !idle;
  if (document.activeElement !== custom) custom.value = targetMin > 0 ? String(targetMin) : '';

  $('btn-main').textContent = timer.status === 'running' ? '一時停止' : timer.status === 'paused' ? '再開' : '開始';
  $('btn-finish').disabled = idle;
  $('btn-reset').disabled = idle;
}

function renderTiles() {
  const totalSec = totalSecondsAll();
  const idx = rankIndex(totalSec);
  $('tile-streak').textContent = `${streakDays()}日`;
  $('tile-total').textContent = fmtDuration(totalSec);
  $('tile-rank').textContent = RANKS[idx].title;
  $('tile-rank-next').textContent = idx < RANKS.length - 1
    ? `次まで あと ${fmtDuration(RANKS[idx + 1].hours * 3600 - totalSec)}`
    : '最高の称号です!';
}

function renderGoalSelect() {
  const mode = MODES[currentMode];
  const km = kmFor(currentMode);
  const select = $('goal');
  select.replaceChildren();
  for (const city of mode.cities.slice(1)) {
    const option = document.createElement('option');
    option.value = city.name;
    option.textContent = `${city.emoji} ${city.name} (${fmtKm(city.km)})${km >= city.km ? ' ✓' : ''}`;
    select.append(option);
  }
  select.value = store.goals[currentMode];
}

// shinkansen: one train ticket per leg; airplane: one passport stamp per city
function renderPassport() {
  const mode = MODES[currentMode];
  const stamps = computeStamps(currentMode);
  const list = $('passport');
  list.replaceChildren();
  list.className = `passport ${mode.collect}`;
  $('passport-h').textContent = mode.collectTitle;

  let got = 0;
  let total = 0;

  if (mode.collect === 'kippu') {
    mode.legs.forEach(([from, to, km]) => {
      const date = stamps[to];
      const has = date !== undefined;
      total += 1;
      if (has) got += 1;
      const li = el('li', has ? 'kippu-card got' : 'kippu-card');
      li.append(
        el('span', 'kp-kind', '新幹線 乗車券'),
        el('span', 'kp-route', `${from} → ${to}`),
        el('span', 'kp-meta', has ? `${fmtKm(km)} · ${fmtDate(date)}` : `${fmtKm(km)} · 未発券`),
      );
      if (has) li.append(el('span', 'kp-used', '改札済'));
      list.append(li);
    });
    $('passport-count').textContent = `${mode.label}: ${got} / ${total} 枚のきっぷを集めました`;
    return;
  }

  for (const city of mode.cities) {
    const date = stamps[city.name];
    const has = date !== undefined;
    total += 1;
    if (has) got += 1;
    const li = el('li', has ? 'stamp got' : 'stamp');
    li.append(
      el('span', 'stamp-emoji', has ? city.emoji : '？'),
      el('span', 'stamp-name', city.name),
      el('span', 'stamp-date', !has ? '未到着' : date === '' ? '出国' : date.replaceAll('-', '.')),
    );
    list.append(li);
  }
  $('passport-count').textContent = `${mode.label}: ${got} / ${total} 個のスタンプを集めました`;
}

function renderToday() {
  const today = dateKey(new Date());
  const byTask = new Map();
  let total = 0;
  for (const s of store.sessions) {
    if (s.date !== today) continue;
    byTask.set(s.task, (byTask.get(s.task) || 0) + s.seconds);
    total += s.seconds;
  }

  const goalSec = store.dailyGoalMin * 60;
  const dailyInput = $('daily-goal');
  if (document.activeElement !== dailyInput) dailyInput.value = String(store.dailyGoalMin);
  const dailyRatio = Math.min(1, total / goalSec);
  $('daily-fill').style.width = `${(dailyRatio * 100).toFixed(1)}%`;
  $('daily-progress').setAttribute('aria-valuenow', String(Math.floor(dailyRatio * 100)));
  $('daily-text').textContent = total >= goalSec
    ? '🎯 今日の目標を達成しました!'
    : `目標まであと ${fmtDuration(goalSec - total)}`;

  $('today-total').textContent = fmtDuration(total);
  const list = $('today-list');
  list.replaceChildren();

  if (byTask.size === 0) {
    list.append(el('li', 'empty', 'まだ記録がありません。最初の1回を始めましょう。'));
    return;
  }

  const rows = [...byTask.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows[0][1];
  for (const [task, seconds] of rows) {
    const li = el('li');
    const head = el('div', 'bar-head');
    head.append(el('span', 'bar-name', task), el('span', '', fmtDuration(seconds)));
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${(seconds / max) * 100}%`;
    track.append(fill);
    li.append(head, track);
    list.append(li);
  }
}

function renderWeek() {
  const goalSec = store.dailyGoalMin * 60;
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: dateKey(d), label: WEEKDAYS[d.getDay()], seconds: 0, today: i === 0 });
  }
  for (const s of store.sessions) {
    const day = days.find((x) => x.key === s.date);
    if (day) day.seconds += s.seconds;
  }

  const max = Math.max(...days.map((d) => d.seconds), 1);
  const week = $('week');
  week.replaceChildren();

  for (const day of days) {
    const classes = ['week-col'];
    if (day.today) classes.push('today');
    if (day.seconds >= goalSec) classes.push('hit');
    const col = el('div', classes.join(' '));
    const area = el('div', 'week-bar-area');
    const bar = el('div', 'week-bar');
    bar.style.height = day.seconds > 0 ? `${Math.max(3, (day.seconds / max) * 100)}%` : '2px';
    area.append(bar);
    const mark = day.seconds >= goalSec ? ' ✓' : '';
    col.append(el('span', 'week-val', `${Math.round(day.seconds / 60)}分${mark}`), area, el('span', 'week-day', day.label));
    week.append(col);
  }
}

function renderTaskSuggestions() {
  const seen = new Set();
  const list = $('task-list');
  list.replaceChildren();
  for (let i = store.sessions.length - 1; i >= 0 && seen.size < 10; i -= 1) {
    const task = store.sessions[i].task;
    if (task === UNNAMED_TASK || seen.has(task)) continue;
    seen.add(task);
    const option = document.createElement('option');
    option.value = task;
    list.append(option);
  }
}

function render() {
  renderControls();
  renderTiles();
  renderGoalSelect();
  renderPassport();
  renderToday();
  renderWeek();
  renderTaskSuggestions();
  renderLive();
}

// ---------- setup ----------
function setup() {
  $('task').value = store.lastTask;
  restoreActive();

  document.querySelectorAll('.mode').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  document.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => setTarget(Number(btn.dataset.min)));
  });
  $('custom-min').addEventListener('change', (event) => {
    const value = Math.floor(Number(event.target.value));
    if (Number.isFinite(value) && value >= 1 && value <= 300) setTarget(value);
    else renderControls();
  });
  $('task').addEventListener('input', () => {
    if (timer.status !== 'idle') persist();
  });
  $('goal').addEventListener('change', onGoalChange);
  $('daily-goal').addEventListener('change', onDailyGoalChange);
  $('btn-main').addEventListener('click', onMain);
  $('btn-finish').addEventListener('click', () => finish(false));
  $('btn-reset').addEventListener('click', onReset);
  $('btn-clear').addEventListener('click', onClear);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  render();
  setInterval(tick, 250);
}

setup();
