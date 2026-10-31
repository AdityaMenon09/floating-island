// Floating Island: main process. Owns the always-on-top window, the tray icon, the global shortcut,
// the Windows bridge (bridge.ps1: media, volume, WhatsApp) and the calendar feed. All drawing and
// motion happen in the renderer.

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, clipboard, shell, dialog, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const calendarFiles = require('./calendar-files');
const characterArt = require('./character');

const SAFE_GRAPHICS = process.argv.includes('--safe-graphics');
const CAPTURE = process.argv.includes('--capture');
const SELFTEST = process.argv.includes('--selftest');
// Runs the real calendar refresh with no window and writes counts (no titles) to captures/.
const CHECK_CALENDAR = process.argv.includes('--check-calendar');
// `--set-login=on|off`: turn opening at Windows sign-in on or off, then quit (no window).
const SET_LOGIN = (process.argv.find((a) => a.startsWith('--set-login=')) || '').split('=')[1] || null;
// The pull-down animation: loop it live on screen for a minute, or record it to captures/.
const DEMO_PULL = process.argv.includes('--demo-pull');
const RECORD_PULL = process.argv.includes('--record-pull');
// Test runs never show real messages or events; they get the demo data below.
const DEMO = CAPTURE || SELFTEST || DEMO_PULL || RECORD_PULL;
const SHORTCUT = 'Control+Alt+I';

// FLOATING_ISLAND_DATA points the whole app at another data folder (tests; scripts/ honour it too).
if (process.env.FLOATING_ISLAND_DATA) app.setPath('userData', path.resolve(process.env.FLOATING_ISLAND_DATA));

// Some graphics drivers draw transparent windows as a black box; software compositing avoids it.
if (SAFE_GRAPHICS) app.disableHardwareAcceleration();

// The window never resizes. It is big enough for the expanded island, its shadow and the character
// beside it, and the island morphs inside it, because resizing a transparent native window every
// frame stutters on Windows. Everything outside the island is click-through, so the size is free.
const WIN_W = 760;
const WIN_H = 360;
const CX = WIN_W / 2;

// The optional character beside the island: each person's own picture, chosen in the terminal on the
// first `npm start` (scripts/character.js) or from the tray, and kept in the app's data folder, never
// in the repo. assets/private/ is where the first version kept it.
function readCharacter() {
  const files = [
    characterArt.characterFile(app.getPath('userData')),
    path.join(__dirname, '..', 'assets', 'private', 'character.png')
  ];
  for (const file of files) {
    try { return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`; } catch { /* next */ }
  }
  return null;
}

async function changeCharacter() {
  const pick = await dialog.showOpenDialog({
    title: 'Choose a character (a PNG with a transparent background looks best)',
    buttonLabel: 'Use this picture',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }]
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const file = pick.filePaths[0];
  if (characterArt.transparency(file) === 'no') {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Use it anyway', 'Pick another'],
      defaultId: 1,
      cancelId: 1,
      message: "That picture has no transparent background, so it'll show as a rectangle.",
      detail: 'A PNG with a transparent background looks best.'
    });
    if (response !== 0) return changeCharacter();
  }
  try {
    characterArt.install(file, app.getPath('userData'));
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: err.message });
    return;
  }
  last.character = readCharacter();
  send('character', { url: last.character });
}

let win = null;
let tray = null;
let bridge = null;
let quitting = false;
let interactive = false;
let pointerPoll = null;
const last = {
  media: { type: 'media', active: false },
  art: null,
  volume: null,
  // Unknown until the bridge first reports: the renderer takes its first list as "already seen",
  // so an empty placeholder here would make every existing notification pop up as new.
  messages: null,
  calendar: { configured: false, events: [] },
  character: null // read once the app is ready (it needs the data folder's path)
};

// A small log of what went wrong, in the data folder (island.log), for problems nobody was there to
// see, like a start at Windows sign-in. Never message text, event titles or the calendar link.
const LOG_LIMIT = 256 * 1024;
const scrub = (text) => String(text).replace(/https?:\/\/\S+/g, '<link>').replace(/private-[^\s/"']+/g, '<private>');
function log(...parts) {
  if (DEMO) return;
  try {
    const file = path.join(app.getPath('userData'), 'island.log');
    try { if (fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.old`); } catch { /* no log yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${scrub(parts.join(' '))}\n`);
  } catch { /* logging must never break the island */ }
}
// These replace Electron's error dialog, so print as well: test runs (which don't log) and a
// terminal `npm start` still show the error.
process.on('uncaughtException', (err) => { console.error(err); log('main error:', (err && err.stack) || err); });
process.on('unhandledRejection', (err) => { console.error(err); log('main rejection:', (err && err.stack) || err); });

// Test runs stay out of the single-instance lock, so they work alongside your running island.
if (!DEMO && !CHECK_CALENDAR && !SET_LOGIN) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => toggleFromOutside());
  }
}

function place() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - WIN_W) / 2),
    y: workArea.y,
    width: WIN_W,
    height: WIN_H
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- click-through ----------
// Outside the island the window ignores the mouse entirely; the renderer learns where the pointer is
// from the cursor feed below and asks for clicks to be let through when it reaches the island.
// Never use setIgnoreMouseEvents' `forward: true` here: on Windows it installs a system-wide
// low-level mouse hook in this process, so whenever the process is slow every click on the PC waits
// for it (2026-10-31: the user's clicks failed in all apps while test recordings loaded the CPU).
function setInteractive(on) {
  if (!win || on === interactive) return;
  interactive = on;
  // Test runs keep ignoring the OS mouse even when "interactive": their synthetic input reaches the
  // page regardless, and a real mouse moving over the window mid-test would otherwise disturb it.
  if (!DEMO) win.setIgnoreMouseEvents(!on);
  clearInterval(pointerPoll);
  pointerPoll = null;
  // The self-test drives a synthetic pointer; the real cursor is elsewhere, so skip the poll.
  if (on && !SELFTEST) {
    // A fast flick out of the window delivers no final mousemove, so check the cursor directly.
    pointerPoll = setInterval(() => {
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      if (p.x < b.x || p.x >= b.x + b.width || p.y < b.y || p.y >= b.y + b.height) {
        setInteractive(false);
        send('island:pointer-out');
      }
    }, 120);
  }
}

// The cursor feed: where the pointer is, relative to the window, whenever it moves. The renderer uses
// it to notice the pointer reaching the island (the window gets no mouse events while click-through)
// and for the eyes, which follow it anywhere on screen. A plain position read, no hooks.
let lastCursor = '';
function watchCursor() {
  setInterval(() => {
    if (!win || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const key = `${p.x},${p.y}`;
    if (key === lastCursor) return;
    lastCursor = key;
    send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 40);
}

// ---------- Windows bridge (bridge.ps1) ----------
function startBridge() {
  bridge = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'bridge.ps1')
  ], { windowsHide: true });

  let buffer = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'media') {
        last.media = msg;
        send('media', msg);
      } else if (msg.type === 'art') {
        last.art = msg;
        send('media:art', msg);
      } else if (msg.type === 'volume') {
        last.volume = msg;
        send('volume', msg);
      } else if (msg.type === 'messages') {
        if (DEMO) continue;
        last.messages = msg;
        send('messages', msg);
      } else if (msg.type === 'error') {
        console.warn('[bridge]', msg.message);
      }
    }
  });
  bridge.stderr.on('data', (d) => console.warn('[bridge]', String(d).trim()));
  bridge.on('exit', () => {
    bridge = null;
    if (!quitting) setTimeout(startBridge, 3000);
  });
}

const BRIDGE_COMMAND = /^(toggle|play|pause|next|prev|mute|unmute|volume (0(\.\d+)?|1(\.0+)?)|seek \d{1,5}(\.\d+)?)$/;
// Test runs record playback and volume commands instead of sending them, so they never touch
// what you're listening to.
const demoCommands = [];

// ---------- calendar (a Google Calendar "secret address in iCal format") ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
}

function normaliseCalendarUrl(text) {
  let url = String(text || '').trim().replace(/^webcal:\/\//i, 'https://');
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!/\.ics$/i.test(u.pathname) && !/ical/i.test(u.pathname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Sources: the live secret link (re-read every 5 minutes, and when the island opens) and/or an
// imported export (a snapshot in %APPDATA%\Floating Island\calendar). They're merged, except that the
// link replaces the snapshot of its own calendar: a snapshot would keep events since moved or deleted.
const calendarDir = () => path.join(app.getPath('userData'), 'calendar');
const CALENDAR_EVERY = 5 * 60 * 1000;

// "https://calendar.google.com/calendar/ical/name%40gmail.com/private-…/basic.ics" -> "name@gmail.com"
function calendarIdFromUrl(url) {
  const m = /\/ical\/([^/]+)\//.exec(url || '');
  try { return m ? decodeURIComponent(m[1]).toLowerCase() : null; } catch { return null; }
}

// A refresh that has been going this long is treated as stuck and no longer blocks new ones; failed
// fetches are retried sooner than the regular cadence (at sign-in the network may not be up yet).
const CALENDAR_STUCK = 45 * 1000;
const CALENDAR_RETRY = [20 * 1000, 60 * 1000, 2 * 60 * 1000];
let calendarTimer = null;
let calendarRetry = null;
let calendarRetries = 0;
let calendarBusySince = 0;
let calendarOutcome = '';
async function refreshCalendar(reason = 'timer') {
  if (DEMO) return;
  if (calendarBusySince) {
    if (Date.now() - calendarBusySince < CALENDAR_STUCK) return;
    log(`calendar: a refresh has hung for ${Math.round((Date.now() - calendarBusySince) / 1000)} s; starting a new one`);
  }
  const started = Date.now();
  calendarBusySince = started;
  try {
    await readCalendars();
  } catch (err) {
    log('calendar refresh failed:', (err && err.stack) || err);
  } finally {
    if (calendarBusySince === started) calendarBusySince = 0;
  }
  const c = last.calendar;
  const outcome = `configured=${c.configured} events=${c.events.length} source=${c.source || '-'} error=${c.error || 'none'}`;
  if (outcome !== calendarOutcome) log(`calendar (${reason}, ${Date.now() - started} ms): ${outcome}`);
  calendarOutcome = outcome;
  clearTimeout(calendarRetry);
  if (!c.error) calendarRetries = 0;
  else if (calendarRetries < CALENDAR_RETRY.length) {
    const wait = CALENDAR_RETRY[calendarRetries++];
    log(`calendar: trying again in ${wait / 1000} s`);
    calendarRetry = setTimeout(() => refreshCalendar('retry'), wait);
  }
}

// fetch with a deadline this function holds itself, covering the body as well as the headers.
async function fetchText(url, ms = 20000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`The calendar link didn't answer within ${ms / 1000} s.`)), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: abort.signal });
    if (!res.ok) throw new Error(`The calendar link answered ${res.status}.`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readCalendars() {
  const url = readConfig().calendarUrl;
  const linkedId = calendarIdFromUrl(url);
  const imported = calendarFiles.listImported(calendarDir());
  imported.files = imported.files.filter((f) => !linkedId || path.basename(f, '.ics').toLowerCase() !== linkedId);
  if (!url && !imported.files.length) {
    last.calendar = { configured: false, events: [] };
    send('calendar', last.calendar);
    return;
  }
  const now = Date.now();
  const from = new Date(now - 12 * 3600e3);
  const to = new Date(now + 8 * 86400e3);
  const texts = [];
  let error = null;
  if (url) {
    try {
      texts.push(await fetchText(url));
    } catch (err) {
      // "fetch failed" alone says little; the cause's code (ENOTFOUND: no network yet) says why.
      const cause = err.cause && (err.cause.code || err.cause.message);
      error = `${err.message || 'Could not load the calendar link.'}${cause ? ` (${cause})` : ''}`;
    }
  }
  for (const file of imported.files) {
    try { texts.push(fs.readFileSync(file, 'utf8')); } catch { error = error || 'An imported calendar file could not be read.'; }
  }
  const byId = new Map();
  for (const text of texts) {
    try {
      for (const e of calendarFiles.parseCalendar(text, from, to)) byId.set(e.id, e);
    } catch {
      error = error || 'A calendar could not be read.';
    }
  }
  if (!texts.length && last.calendar.events.length) {
    // Nothing could be read this time: keep showing the last good events.
    last.calendar = { ...last.calendar, configured: true, error };
  } else {
    last.calendar = {
      configured: true,
      events: [...byId.values()].sort((a, b) => a.start - b.start),
      fetchedAt: now,
      error,
      source: url ? 'link' : 'export',
      importedAt: imported.importedAt
    };
  }
  send('calendar', last.calendar);
}

async function importCalendar() {
  const pick = await dialog.showOpenDialog({
    title: 'Import a Google Calendar export',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'Calendar export', extensions: ['zip', 'ics'] }]
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
  try {
    const { files } = calendarFiles.importExport(pick.filePaths[0], calendarDir());
    scheduleCalendar('import');
    return { ok: true, message: `Imported ${files.length} calendar${files.length === 1 ? '' : 's'}.` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function scheduleCalendar(reason = 'start') {
  clearInterval(calendarTimer);
  calendarRetries = 0;
  refreshCalendar(reason);
  calendarTimer = setInterval(refreshCalendar, CALENDAR_EVERY);
}

function pasteCalendarLink() {
  const url = normaliseCalendarUrl(clipboard.readText());
  if (!url) {
    return { ok: false, error: "The clipboard doesn't hold an iCal link. Copy the \"Secret address in iCal format\" first." };
  }
  writeConfig({ calendarUrl: url });
  scheduleCalendar('link pasted');
  return { ok: true };
}

// ---------- demo data for capture / self-test ----------
function demoData() {
  const now = Date.now();
  const at = (minutes) => Math.round((now + minutes * 60e3) / 60e3) * 60e3;
  return {
    messages: {
      type: 'messages',
      unread: 2,
      readable: true,
      items: [
        { id: 'd1', title: 'Riya', body: 'Are we still on for dinner tonight?', time: now - 2 * 60e3 },
        { id: 'd2', title: 'Project group', body: 'Sam: I pushed the slides, have a look when you can', time: now - 26 * 60e3 }
      ]
    },
    calendar: {
      configured: true,
      fetchedAt: now,
      error: null,
      events: [
        { id: 'e1', title: 'Design review', start: at(25), end: at(55), allDay: false, location: 'Meet' },
        { id: 'e2', title: 'Gym', start: at(180), end: at(240), allDay: false, location: '' },
        { id: 'e3', title: 'Call with Mum', start: at(26 * 60), end: at(26 * 60 + 30), allDay: false, location: '' }
      ]
    }
  };
}

// ---------- opening at Windows sign-in ----------
// A shortcut in the user's Startup folder that starts this Electron with this app folder (no console
// window, unlike Floating Island.cmd), plus Windows' approval mark for it (what Settings > Startup
// apps flips: 02 + zeros = on). Toggled from the tray.
// Why not the registry's Run list: on the author's PC Windows skipped that entry at two sign-ins
// (2026-10-31), silently, even with its approval mark set, while Startup-folder items ran.
const STARTUP_LINK = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Floating Island.lnk');
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';

const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });

// 'on', 'off' (switched off in Windows' settings) or null (no mark: Windows may not run it).
function approvalMark(list, name) {
  const m = /REG_BINARY\s+([0-9A-F]{2})/i.exec(reg(['query', `${APPROVED}\\${list}`, '/v', name]).stdout || '');
  if (!m) return null;
  return ['02', '06'].includes(m[1].toUpperCase()) ? 'on' : 'off';
}

function setApprovalMark(list, name, on) {
  reg(on
    ? ['add', `${APPROVED}\\${list}`, '/v', name, '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f']
    : ['delete', `${APPROVED}\\${list}`, '/v', name, '/f']);
}

function opensAtLogin() {
  return fs.existsSync(STARTUP_LINK()) && approvalMark('StartupFolder', 'Floating Island.lnk') === 'on';
}

function setOpenAtLogin(on) {
  // Retire the old Run-list entry, if this PC still has one from an earlier version.
  app.setLoginItemSettings({ path: process.execPath, args: [app.getAppPath()], name: 'Floating Island', openAtLogin: false });
  setApprovalMark('Run', 'Floating Island', false);
  if (on) {
    fs.mkdirSync(path.dirname(STARTUP_LINK()), { recursive: true });
    shell.writeShortcutLink(STARTUP_LINK(), 'create', {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      description: 'Floating Island',
      icon: process.execPath,
      iconIndex: 0
    });
  } else {
    fs.rmSync(STARTUP_LINK(), { force: true });
  }
  setApprovalMark('StartupFolder', 'Floating Island.lnk', on);
}

// ---------- tray ----------
// A small island glyph drawn in code: a black pill with a white rim, legible on light and dark taskbars.
function trayImage() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const pill = (x, y, inset) => {
    const hw = 13 - inset, hh = 6.5 - inset, r = hh;
    const dx = Math.max(Math.abs(x - 16) - (hw - r), 0);
    const dy = Math.max(Math.abs(y - 16) - (hh - r), 0);
    return Math.hypot(dx, dy) - r; // signed distance to the rounded rect
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const outer = Math.min(1, Math.max(0, 0.5 - pill(px, py, 0)));
      const inner = Math.min(1, Math.max(0, 0.5 - pill(px, py, 2)));
      const v = Math.round(255 * outer * (1 - inner)); // premultiplied BGRA
      const o = (y * size + x) * 4;
      buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = Math.round(255 * outer);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip(`Floating Island (${SHORTCUT.replace('Control', 'Ctrl')})`);
  const menu = Menu.buildFromTemplate([
    { label: 'Open island', click: () => toggleFromOutside(true) },
    { label: 'Hide island', click: () => win && win.hide() },
    { type: 'separator' },
    { label: 'Change character…', click: () => changeCharacter() },
    { label: 'Paste Google Calendar link from clipboard', click: () => send('calendar:result', pasteCalendarLink()) },
    { label: 'Import Google Calendar export (.zip)…', click: async () => send('calendar:result', await importCalendar()) },
    { label: 'Open when Windows starts', type: 'checkbox', checked: opensAtLogin(), click: (item) => setOpenAtLogin(item.checked) },
    { label: 'Safe graphics (fixes a black box)', type: 'checkbox', checked: SAFE_GRAPHICS, click: (item) => relaunch(item.checked) },
    { type: 'separator' },
    { label: 'Quit Floating Island', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleFromOutside());
}

function relaunch(safe) {
  const args = process.argv.slice(1).filter((a) => a !== '--safe-graphics');
  if (safe) args.push('--safe-graphics');
  app.relaunch({ args });
  app.quit();
}

// Tray click, shortcut or a second launch: show the island if hidden, otherwise open/close it.
function toggleFromOutside(forceOpen = false) {
  if (!win) return;
  if (!win.isVisible()) {
    win.showInactive();
    send('island:toggle', { open: true });
    return;
  }
  send('island:toggle', { open: forceOpen ? true : undefined });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never takes keyboard focus, so clicking the island doesn't pull focus from the app you're in.
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  place();
  // ?demo tells the renderer not to load or save personal data (notes, timer) during test runs.
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), DEMO ? { query: { demo: '1' } } : undefined);
  win.on('blur', () => {
    if (win.isFocusable()) setFocusable(false);
    send('island:blur');
  });
  win.once('ready-to-show', () => {
    win.showInactive();
    if (DEMO) {
      const demo = demoData();
      last.messages = demo.messages;
      last.calendar = demo.calendar;
      send('messages', demo.messages);
      send('calendar', demo.calendar);
    }
    if (CAPTURE) captureStates();
    if (SELFTEST) selfTest();
    if (DEMO_PULL) demoPullLoop();
    if (RECORD_PULL) recordPull();
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('render-process-gone', (_e, d) => log(`window crashed: ${d.reason} (${d.exitCode})`));
  win.webContents.on('preload-error', (_e, file, err) => log('preload error:', (err && err.stack) || err));
}

// The window only takes keyboard focus while you type a note. Electron's setFocusable also flips
// the taskbar entry on Windows, so the island is hidden from it again each time.
function setFocusable(on) {
  if (!win) return;
  win.setFocusable(on);
  win.setSkipTaskbar(true);
}

// ---------- capture (npm run capture) ----------
// Renders each island state in the real transparent window and saves PNGs to captures/, then quits.
async function captureStates() {
  const dir = path.join(__dirname, '..', 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (code) => win.webContents.executeJavaScript(code);
  const shoot = async (name) => fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const shots = [
    ['tucked', `window.__island.set('tucked')`],
    ['compact', `window.__island.set('compact')`],
    ['hud', `window.__island.set('hud')`],
    ['banner-media', `window.__island.set('banner', 'media')`],
    ['banner-message', `window.__island.set('banner', 'message')`],
    ['banner-event', `window.__island.set('banner', 'event')`],
    ['home', `window.__island.set('expanded', 'home')`],
    ['music', `window.__island.set('expanded', 'music')`],
    ['music-loop', `(() => { const d = window.__island.state().media.duration; if (d) window.__island.loop(d * 0.3, d * 0.6); })()`],
    ['messages', `window.__island.loop(null, null); window.__island.set('expanded', 'messages')`],
    ['calendar', `window.__island.set('expanded', 'calendar')`],
    ['japanese', `window.__island.set('expanded', 'japanese')`],
    ['japanese-flipped', `document.querySelector('[data-jp-stage] .fc:not(.leaving)').click()`],
    ['notes', `window.__island.set('expanded', 'notes')`]
  ];
  await wait(2500); // let the bridge report and the clock render
  for (const [name, code] of shots) {
    await run(code);
    await wait(1400);
    await shoot(name);
  }
  // Mid-flight frame, to check the morph itself renders cleanly.
  await run(`window.__island.set('compact')`);
  await wait(1400);
  await run(`window.__island.set('expanded', 'home')`);
  await wait(120);
  await shoot('morph');
  await wait(1400);
  // Frame timing across a full collapse -> expand morph, measured in the page.
  await run(`window.__island.set('compact')`);
  await wait(1400);
  const perf = await run(`new Promise((resolve) => {
    const gaps = [];
    let last = 0;
    const t0 = performance.now();
    window.__island.set('expanded', 'music');
    requestAnimationFrame(function frame(now) {
      if (last) gaps.push(now - last);
      last = now;
      if (now - t0 < 900) return requestAnimationFrame(frame);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      resolve({ frames: gaps.length, avgMs: +avg.toFixed(2), worstMs: +Math.max(...gaps).toFixed(2), over20ms: gaps.filter((g) => g > 20).length });
    });
  })`);
  // The same for the pull-down: tucked line -> she drags it open -> she hops to her seat.
  await run(`window.__island.set('tucked')`);
  await wait(1400);
  const pullPerf = await run(`new Promise((resolve) => {
    const gaps = [];
    let last = 0;
    const t0 = performance.now();
    window.__island.pull();
    requestAnimationFrame(function frame(now) {
      if (last) gaps.push(now - last);
      last = now;
      if (now - t0 < 1200) return requestAnimationFrame(frame);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      resolve({ frames: gaps.length, avgMs: +avg.toFixed(2), worstMs: +Math.max(...gaps).toFixed(2), over20ms: gaps.filter((g) => g > 20).length });
    });
  })`);
  const report = await run('window.__island.state()');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ perf, pullPerf, state: report }, null, 2));
  app.quit();
}

// ---------- pull-down demo (npm run demo:pull / record:pull) ----------
// Live: tucks and pulls down again every few seconds for about a minute, then quits.
async function demoPullLoop() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (code) => win.webContents.executeJavaScript(code);
  await wait(2000);
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    await run(`window.__island.set('tucked')`);
    await wait(1800);
    await run(`window.__island.pull()`);
    await wait(2600);
  }
  app.quit();
}

// Recorded: one pull (and the tuck back) from the real window, cropped to the island, flattened onto
// a dark desktop colour and written as an animated PNG, plus a contact sheet of evenly spaced frames.
// It is recorded in slow motion (springs and CSS animations both slowed) and written back at true
// speed, because a screen grabber can't keep up with every frame of the real thing.
async function recordPull() {
  const { encodeAPNG, encodePNG, flattenBGRA } = require('../scripts/apng.js');
  const RATE = 0.25;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (code) => win.webContents.executeJavaScript(code);
  const now = () => Number(process.hrtime.bigint() / 1000000n);
  const dir = path.join(__dirname, '..', 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const crop = { x: Math.round(CX - 125), y: 0, width: 260, height: 128 };
  const BG = [30, 30, 32];
  const frames = [];
  let scale = 1;
  const keep = (image) => {
    scale = image.getSize().width / WIN_W;
    const c = image.crop({
      x: Math.round(crop.x * scale), y: 0,
      width: Math.round(crop.width * scale), height: Math.round(crop.height * scale)
    });
    frames.push({ t: now(), image: c });
  };

  await wait(2500);
  await run(`window.__island.set('tucked')`);
  await wait(1500);
  keep(await win.webContents.capturePage()); // the still, tucked start
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Animation.enable');
  // This slows CSS animations and the frame timestamps the page's springs run on, together.
  await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: RATE });
  await wait(300);
  win.webContents.beginFrameSubscription(false, (image) => {
    if (frames.length && now() - frames[frames.length - 1].t < 16 / RATE) return; // ~60 fps of animation
    keep(image);
  });
  const pullAt = now();
  await run(`window.__island.pull()`);
  await wait(1500 / RATE);
  const tuckAt = now();
  await run(`window.__island.set('tucked')`);
  await wait(800 / RATE);
  win.webContents.endFrameSubscription();

  const { width: w, height: h } = frames[0].image.getSize();
  const rgba = frames.map((f) => flattenBGRA(f.image.toBitmap(), BG));
  // Frame i shows until frame i+1 was painted, in animation time. The tucked still holds 700 ms.
  const delays = frames.map((f, i) => (i === 0 ? 700 : i + 1 < frames.length ? (frames[i + 1].t - f.t) * RATE : 900));
  fs.writeFileSync(path.join(dir, 'pull-demo.png'), encodeAPNG(rgba, w, h, delays));

  // Contact sheet: 18 frames spread over the pull itself (not the tuck back), 6 per row.
  const cols = 6;
  const pullFrames = frames.map((f, i) => ({ i, t: f.t })).filter((f) => f.t >= pullAt && f.t < tuckAt);
  const picks = Array.from({ length: 18 }, (_, n) => pullFrames[Math.round((n * (pullFrames.length - 1)) / 17)].i);
  const gap = 4;
  const sw = cols * w + (cols + 1) * gap;
  const sh = 3 * h + 4 * gap;
  const sheet = Buffer.alloc(sw * sh * 4, 0);
  for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;
  picks.forEach((fi, n) => {
    const src = rgba[Math.min(fi, rgba.length - 1)];
    const ox = gap + (n % cols) * (w + gap);
    const oy = gap + Math.floor(n / cols) * (h + gap);
    for (let y = 0; y < h; y++) src.copy(sheet, ((oy + y) * sw + ox) * 4, y * w * 4, (y + 1) * w * 4);
  });
  fs.writeFileSync(path.join(dir, 'pull-sheet.png'), encodePNG(sheet, sw, sh));
  fs.writeFileSync(path.join(dir, 'pull-frames.json'), JSON.stringify({
    frames: frames.length, size: [w, h], scale, rate: RATE,
    animMsPerFrame: delays.slice(1, -1).reduce((a, b) => a + b, 0) / Math.max(1, delays.length - 2),
    picksAnimMs: picks.map((i) => Math.round((frames[i].t - pullAt) * RATE))
  }));
  app.quit();
}

// ---------- self-test (npm run selftest) ----------
// Drives the hover/click state machine with synthetic input and writes captures/selftest.json.
// Synthetic events skip the OS, so this can't prove click-through over other apps.
async function selfTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => win.webContents.executeJavaScript('window.__island.state()');
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  // The cursor feed alone, as the real island sees the pointer while it's click-through.
  const feed = (x, y) => win.webContents.send('cursor', { x, y });
  const click = (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const centre = (sel) => win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const log = [];
  const record = async (step, extra = {}) => {
    const s = await state();
    log.push({ step, mode: s.mode, page: s.page, target: s.target, interactive, ...extra });
  };

  await wait(1500);
  await record('start (expect tucked into the line)');
  feed(CX, 3);
  await wait(80);
  await record('[cursor feed] pointer on the line +80ms (expect still tucked, not interactive)');
  await wait(220);
  await record('+300ms (expect dropping: compact, interactive, she is pulling)', { pulling: (await state()).buddy.pulling });
  await wait(1200);
  await record('+1500ms (expect expanded, after she let go)', { pulling: (await state()).buddy.pulling });
  await wait(700);
  for (const page of ['music', 'messages', 'calendar']) {
    const at = await centre(`.dock-btn[data-page="${page}"]`);
    move(at.x, at.y);
    click(at.x, at.y);
    await wait(700);
    await record(`click ${page} dock button (expect page ${page})`, { at });
    if (page !== 'music' || !(await state()).media.active) continue;
    // Seek: a click at 50%, then a drag from 25% to 75%. Recorded, not sent to the player.
    const bar = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-scrub]').getBoundingClientRect();
      return { x: r.left, y: Math.round(r.top + r.height / 2), w: r.width };
    })()`);
    const before = demoCommands.length;
    const at50 = Math.round(bar.x + bar.w * 0.5);
    move(at50, bar.y);
    click(at50, bar.y);
    await wait(300);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(bar.x + bar.w * 0.25), y: bar.y, button: 'left', clickCount: 1 });
    for (const f of [0.35, 0.5, 0.65, 0.75]) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bar.x + bar.w * f), y: bar.y, modifiers: ['leftButtonDown'] });
      await wait(40);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(bar.x + bar.w * 0.75), y: bar.y, button: 'left', clickCount: 1 });
    await wait(300);
    const s = await state();
    await record('seek: click at 50%, then drag 25%->75% (expect two seeks)', {
      seeks: demoCommands.slice(before).filter((c) => c.startsWith('seek')),
      duration: s.media.duration,
      shownPosition: Math.round(s.media.position)
    });

    // Loop: right-click at 30% -> "Loop from here", right-click at 60% -> "Loop until here", then
    // pretend the song reached the end mark while playing (expect a jump back), then clear it.
    const rightClick = (x, y) => {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    };
    const loopFrom = demoCommands.length;
    const at30 = Math.round(bar.x + bar.w * 0.3);
    const at60 = Math.round(bar.x + bar.w * 0.6);
    move(at30, bar.y);
    rightClick(at30, bar.y);
    await wait(350);
    const menuOpened = (await state()).loop.menuOpen;
    let item = await centre('[data-loop-set="a"]');
    move(item.x, item.y);
    click(item.x, item.y);
    await wait(250);
    move(at60, bar.y);
    rightClick(at60, bar.y);
    await wait(350);
    item = await centre('[data-loop-set="b"]');
    move(item.x, item.y);
    click(item.x, item.y);
    await wait(250);
    const looped = (await state()).loop;
    const setJumps = demoCommands.length - loopFrom;
    await win.webContents.executeJavaScript(`window.__island.testPosition(${looped.b - 0.1}, 'Playing')`);
    await wait(300);
    const endJumps = demoCommands.slice(loopFrom + setJumps).filter((c) => c.startsWith('seek'));
    const chip = await centre('[data-loop-chip]');
    move(chip.x, chip.y);
    click(chip.x, chip.y);
    await wait(200);
    const cleared = (await state()).loop;
    await record('loop: right-click 30% start / 60% end, reach the end, clear chip (expect jump to start)', {
      menuOpened,
      loop: `${Math.round(looped.a)}-${Math.round(looped.b)}s active=${looped.active}`,
      jumpAtEnd: endJumps.join(','),
      cleared: cleared.a == null && cleared.b == null && !cleared.active
    });
  }
  feed(10, WIN_H - 10);
  await wait(60);
  await record('[cursor feed] pointer to empty space +60ms (expect not interactive)');
  await wait(800);
  await record('pointer away +860ms (expect tucked again)');
  // Notes: click into the pad, type, Esc. Demo mode never saves, so nothing real is touched.
  move(CX, 3);
  await wait(1700);
  {
    const at = await centre('.dock-btn[data-page="notes"]');
    move(at.x, at.y);
    click(at.x, at.y);
    await wait(600);
    const pad = await centre('[data-notes]');
    move(pad.x, pad.y);
    click(pad.x, pad.y);
    await wait(200);
    await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('[data-notes]'); n.setSelectionRange(n.value.length, n.value.length); })()`);
    for (const ch of '\nok') win.webContents.sendInputEvent({ type: 'char', keyCode: ch === '\n' ? '\r' : ch });
    await wait(150);
    const typed = await win.webContents.executeJavaScript(`document.querySelector('[data-notes]').value.endsWith('\\nok')`);
    await record('type in notes (expect editing, text typed)', { typed, focusable: win.isFocusable(), editing: (await state()).editing });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(200);
    await record('Esc (expect editing off, not focusable)', { focusable: win.isFocusable(), editing: (await state()).editing });
  }
  // Flashcards: open the page, flip the card, grade it "Got it". Demo mode doesn't save the boxes.
  {
    const tab = await centre('.dock-btn[data-page="japanese"]');
    move(tab.x, tab.y);
    click(tab.x, tab.y);
    await wait(700);
    const before = (await state()).japanese;
    const card = await centre('[data-jp-stage] .fc:not(.leaving)');
    move(card.x, card.y);
    click(card.x, card.y);
    await wait(500);
    const flipped = (await state()).japanese.flipped;
    const good = await centre('[data-jp-grade="good"]');
    move(good.x, good.y);
    click(good.x, good.y);
    await wait(700);
    const after = (await state()).japanese;
    await record('flashcard: flip, then Got it (expect flipped, box up, new card)', {
      flipped,
      gradedBox: after.seen > before.seen || after.card !== before.card,
      newCard: after.card !== before.card,
      flippedAfter: after.flipped
    });
  }
  move(10, WIN_H - 10);
  await wait(900);
  await record('pointer away again (expect tucked)');
  // Drop the pill, then wheel over it before it opens: the volume HUD. The delta is 0: no change.
  move(CX, 3);
  await wait(260);
  move(CX, 18);
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: CX, y: 18, deltaX: 0, deltaY: 0, wheelTicksY: 0 });
  await wait(120);
  await record('wheel over pill (expect hud)');

  const dir = path.join(__dirname, '..', 'captures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'selftest.json'), JSON.stringify(log, null, 2));
  app.quit();
}

// ---------- IPC ----------
ipcMain.on('island:interactive', (_e, on) => setInteractive(!!on));
ipcMain.on('island:hide', () => win && win.hide());
ipcMain.on('island:quit', () => app.quit());
ipcMain.on('island:focus-input', () => {
  if (!win) return;
  setFocusable(true);
  win.focus();
});
ipcMain.on('island:release-focus', () => {
  if (!win) return;
  setFocusable(false);
  win.blur();
});
ipcMain.on('bridge:command', (_e, cmd) => {
  if (typeof cmd !== 'string' || !BRIDGE_COMMAND.test(cmd)) return;
  if (DEMO) { demoCommands.push(cmd); return; }
  if (bridge) bridge.stdin.write(cmd + '\n');
});
ipcMain.on('open:whatsapp', () => shell.openExternal('whatsapp://'));
ipcMain.on('open:calendar', () => shell.openExternal('https://calendar.google.com/calendar/r'));
ipcMain.handle('calendar:paste', () => pasteCalendarLink());
ipcMain.handle('calendar:import', () => importCalendar());
ipcMain.on('calendar:refresh', () => refreshCalendar('island'));
ipcMain.handle('state:current', () => {
  log(`window loaded (calendar configured=${last.calendar.configured}, events=${last.calendar.events.length})`);
  return { ...last };
});
ipcMain.on('island:log', (_e, text) => log('window:', String(text).slice(0, 2000)));

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  if (SET_LOGIN) {
    setOpenAtLogin(SET_LOGIN === 'on');
    console.log(`open at sign-in: ${opensAtLogin() ? 'on' : 'off'}`);
    app.quit();
    return;
  }
  if (CHECK_CALENDAR) {
    await refreshCalendar('check');
    const c = last.calendar;
    const now = Date.now();
    const report = {
      configured: c.configured,
      source: c.source || null,
      importedAt: c.importedAt ? new Date(c.importedAt).toISOString() : null,
      error: c.error || null,
      events: (c.events || []).length,
      allDay: (c.events || []).filter((e) => e.allDay).length,
      upcoming: (c.events || []).filter((e) => e.end > now).length
    };
    fs.mkdirSync(path.join(__dirname, '..', 'captures'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'captures', 'calendar-check.json'), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }
  log(`start: v${app.getVersion()}, ${Math.round(os.uptime())} s after Windows started`);
  last.character = readCharacter();
  createWindow();
  startBridge();
  // Test runs drive the page with synthetic input (and selftest feeds its own cursor positions).
  if (!DEMO) watchCursor();
  if (!DEMO) {
    buildTray();
    scheduleCalendar();
    // After sleep or a locked screen the calendar may be hours old; give the network a moment first.
    for (const event of ['resume', 'unlock-screen']) {
      powerMonitor.on(event, () => setTimeout(() => scheduleCalendar(event), 5000));
    }
    if (!globalShortcut.register(SHORTCUT, () => toggleFromOutside())) {
      console.warn(`[island] ${SHORTCUT} is taken by another app; use the tray icon instead.`);
    }
  }
  screen.on('display-metrics-changed', place);
  screen.on('display-added', place);
  screen.on('display-removed', place);
});

app.on('before-quit', () => {
  quitting = true;
  if (bridge) bridge.stdin.end();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
