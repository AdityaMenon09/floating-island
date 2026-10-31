// Floating Island renderer: the mode machine (compact / hud / banner / expanded), the shell's spring
// morph, and every panel: clock, battery, eyes, character, media, volume, WhatsApp, calendar,
// Japanese flashcards, notes.
(function () {
  'use strict';

  const bridge = window.island;
  // Test runs (capture / selftest) pass ?demo: never load or save personal data then.
  const DEMO = new URLSearchParams(location.search).has('demo');
  // Errors in this page go to island.log in the data folder (the browser preview has no log).
  if (bridge.log) {
    window.addEventListener('error', (e) => bridge.log((e.error && e.error.stack) || e.message));
    window.addEventListener('unhandledrejection', (e) => bridge.log(`rejection: ${(e.reason && e.reason.stack) || e.reason}`));
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const shell = $('#shell');

  // ---------- motion tokens: CSS gets the same springs as JS, sampled into linear() ----------
  if (CSS.supports('transition-timing-function', 'linear(0, 1)')) {
    const set = (name, { easing, duration }) => {
      document.documentElement.style.setProperty(`--ease-${name}`, easing);
      document.documentElement.style.setProperty(`--dur-${name}`, `${duration}ms`);
    };
    set('spring', springEasing(0.5, 0.82));
    set('bounce', springEasing(0.36, 0.58));
  }

  // ---------- sizes ----------
  const SIZE = {
    tucked: { w: 52, h: 4, r: 2 },
    idle: { w: 148, h: 32, r: 16 },
    live: { w: 236, h: 32, r: 16 },
    hud: { w: 262, h: 36, r: 18 },
    banner: { w: 380, h: 68, r: 28 },
    home: { w: 548, h: 252, r: 32 },
    music: { w: 548, h: 252, r: 32 },
    messages: { w: 548, h: 252, r: 32 },
    calendar: { w: 548, h: 252, r: 32 },
    japanese: { w: 548, h: 230, r: 32 },
    notes: { w: 548, h: 252, r: 32 }
  };
  const EXPANDED_MIN_H = 230;
  const PAGES = ['home', 'music', 'messages', 'calendar', 'japanese', 'notes'];
  const BANNER_PAGE = { media: 'music', message: 'messages', event: 'calendar' };

  const views = $$('.view');
  const vExpanded = $('.view-expanded');
  const vBanner = $('.view-banner');

  const shape = new Spring({ ...SIZE.idle, top: 6 }, {
    precision: 0.05,
    onUpdate: (v) => {
      shell.style.top = `${v.top}px`;
      shell.style.width = `${v.w}px`;
      shell.style.height = `${v.h}px`;
      shell.style.borderRadius = `${Math.max(v.r, 0)}px`;
      vExpanded.style.height = `${Math.max(v.h, EXPANDED_MIN_H)}px`;
      followIsland(v);
    }
  });
  const squish = new Spring({ s: 1 }, {
    response: 0.3,
    damping: 0.55,
    precision: 0.0005,
    onUpdate: (v) => { shell.style.scale = v.s; }
  });

  const state = { mode: 'compact', page: 'home', hover: false, pinned: false, editing: false };
  let hoverTimer = 0;
  let leaveTimer = 0;
  let bannerTimer = 0;
  let hudTimer = 0;
  let dropTimer = 0;
  let tuckTimer = 0;

  // Auto-hide: at rest the island is tucked into a faint line at the top of the screen. Point at the
  // line and it drops down (the same spring grows the line into the pill, and on into the panel if
  // you stay); move away and it retracts. The line stays click-through until the island has dropped,
  // so it never blocks browser tabs underneath. Banners still drop down by themselves.
  const AUTOHIDE_KEY = 'island.autohide';
  const DROP_DWELL = 200;   // ms the pointer must rest on the line before the island drops
  const TUCK_DELAY = 600;   // ms after the pointer leaves the dropped pill before it retracts
  let autoHide = (() => {
    if (DEMO) return true;
    try { return localStorage.getItem(AUTOHIDE_KEY) !== 'off'; } catch { return true; }
  })();
  const restMode = () => (autoHide ? 'tucked' : 'compact');
  const inTuckZone = (x, y) => Math.abs(x - window.innerWidth / 2) <= 110 && y <= 12;

  function isLive() { return mediaPlaying(); }

  function targetSize() {
    if (state.mode === 'tucked') return { ...SIZE.tucked, top: 1 };
    if (state.mode === 'expanded') return { ...SIZE[state.page], top: 6 };
    if (state.mode === 'banner') return { ...SIZE.banner, top: 6 };
    if (state.mode === 'hud') return { ...SIZE.hud, top: 6 };
    const base = isLive() ? SIZE.live : SIZE.idle;
    // Hovering the pill lifts it a touch before it opens: instant feedback, then the morph.
    return state.hover ? { w: base.w + 14, h: base.h + 4, r: base.r + 2, top: 6 } : { ...base, top: 6 };
  }

  function drop() {
    dropTimer = 0;
    if (state.mode !== 'tucked') return;
    if (canPull()) {
      // She pulls it down; the panel opens once she's let go, if the pointer is still there.
      state.hover = true;
      bridge.setInteractive(true);
      startPull(() => {
        if (state.hover && state.mode === 'compact') hoverTimer = setTimeout(() => expand(), 140);
      });
      return;
    }
    state.mode = 'compact';
    layout();
    setHover(true); // the pointer is on it; staying there opens the panel too
  }

  function scheduleTuck() {
    clearTimeout(tuckTimer);
    tuckTimer = setTimeout(() => {
      if (!state.hover && state.mode === 'compact' && autoHide) { state.mode = 'tucked'; layout(); }
    }, TUCK_DELAY);
  }

  function layout() {
    // Anything other than the dropped pill (a banner, the panel, tucking away) ends a pull early.
    if (pull && state.mode !== 'compact') endPull(false);
    const t = targetSize();
    const cur = shape.target;
    const growing = t.w * t.h > cur.w * cur.h + 1;
    // Growing: a little overshoot reads as fluid. Shrinking: settle cleanly into the notch.
    // (While she's dragging it open, her fall sets the size instead.)
    if (!(pull && pull.driving)) shape.to(t, growing ? { response: 0.52, damping: 0.72 } : { response: 0.44, damping: 0.9 });
    for (const v of views) v.classList.toggle('is-active', v.dataset.view === state.mode);
    shell.dataset.mode = state.mode;
    shell.classList.toggle('live', isLive());
    shell.classList.toggle('hover', state.hover);
    buddy.classList.toggle('lean', state.hover && state.mode !== 'expanded');
    followIsland(shape.value);
  }

  function expand(page) {
    clearTimeout(hoverTimer);
    clearTimeout(bannerTimer);
    clearTimeout(hudTimer);
    if (state.mode !== 'expanded') {
      setPage(page || 'home', { instant: true });
      refreshCalendarIfStale();
    } else if (page) {
      setPage(page);
    }
    state.mode = 'expanded';
    layout();
  }

  function collapse() {
    clearTimeout(leaveTimer);
    closeMenu();
    if (state.editing) { endEditing(); bridge.releaseFocus(); }
    shell.classList.remove('cal-edit');
    state.mode = state.hover ? 'compact' : restMode();
    state.pinned = false;
    layout();
  }

  function showBanner(kind, ms) {
    if (state.mode === 'expanded' || state.mode === 'hud' || state.hover) return;
    vBanner.dataset.kind = kind;
    state.mode = 'banner';
    layout();
    buddyReact('hop');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      if (state.mode === 'banner' && !state.hover) { state.mode = restMode(); layout(); }
    }, ms);
  }
  const bannerPage = () => BANNER_PAGE[vBanner.dataset.kind] || 'home';

  function showHud() {
    if (state.mode === 'expanded') return;
    clearTimeout(hoverTimer);
    clearTimeout(bannerTimer);
    clearTimeout(hudTimer);
    state.mode = 'hud';
    layout();
    hudTimer = setTimeout(() => {
      if (state.mode !== 'hud') return;
      state.mode = state.hover ? 'compact' : restMode();
      layout();
      if (state.hover) scheduleTuck();
    }, 1300);
  }

  // ---------- pointer ----------
  // Outside the shell the window is click-through; tell the main process when the pointer is over it.
  function pointerInside(x, y) {
    const r = shell.getBoundingClientRect();
    if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 6 && y <= r.bottom + 4) return true;
    // While it grows (a drop, an expand), the shape it's heading for counts too, so a pointer that
    // moves faster than the spring isn't treated as having left.
    const t = pull ? targetSize() : shape.target;
    const half = t.w / 2;
    const cx = window.innerWidth / 2;
    if (x >= cx - half - 4 && x <= cx + half + 4 && y >= t.top - 6 && y <= t.top + t.h + 4) return true;
    if (buddy.hidden) return false;
    // The character counts as part of the island (a slightly inset box: the image has margins).
    const b = buddy.getBoundingClientRect();
    return x >= b.left + b.width * 0.12 && x <= b.right - b.width * 0.12 && y >= b.top && y <= b.bottom - b.height * 0.05;
  }

  function setHover(on) {
    if (on === state.hover) return;
    if (!on && (volDragging || scrub || loopDragging)) return; // keep a slider's clicks while it's dragged
    state.hover = on;
    bridge.setInteractive(on);
    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);
    clearTimeout(tuckTimer);
    if (on) {
      state.pinned = false;
      if (state.mode === 'compact' || state.mode === 'banner') {
        const page = state.mode === 'banner' ? bannerPage() : undefined;
        layout();
        hoverTimer = setTimeout(() => expand(page), 170);
      } else if (state.mode === 'hud') {
        layout();
      }
    } else if (state.mode === 'expanded') {
      // While you're typing a note the island stays open; it closes when you click elsewhere.
      if (!state.pinned && !state.editing) leaveTimer = setTimeout(collapse, 420);
    } else {
      layout();
      if (state.mode === 'banner') {
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => { state.mode = restMode(); layout(); }, 1500);
      } else if (state.mode === 'compact') {
        scheduleTuck();
      }
    }
  }

  function onPointer(x, y) {
    if (state.mode === 'tucked') {
      // Not interactive yet: only start the drop once the pointer has rested on the line.
      const onLine = inTuckZone(x, y);
      if (onLine && !dropTimer) dropTimer = setTimeout(drop, DROP_DWELL);
      if (!onLine && dropTimer) { clearTimeout(dropTimer); dropTimer = 0; }
      return;
    }
    setHover(pointerInside(x, y));
  }

  function pointerGone() {
    clearTimeout(dropTimer);
    dropTimer = 0;
    setHover(false);
  }

  document.addEventListener('mousemove', (e) => onPointer(e.clientX, e.clientY));
  document.addEventListener('mouseleave', pointerGone);
  bridge.onPointerOut(() => {
    endVolumeDrag();
    endScrub(true);
    pointerGone();
  });

  shell.addEventListener('pointerdown', () => {
    if (state.mode !== 'expanded') squish.to({ s: 0.95 });
  });
  window.addEventListener('pointerup', () => squish.to({ s: 1 }));
  shell.addEventListener('click', () => {
    if (state.mode === 'compact' || state.mode === 'hud') expand();
    else if (state.mode === 'banner') expand(bannerPage());
  });

  bridge.onToggle(({ open }) => {
    if (open === true || state.mode !== 'expanded') {
      expand();
      state.pinned = true; // stays open until the pointer has been in and out, or the shortcut again
    } else {
      collapse();
    }
  });

  // ---------- pages and dock ----------
  const pages = $$('.page');
  const pagesEl = $('.pages');
  const dockBtns = $$('.dock-btn');
  const dockGlider = $('.dock-glider');
  const DOCK_W = 524 - 44; // the volume button sits at the right end
  const DOCK_GAP = 6;
  const ICON_W = 40;
  let labelW = [];

  function dockGeometry(active) {
    const widths = dockBtns.map((_, i) => (i === active ? 11 + 18 + 7 + labelW[i] + 15 : ICON_W));
    const total = widths.reduce((a, b) => a + b, 0) + DOCK_GAP * (widths.length - 1);
    const xs = [];
    let x = (DOCK_W - total) / 2 + 22;
    for (const w of widths) { xs.push(x); x += w + DOCK_GAP; }
    return { widths, xs };
  }

  const dockSpring = new Spring({}, {
    response: 0.46,
    damping: 0.8,
    precision: 0.05,
    onUpdate: (v) => dockBtns.forEach((b, i) => {
      b.style.left = `${v[`x${i}`]}px`;
      b.style.width = `${v[`w${i}`]}px`;
    })
  });

  // The highlight's two edges are separate springs and the leading edge is quicker, so it
  // stretches toward where it's going and catches up behind: a liquid feel.
  function edgeGlider(el) {
    const draw = () => {
      el.style.left = `${left.value.x}px`;
      el.style.width = `${Math.max(right.value.x - left.value.x, 0)}px`;
    };
    const left = new Spring({ x: 0 }, { precision: 0.05, onUpdate: draw });
    const right = new Spring({ x: 0 }, { precision: 0.05, onUpdate: draw });
    return (l, r, instant) => {
      if (instant) { left.jump({ x: l }); right.jump({ x: r }); return; }
      const movingRight = l > left.target.x;
      const lead = { response: 0.3, damping: 0.78 };
      const trail = { response: 0.5, damping: 0.86 };
      left.to({ x: l }, movingRight ? trail : lead);
      right.to({ x: r }, movingRight ? lead : trail);
    };
  }
  const moveDockGlider = edgeGlider(dockGlider);

  function moveDock(active, instant) {
    const { widths, xs } = dockGeometry(active);
    const t = {};
    widths.forEach((w, i) => { t[`w${i}`] = w; t[`x${i}`] = xs[i]; });
    dockBtns.forEach((b, i) => b.classList.toggle('is-active', i === active));
    if (instant) dockSpring.jump(t); else dockSpring.to(t);
    moveDockGlider(xs[active], xs[active] + widths[active], instant);
  }

  function setPage(page, { instant = false } = {}) {
    const idx = PAGES.indexOf(page);
    if (idx < 0) return;
    if (state.page !== page && state.editing) { endEditing(); bridge.releaseFocus(); }
    state.page = page;
    if (instant) pagesEl.classList.add('no-anim');
    // Matched by name, not DOM position: pages slide in dock order whatever order the markup has.
    pages.forEach((node) => {
      const i = PAGES.indexOf(node.dataset.page);
      node.style.setProperty('--dir', i < idx ? -1 : i > idx ? 1 : 0);
      node.classList.toggle('is-active', i === idx);
    });
    if (instant) { void pagesEl.offsetWidth; pagesEl.classList.remove('no-anim'); }
    const fresh = pages.find((node) => node.dataset.page === page);
    fresh.classList.add('fresh');
    setTimeout(() => fresh.classList.remove('fresh'), 900);
    moveDock(idx, instant);
    if (state.mode === 'expanded') layout();
    if (page === 'music') wakePetals();
  }

  dockBtns.forEach((b) => b.addEventListener('click', () => setPage(b.dataset.page)));
  $$('[data-open]').forEach((card) => card.addEventListener('click', (e) => {
    if (!e.target.closest('button')) setPage(card.dataset.open);
  }));

  // ---------- menu ----------
  const moreBtn = $('[data-more]');
  const menu = $('[data-menu]');
  function closeMenu() { menu.classList.remove('is-open'); moreBtn.classList.remove('is-open'); }
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', open);
    moreBtn.classList.toggle('is-open', open);
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
  menu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    closeMenu();
    if (action === 'calendar') { shell.classList.add('cal-edit'); setPage('calendar'); }
    if (action === 'buddy') setBuddyShown(buddy.hidden);
    if (action === 'autohide') setAutoHide(!autoHide);
    if (action === 'hide') { collapse(); setHover(false); bridge.hide(); }
    if (action === 'quit') bridge.quit();
  });

  function setAutoHide(on) {
    autoHide = on;
    if (!DEMO) try { localStorage.setItem(AUTOHIDE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    $('[data-autohide-toggle]').textContent = on ? 'Keep the pill visible' : 'Hide until pointed at';
    if (!on && state.mode === 'tucked') { state.mode = 'compact'; layout(); }
  }

  // ---------- rolling digits ----------
  function roll(el, text) {
    if (el.dataset.text === text) return;
    const prev = el.dataset.text || '';
    el.dataset.text = text;
    if (!el.classList.contains('roll') || prev.length !== text.length) {
      el.classList.add('roll');
      el.replaceChildren(...[...text].map((ch) => {
        const cell = document.createElement('span');
        cell.className = 'd';
        const s = document.createElement('span');
        s.textContent = ch;
        cell.append(s);
        return cell;
      }));
      return;
    }
    [...text].forEach((ch, i) => {
      if (prev[i] === ch) return;
      const cell = el.children[i];
      const old = cell.lastElementChild;
      old.className = 'out';
      const drop = () => old.remove();
      old.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 700);
      const s = document.createElement('span');
      s.className = 'in';
      s.textContent = ch;
      cell.append(s);
    });
  }

  // ---------- clock and battery ----------
  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  function tickClock() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    $$('[data-clock]').forEach((el) => roll(el, hm(now)));
    $('[data-date]').textContent = date.replace(',', '');
    setTimeout(tickClock, 1000 - (Date.now() % 1000) + 10);
  }

  const batteryEl = $('[data-battery]');
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const update = () => {
        const pct = Math.round(b.level * 100);
        batteryEl.style.setProperty('--level', `${pct}%`);
        $('.batt-text', batteryEl).textContent = `${pct}%`;
        batteryEl.classList.toggle('charging', b.charging);
        batteryEl.classList.toggle('low', !b.charging && pct <= 20);
      };
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
      update();
    }).catch(() => { batteryEl.hidden = true; });
  } else {
    batteryEl.hidden = true;
  }

  // ---------- eyes ----------
  // They follow the cursor anywhere on screen (main sends its position), blink at random,
  // and doze off after two minutes without movement.
  const eyeGroups = $$('[data-eyes]');
  const look = new Spring({ x: 0, y: 0 }, {
    response: 0.4,
    damping: 0.6,
    precision: 0.02,
    onUpdate: (v) => {
      shell.style.setProperty('--look-x', `${v.x.toFixed(2)}px`);
      shell.style.setProperty('--look-y', `${v.y.toFixed(2)}px`);
    }
  });
  let lastCursorAt = Date.now();
  let sleepy = false;

  function setSleepy(on) {
    sleepy = on;
    eyeGroups.forEach((g) => g.classList.toggle('sleepy', on));
    buddy.classList.toggle('sleepy', on);
    if (on) look.to({ x: 0, y: 1.6 });
  }

  function lookAt(x, y) {
    lastCursorAt = Date.now();
    if (sleepy) { setSleepy(false); blink(); }
    const r = shell.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + 16);
    look.to({ x: clamp(dx / 260, -1, 1) * 4.5, y: clamp(dy / 200, -1, 1) * 2.4 });
  }

  function blink() {
    eyeGroups.forEach((g) => { g.classList.remove('blink'); void g.offsetWidth; g.classList.add('blink'); });
    setTimeout(() => eyeGroups.forEach((g) => g.classList.remove('blink')), 200);
  }

  (function scheduleBlink() {
    setTimeout(() => {
      if (!sleepy) {
        blink();
        if (Math.random() < 0.18) setTimeout(blink, 260); // the occasional double blink
      }
      scheduleBlink();
    }, 2400 + Math.random() * 3800);
  })();
  setInterval(() => { if (!sleepy && Date.now() - lastCursorAt > 120000) setSleepy(true); }, 5000);
  // The cursor feed from main: the only way to notice the pointer while the window is click-through.
  bridge.onCursor(({ x, y }) => {
    lookAt(x, y);
    onPointer(x, y);
  });

  // ---------- media ----------
  let media = { active: false };
  let mediaAt = 0;
  let artUrl = null;
  const artCache = new Map();

  function mediaPlaying() { return media.active && media.status === 'Playing'; }

  function appName(id) {
    if (!id) return '';
    const known = { spotify: 'Spotify', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', vlc: 'VLC', zunemusic: 'Media Player' };
    const base = id.split(/[\\!]/).pop().replace(/\.exe$/i, '');
    const hit = Object.keys(known).find((k) => base.toLowerCase().includes(k));
    return hit ? known[hit] : base.replace(/^Microsoft\./, '').split('.')[0];
  }

  function mediaPosition() {
    if (!media.active) return 0;
    let pos = media.position || 0;
    if (mediaPlaying()) pos += (performance.now() - mediaAt) / 1000;
    return media.duration ? Math.min(pos, media.duration) : pos;
  }

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function renderMedia() {
    const on = media.active;
    const playing = mediaPlaying();
    shell.classList.toggle('media-on', on);
    shell.classList.toggle('media-playing', playing);
    buddy.classList.toggle('groove', playing);
    $$('[data-pp="media"]').forEach((b) => b.classList.toggle('is-playing', playing));
    $$('[data-media-title]').forEach((el) => { el.textContent = on ? media.title || 'Unknown title' : 'Nothing playing'; });
    $$('[data-media-artist]').forEach((el) => { el.textContent = on ? media.artist || '' : ''; });
    $$('[data-media-app]').forEach((el) => { el.textContent = on ? appName(media.app) : ''; });
    $$('[data-media-status]').forEach((el) => {
      el.textContent = !on ? 'Play something to see it here' : playing ? media.artist || 'Playing' : 'Paused';
    });
    $$('[data-cmd="prev"]').forEach((b) => { b.disabled = !on || media.canPrev === false; });
    $$('[data-cmd="next"]').forEach((b) => { b.disabled = !on || media.canNext === false; });
    $$('[data-cmd="toggle"]').forEach((b) => { b.disabled = !on; });
    scrubEl.classList.toggle('disabled', !canSeek());
    scrubEl.classList.toggle('playing', playing);
    wakePetals();
    renderLoop();
    applyArt(on ? artCache.get(media.key) || null : null);
    renderProgress();
    if (state.mode !== 'expanded') layout(); else shell.classList.toggle('live', isLive());
  }

  function renderProgress() {
    if (scrub && scrub.moved) return; // the drag owns the bar until it's let go
    const dur = media.duration || 0;
    const pos = mediaPosition();
    const frac = dur ? Math.min(pos / dur, 1) : 0;
    $$('[data-media-progress]').forEach((el) => { el.style.scale = `${frac} 1`; });
    scrubEl.style.setProperty('--p', frac.toFixed(4));
    $('[data-media-elapsed]').textContent = fmt(pos);
    $('[data-media-duration]').textContent = dur ? fmt(dur) : '–:––';
  }

  function applyArt(url) {
    if (url === artUrl) return;
    artUrl = url;
    $$('[data-media-art]').forEach((img) => {
      if (url) img.src = url; else img.removeAttribute('src');
    });
    tintFromArt(url);
  }

  // Sample the artwork's dominant colour (weighted toward saturated, mid-bright pixels) and use it
  // to tint the music card, the equaliser and the bars. --art is a registered colour property,
  // so the tint cross-fades when the track changes.
  function tintFromArt(url) {
    if (!url) {
      shell.style.removeProperty('--art');
      shell.style.removeProperty('--art-bright');
      petalColors = SAKURA;
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const max = Math.max(R, G, B), min = Math.min(R, G, B);
        const sat = max ? (max - min) / max : 0;
        const w = 0.15 + sat * (1 - Math.abs(max / 255 - 0.6));
        r += R * w; g += G * w; b += B * w; wsum += w;
      }
      r /= wsum; g /= wsum; b /= wsum;
      const lift = (v, k) => Math.round(v + (255 - v) * k);
      shell.style.setProperty('--art', `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`);
      shell.style.setProperty('--art-bright', `rgb(${lift(r, 0.45)} ${lift(g, 0.45)} ${lift(b, 0.45)})`);
      petalColors = artPalette(data, `rgb(${lift(r, 0.45)} ${lift(g, 0.45)} ${lift(b, 0.45)})`);
    };
    img.src = url;
  }

  function onMedia(m) {
    const prev = media;
    // Just after a seek the player may still report where it was; keep our position until it catches up.
    if (performance.now() < seekQuietUntil && prev.active && m.active && m.key === prev.key) {
      m = { ...m, position: mediaPosition() };
    }
    media = m;
    mediaAt = performance.now();
    const newTrack = prev.active && m.active && prev.key !== m.key;
    renderMedia();
    if (newTrack && m.status === 'Playing' && m.title) showBanner('media', 3200);
  }

  function onArt(a) {
    artCache.set(a.key, a.art);
    if (artCache.size > 20) artCache.delete(artCache.keys().next().value);
    if (media.active && a.key === media.key) applyArt(a.art);
  }

  $$('[data-cmd]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const cmd = b.dataset.cmd;
    bridge.command(cmd);
    if (cmd === 'toggle' && media.active) {
      // Answer the click at once; the bridge confirms within a second.
      media = { ...media, position: mediaPosition(), status: mediaPlaying() ? 'Paused' : 'Playing' };
      mediaAt = performance.now();
      renderMedia();
    }
  }));

  setInterval(() => { if (mediaPlaying()) renderProgress(); }, 250);

  // ---------- seeking ----------
  // Click the timeline to glide there; press and drag to scrub (the bar follows the pointer and the
  // time shows above it), and the song jumps when you let go.
  const scrubEl = $('[data-scrub]');
  const scrubTip = $('[data-scrub-tip]');
  const progressRow = $('.mp-progress');
  let scrub = null; // { frac, x0, moved } while the pointer is down
  let seekQuietUntil = 0;

  function canSeek() { return media.active && media.canSeek !== false && media.duration > 0; }

  const fracAt = (e) => {
    const r = scrubEl.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  function previewScrub(frac) {
    scrubEl.style.setProperty('--p', frac.toFixed(4));
    $$('[data-media-progress]').forEach((el) => { el.style.scale = `${frac} 1`; });
    $('[data-media-elapsed]').textContent = fmt(frac * media.duration);
  }

  function seekTo(seconds) {
    seconds = clamp(seconds, 0, media.duration);
    bridge.command(`seek ${seconds.toFixed(1)}`);
    media = { ...media, position: seconds };
    mediaAt = performance.now();
    seekQuietUntil = performance.now() + 2000;
    scrubEl.classList.add('seeking');
    setTimeout(() => scrubEl.classList.remove('seeking'), 800);
    renderProgress();
  }

  function endScrub(commit) {
    if (!scrub) return;
    const { frac } = scrub;
    scrub = null;
    scrubEl.classList.remove('dragging');
    progressRow.classList.remove('scrubbing');
    if (commit) seekTo(frac * media.duration); else renderProgress();
  }

  scrubEl.addEventListener('pointermove', (e) => {
    if (!canSeek()) return;
    const f = fracAt(e);
    scrubEl.style.setProperty('--hx', f.toFixed(4));
    scrubTip.textContent = fmt(f * media.duration);
    if (!scrub) return;
    scrub.frac = f;
    if (!scrub.moved && Math.abs(e.clientX - scrub.x0) > 3) {
      scrub.moved = true;
      scrubEl.classList.add('dragging');
      progressRow.classList.add('scrubbing');
    }
    if (scrub.moved) previewScrub(f);
  });
  scrubEl.addEventListener('pointerdown', (e) => {
    if (!canSeek() || e.button !== 0) return; // right-click is the loop menu, not a seek
    e.stopPropagation();
    scrub = { frac: fracAt(e), x0: e.clientX, moved: false };
    scrubEl.setPointerCapture(e.pointerId);
  });
  scrubEl.addEventListener('pointerup', () => endScrub(true));
  scrubEl.addEventListener('pointercancel', () => endScrub(false));

  // ---------- A-B loop (like Spicetify's Loopy Loop) ----------
  // Right-click the timeline to mark where a loop starts and ends; whenever the song reaches the end
  // mark, the island seeks back to the start. The markers can be dragged to fine-tune. It goes
  // through the same Windows media controls as seeking, so the jump is asked for a little early to
  // land on the mark. Changing tracks clears the loop.
  const LOOP_LEAD = 0.18;  // s before the end mark to ask for the jump (the round trip to the player)
  const loop = { a: null, b: null, key: null };
  const loopMenu = $('[data-loop-menu]');
  const loopChip = $('[data-loop-chip]');
  let loopMenuAt = 0;      // song time where the menu was opened
  let loopJumpUntil = 0;   // no second jump while the last one is landing
  let loopDragging = false;

  function loopActive() {
    return media.active && loop.key === media.key && loop.a != null && loop.b != null && loop.b - loop.a >= 1;
  }

  function renderLoop() {
    if (loop.key && loop.key !== media.key) { loop.a = loop.b = loop.key = null; }
    const dur = media.duration || 0;
    const frac = (v) => (v != null && dur ? clamp(v / dur, 0, 1) : null);
    const fa = frac(loop.a);
    const fb = frac(loop.b);
    scrubEl.style.setProperty('--la', (fa ?? fb ?? 0).toFixed(4));
    scrubEl.style.setProperty('--lb', (fb ?? fa ?? 0).toFixed(4));
    scrubEl.classList.toggle('loop-a', fa != null);
    scrubEl.classList.toggle('loop-b', fb != null);
    scrubEl.classList.toggle('looping', loopActive());
    const any = fa != null || fb != null;
    loopChip.hidden = !any;
    $('[data-loop-range]').textContent = loopActive()
      ? `${fmt(loop.a)}–${fmt(loop.b)}`
      : loop.a != null ? `from ${fmt(loop.a)}` : loop.b != null ? `until ${fmt(loop.b)}` : '';
  }

  function setLoop(which, seconds) {
    if (loop.key !== media.key) { loop.a = loop.b = null; loop.key = media.key; }
    loop[which] = clamp(seconds, 0, media.duration);
    if (loop.a != null && loop.b != null && loop.b < loop.a) [loop.a, loop.b] = [loop.b, loop.a];
    renderLoop();
    // Set while already past the end: jump into the loop now rather than at the end of the song.
    if (loopActive() && mediaPosition() > loop.b) seekTo(loop.a);
  }

  function clearLoop() {
    loop.a = loop.b = loop.key = null;
    renderLoop();
  }

  function closeLoopMenu() {
    loopMenu.classList.remove('is-open');
    if (!loopDragging) scrubEl.classList.remove('frozen');
  }

  scrubEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSeek()) return;
    loopMenuAt = fracAt(e) * media.duration;
    $$('[data-loop-at]', loopMenu).forEach((t) => { t.textContent = fmt(loopMenuAt); });
    $('[data-loop-clear]', loopMenu).hidden = loop.a == null && loop.b == null;
    // Above the timeline, centred on the pointer but kept inside the panel.
    const page = $('.page-music').getBoundingClientRect();
    const bar = scrubEl.getBoundingClientRect();
    loopMenu.style.left = `${clamp(e.clientX - page.left, 96, page.width - 96)}px`;
    loopMenu.style.bottom = `${page.bottom - bar.top + 4}px`;
    loopMenu.classList.add('is-open');
    scrubEl.classList.add('frozen'); // the waveform holds still while you pick the spot
  });
  loopMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const set = e.target.closest('[data-loop-set]');
    if (set) setLoop(set.dataset.loopSet, loopMenuAt);
    if (e.target.closest('[data-loop-clear]')) clearLoop();
    closeLoopMenu();
  });
  document.addEventListener('click', (e) => { if (!loopMenu.contains(e.target)) closeLoopMenu(); });
  document.addEventListener('pointerdown', (e) => { if (!loopMenu.contains(e.target)) closeLoopMenu(); });
  loopChip.addEventListener('click', (e) => { e.stopPropagation(); clearLoop(); });

  // Drag a marker to move that end of the loop.
  $$('[data-loop-mark]').forEach((mark) => {
    const which = mark.dataset.loopMark;
    let dragging = false;
    mark.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragging = loopDragging = true;
      mark.classList.add('dragging');
      scrubEl.classList.add('frozen');
      mark.setPointerCapture(e.pointerId);
    });
    mark.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      loop[which] = fracAt(e) * media.duration;
      scrubTip.textContent = fmt(loop[which]);
      renderLoop();
    });
    const end = () => {
      if (!dragging) return;
      dragging = loopDragging = false;
      mark.classList.remove('dragging');
      if (!loopMenu.classList.contains('is-open')) scrubEl.classList.remove('frozen');
      setLoop(which, loop[which]); // tidies the order and jumps in if needed
    };
    mark.addEventListener('pointerup', end);
    mark.addEventListener('pointercancel', end);
  });

  // ---------- the squiggle and the sakura petals ----------
  // The timeline is drawn on one canvas while the Music page is open: the played part is a squiggly
  // line in the artwork's colour that ripples while the song plays and flattens out when it's
  // paused; the rest is a straight dim line; the loop is pink. The played line glows, a soft light
  // pulses at the playhead, and petals in the artwork's colours drift off it with little twinkling
  // sparkles among them. Everything holds still while a loop is being set.
  const SAKURA = ['#ffc2d6', '#ff9ec4', '#ffe1eb'];
  const petalCanvas = $('[data-petals]');
  const petalCtx = petalCanvas.getContext('2d');
  const petals = [];
  let petalColors = SAKURA;
  let petalRaf = 0;
  let petalLast = 0;
  let petalDue = 0;
  let sparkleDue = 0;
  let squigglePhase = 0;
  let squiggleAmp = 0;
  let squiggleWidth = 3;

  // Up to three colours from the artwork: its strongest hues (by how many saturated pixels share
  // them), each lifted toward white so they read on the black island. A colourless cover falls back
  // to its overall tint.
  function artPalette(data, fallback) {
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0;
      if (sat < 0.25 || max < 60) continue;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const key = Math.floor((((h * 60) % 360) + 360) % 360 / 30);
      const s = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
      s.r += r * sat; s.g += g * sat; s.b += b * sat; s.w += sat;
      buckets.set(key, s);
    }
    const lift = (v) => Math.round(v + (255 - v) * 0.45);
    const picks = [...buckets.values()].sort((a, b) => b.w - a.w).slice(0, 3)
      .map((s) => `rgb(${lift(s.r / s.w)} ${lift(s.g / s.w)} ${lift(s.b / s.w)})`);
    return picks.length ? picks : [fallback];
  }

  function wakePetals() {
    if (!petalRaf) petalRaf = requestAnimationFrame(stepPetals);
  }

  function spawnPetal(x, y) {
    petals.push({
      x: x + (Math.random() - 0.5) * 3,
      y: y + (Math.random() - 0.5) * 8,
      vx: -(16 + Math.random() * 30),
      vy: -(8 + Math.random() * 22),
      spin: Math.random() * Math.PI * 2,
      vspin: (Math.random() - 0.5) * 6,
      sway: Math.random() * Math.PI * 2,
      size: 3 + Math.random() * 2.6,
      life: 1,
      fade: 1 / (1.1 + Math.random() * 0.8),
      color: petalColors[Math.floor(Math.random() * petalColors.length)]
    });
  }

  // A sparkle: a tiny four-point glint, half of them white, that twinkles as it floats up and fades.
  function spawnSparkle(x, y) {
    petals.push({
      spark: true,
      x: x + (Math.random() - 0.5) * 6,
      y: y + (Math.random() - 0.5) * 10,
      vx: -(8 + Math.random() * 26),
      vy: -(14 + Math.random() * 24),
      spin: 0,
      vspin: 0,
      sway: Math.random() * Math.PI * 2,
      twinkle: Math.random() * Math.PI * 2,
      size: 1.6 + Math.random() * 1.6,
      life: 1,
      fade: 1 / (0.6 + Math.random() * 0.7),
      color: Math.random() < 0.5 ? '#ffffff' : petalColors[Math.floor(Math.random() * petalColors.length)]
    });
  }

  function drawSparkle(p) {
    const tw = Math.sin(p.twinkle);
    const s = p.size * (0.8 + 0.2 * tw);
    const a = Math.min(1, p.life * 1.6) * (0.65 + 0.35 * tw);
    petalCtx.save();
    petalCtx.globalCompositeOperation = 'lighter';
    petalCtx.translate(p.x, p.y);
    petalCtx.fillStyle = p.color;
    petalCtx.globalAlpha = a * 0.22; // the halo
    petalCtx.beginPath();
    petalCtx.arc(0, 0, s * 1.6, 0, Math.PI * 2);
    petalCtx.fill();
    petalCtx.globalAlpha = a; // the glint: four points curving in to the centre
    petalCtx.beginPath();
    petalCtx.moveTo(0, -s * 2);
    petalCtx.quadraticCurveTo(0, 0, s * 2, 0);
    petalCtx.quadraticCurveTo(0, 0, 0, s * 2);
    petalCtx.quadraticCurveTo(0, 0, -s * 2, 0);
    petalCtx.quadraticCurveTo(0, 0, 0, -s * 2);
    petalCtx.fill();
    petalCtx.restore();
  }

  // A soft light at the playhead that breathes with the ripple; gone when paused.
  function drawGlint(x, y) {
    const strength = squiggleAmp / 3.2;
    if (strength < 0.02) return;
    const r = 9 + Math.sin(squigglePhase * 0.7) * 1.5;
    const glow = petalCtx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    petalCtx.save();
    petalCtx.globalCompositeOperation = 'lighter';
    petalCtx.globalAlpha = strength;
    petalCtx.fillStyle = glow;
    petalCtx.fillRect(x - r, y - r, r * 2, r * 2);
    petalCtx.restore();
  }

  function drawPetal(p) {
    const s = p.size;
    petalCtx.save();
    petalCtx.globalAlpha = Math.min(1, p.life * 1.4);
    petalCtx.translate(p.x, p.y);
    petalCtx.rotate(p.spin);
    petalCtx.fillStyle = p.color;
    // A teardrop with a little notch at the wide end: a cherry-blossom petal.
    petalCtx.beginPath();
    petalCtx.moveTo(0, s);
    petalCtx.quadraticCurveTo(s * 1.1, -s * 0.1, s * 0.35, -s);
    petalCtx.lineTo(0, -s * 0.7);
    petalCtx.lineTo(-s * 0.35, -s);
    petalCtx.quadraticCurveTo(-s * 1.1, -s * 0.1, 0, s);
    petalCtx.fill();
    petalCtx.restore();
  }

  // A straight stretch of the timeline from a to b, pink where it crosses the loop.
  function strokeRuns(a, b, y, plain, pink, loopX) {
    const cuts = [a, b, ...(loopX ? loopX.filter((x) => x > a && x < b) : [])].sort((m, n) => m - n);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      petalCtx.strokeStyle = loopX && mid >= loopX[0] && mid <= loopX[1] ? pink : plain;
      petalCtx.beginPath();
      petalCtx.moveTo(cuts[i], y);
      petalCtx.lineTo(cuts[i + 1], y);
      petalCtx.stroke();
    }
  }

  function drawSquiggle(x0, x1, headX, cy, loopX) {
    const art = getComputedStyle(shell).getPropertyValue('--art-bright').trim() || '#e7c3a6';
    const k = (2 * Math.PI) / 16; // one ripple every 16 px
    petalCtx.lineWidth = squiggleWidth;
    petalCtx.lineCap = 'round';
    petalCtx.lineJoin = 'round';
    // Played: the ripple, tapered to flat at the start and into the playhead, so it meets it cleanly,
    // with a soft glow in its own colour.
    const end = headX - 4;
    if (end > x0) {
      petalCtx.save();
      petalCtx.shadowBlur = 7;
      let colour = null;
      for (let x = x0; x <= end + 0.01; x += 1.5) {
        const xx = Math.min(x, end);
        const taper = Math.min(1, (xx - x0) / 8) * Math.min(1, (end - xx) / 10);
        const y = cy + squiggleAmp * taper * Math.sin((xx - x0) * k - squigglePhase);
        const c = loopX && xx >= loopX[0] && xx <= loopX[1] ? '#ff9ec4' : art;
        if (c !== colour) {
          if (colour) {
            petalCtx.lineTo(xx, y);
            petalCtx.stroke();
          }
          petalCtx.strokeStyle = petalCtx.shadowColor = colour = c;
          petalCtx.beginPath();
          petalCtx.moveTo(xx, y);
        } else {
          petalCtx.lineTo(xx, y);
        }
      }
      petalCtx.stroke();
      petalCtx.restore();
    }
    // Still to come: a straight, dim line.
    if (headX + 4 < x1) strokeRuns(headX + 4, x1, cy, 'rgba(255, 255, 255, 0.2)', 'rgba(255, 158, 196, 0.45)', loopX);
  }

  function stepPetals(now) {
    petalRaf = 0;
    const onPage = state.mode === 'expanded' && state.page === 'music' && media.active;
    if (!onPage) {
      petals.length = 0;
      petalCtx.clearRect(0, 0, petalCanvas.width, petalCanvas.height);
      petalLast = 0;
      return;
    }
    const dt = petalLast ? Math.min((now - petalLast) / 1000, 0.05) : 1 / 60;
    petalLast = now;
    const box = petalCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (petalCanvas.width !== Math.round(box.width * dpr) || petalCanvas.height !== Math.round(box.height * dpr)) {
      petalCanvas.width = Math.round(box.width * dpr);
      petalCanvas.height = Math.round(box.height * dpr);
    }
    petalCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    petalCtx.clearRect(0, 0, box.width, box.height);

    const frozen = scrubEl.classList.contains('frozen');
    const moving = mediaPlaying() && !reducedMotion.matches;
    const x0 = 12;
    const x1 = box.width - 12;
    const cy = 26 + 9;
    const p = clamp(parseFloat(scrubEl.style.getPropertyValue('--p')) || 0, 0, 1);
    const headX = x0 + p * (x1 - x0);
    const loopX = loopActive() ? [loop.a, loop.b].map((t) => x0 + clamp(t / media.duration, 0, 1) * (x1 - x0)) : null;
    if (!frozen) {
      squiggleAmp += ((moving ? 3.2 : 0) - squiggleAmp) * Math.min(1, dt * 5);
      if (moving) squigglePhase += dt * 6;
      const wide = scrubEl.matches(':hover') || scrubEl.classList.contains('dragging');
      squiggleWidth += ((wide ? 4 : 3) - squiggleWidth) * Math.min(1, dt * 12);
    }
    drawSquiggle(x0, x1, headX, cy, loopX);
    drawGlint(headX, cy);

    if (!frozen) {
      const headY = cy;
      if (moving && petals.length < 56) {
        petalDue += dt * 10;
        while (petalDue >= 1) { petalDue -= 1; spawnPetal(headX, headY); }
        sparkleDue += dt * 9;
        while (sparkleDue >= 1) { sparkleDue -= 1; spawnSparkle(headX, headY); }
      }
      for (let i = petals.length - 1; i >= 0; i--) {
        const q = petals[i];
        q.vy += (q.spark ? 12 : 38) * dt;      // a gentle fall; sparkles barely sink
        if (q.spark) q.twinkle += dt * 16;
        q.sway += dt * 3;
        q.x += (q.vx + Math.sin(q.sway) * 10) * dt;
        q.y += q.vy * dt;
        q.spin += q.vspin * dt;
        q.life -= q.fade * dt;
        if (q.life <= 0) petals.splice(i, 1);
      }
    }
    for (const q of petals) (q.spark ? drawSparkle : drawPetal)(q);
    petalRaf = requestAnimationFrame(stepPetals);
  }

  setInterval(() => {
    if (!loopActive() || !mediaPlaying() || (scrub && scrub.moved)) return;
    if (performance.now() < loopJumpUntil) return;
    if (mediaPosition() >= loop.b - LOOP_LEAD) {
      loopJumpUntil = performance.now() + 700;
      seekTo(loop.a);
    }
  }, 50);

  // ---------- volume ----------
  let volume = { level: 0, muted: false };
  let volDragging = false;
  let volQuietUntil = 0; // ignore the bridge's echo of older values right after a local change
  let volSendTimer = 0;

  function renderVolume() {
    const shown = volume.muted ? 0 : volume.level;
    shell.style.setProperty('--vol', shown.toFixed(3));
    shell.dataset.vol = volume.muted ? 'm' : volume.level < 0.005 ? '0' : volume.level < 0.5 ? '1' : '2';
    shell.classList.toggle('muted', volume.muted);
    $$('[data-vol-pct]').forEach((el) => {
      if (volume.muted) { el.dataset.text = ''; el.classList.remove('roll'); el.textContent = 'Muted'; }
      else roll(el, `${Math.round(volume.level * 100)}%`);
    });
  }

  function onVolume(v) {
    if (volDragging || performance.now() < volQuietUntil) return;
    volume = { level: v.level, muted: v.muted };
    renderVolume();
  }

  function setVolume(level) {
    volume.level = clamp(Math.round(level * 100) / 100, 0, 1);
    if (volume.level > 0) volume.muted = false;
    volQuietUntil = performance.now() + 700;
    renderVolume();
    if (!volSendTimer) {
      // At most one command every 40 ms while dragging or scrolling, always ending on the latest value.
      volSendTimer = setTimeout(() => {
        volSendTimer = 0;
        bridge.command(`volume ${volume.level.toFixed(2)}`);
      }, 40);
    }
  }

  function toggleMute() {
    volume.muted = !volume.muted;
    volQuietUntil = performance.now() + 700;
    renderVolume();
    bridge.command(volume.muted ? 'mute' : 'unmute');
  }

  // Listened for on the document with the same hit test as hover, so it works mid-drop too.
  document.addEventListener('wheel', (e) => {
    if (state.mode === 'tucked' || !pointerInside(e.clientX, e.clientY)) return;
    // Expanded, only the volume controls take the wheel; lists scroll as normal.
    if (state.mode === 'expanded' && !e.target.closest('.vol')) return;
    e.preventDefault();
    const notches = e.deltaMode === 0 ? clamp(Math.abs(e.deltaY) / 100, 0, 1) : 1;
    if (e.deltaY) setVolume(volume.level - Math.sign(e.deltaY) * notches * 0.02);
    if (state.mode !== 'expanded') showHud();
  }, { passive: false });

  $$('[data-mute]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); }));

  let dragSlider = null;
  function endVolumeDrag() {
    if (!dragSlider) return;
    dragSlider.classList.remove('dragging');
    dragSlider = null;
    volDragging = false;
    volQuietUntil = performance.now() + 700;
  }
  $$('[data-vol-slider]').forEach((slider) => {
    const at = (e) => {
      const r = slider.getBoundingClientRect();
      return (e.clientX - r.left) / r.width;
    };
    slider.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      volDragging = true;
      dragSlider = slider;
      slider.classList.add('dragging');
      slider.setPointerCapture(e.pointerId);
      setVolume(at(e));
    });
    slider.addEventListener('pointermove', (e) => { if (dragSlider === slider) setVolume(at(e)); });
    slider.addEventListener('pointerup', endVolumeDrag);
    slider.addEventListener('pointercancel', endVolumeDrag);
  });

  // ---------- WhatsApp ----------
  let messages = { unread: 0, readable: true, items: [] };
  let seenMessages = null; // ids already on screen when the island started never pop a banner
  const msgList = $('[data-msg-list]');

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' · ');

  function fillAvatar(node, name) {
    const first = [...String(name || '?').trim()][0] || '?';
    let hue = 0;
    for (const ch of String(name || '')) hue = (hue * 31 + ch.codePointAt(0)) % 360;
    node.textContent = first.toUpperCase();
    node.style.setProperty('--h', hue);
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function renderMessages() {
    const { items, unread, readable } = messages;
    $$('[data-unread-badge]').forEach((b) => {
      b.textContent = unread > 99 ? '99+' : String(unread);
      b.classList.toggle('on', unread > 0);
    });
    shell.classList.toggle('unread', unread > 0); // the tucked line glows green
    $('[data-msg-summary]').textContent = unread
      ? `${unread} unread chat${unread === 1 ? '' : 's'}`
      : items.length ? `${items.length} recent` : '';
    $('.page-messages').classList.toggle('empty', !items.length);
    const empty = $('[data-msg-empty]');
    empty.replaceChildren(el('div', '', null));
    empty.firstChild.append(
      el('b', '', readable ? 'No new messages' : 'Notification access is off'),
      el('span', '', readable ? 'WhatsApp notifications show up here.' : 'Turn it on in Settings > Privacy & security > Notifications.')
    );
    msgList.replaceChildren(...items.map((item, i) => {
      const row = el('div', 'row');
      row.style.setProperty('--i', i);
      const avatar = el('div', 'avatar');
      fillAvatar(avatar, item.title);
      const text = el('div', 'row-text');
      text.append(el('div', 'row-title', item.title || 'WhatsApp'), el('div', 'row-sub', oneLine(item.body)));
      const time = el('span', 'row-time', ago(item.time));
      time.dataset.time = item.time;
      row.append(avatar, text, time);
      row.addEventListener('click', () => bridge.openWhatsApp());
      return row;
    }));
  }

  function fillMessageBanner(item) {
    fillAvatar($('[data-banner-avatar]'), item.title);
    $('[data-banner-msg-title]').textContent = item.title || 'WhatsApp';
    $('[data-banner-msg-body]').textContent = oneLine(item.body);
  }

  function onMessages(m) {
    const items = m.items || [];
    const fresh = seenMessages ? items.filter((it) => !seenMessages.has(it.id)) : [];
    seenMessages = new Set([...(seenMessages || []), ...items.map((it) => it.id)]);
    messages = { unread: m.unread || 0, readable: m.readable !== false, items };
    renderMessages();
    const newest = fresh.sort((a, b) => b.time - a.time)[0];
    if (newest) {
      fillMessageBanner(newest);
      showBanner('message', 5000);
    }
  }

  $('[data-open-whatsapp]').addEventListener('click', (e) => { e.stopPropagation(); bridge.openWhatsApp(); });

  // ---------- calendar ----------
  let calendar = { configured: false, events: [] };
  const reminded = new Set();
  const calList = $('[data-cal-list]');
  const calError = $('[data-cal-error]');

  function dayLabel(t) {
    const day = new Date(t); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  }

  function until(t) {
    const m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return 'now';
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 12) return r ? `in ${h} h ${r} min` : `in ${h} h`;
    return '';
  }

  const upcoming = (now) => calendar.events.filter((e) => e.end > now);
  // A timed event first; failing that, an all-day one (a birthday, a holiday).
  const nextEvent = (now = Date.now()) => upcoming(now).find((e) => !e.allDay) || upcoming(now)[0] || null;

  function renderCalendar() {
    const now = Date.now();
    shell.classList.toggle('cal-on', !!calendar.configured);
    const events = upcoming(now).slice(0, 30);
    const todayCount = events.filter((e) => dayLabel(e.start) === 'Today' || e.start <= now).length;
    // Say how fresh this is: live from the link (and when it was last checked), or a one-off snapshot.
    const summary = $('[data-cal-summary]');
    if (!calendar.configured) {
      summary.textContent = 'Not connected';
    } else if (calendar.error) {
      summary.textContent = "Couldn't refresh";
      summary.title = calendar.error;
    } else if (calendar.source === 'link') {
      const mins = calendar.fetchedAt ? Math.round((now - calendar.fetchedAt) / 60000) : null;
      summary.replaceChildren(
        document.createTextNode(`${todayCount} today · `),
        el('span', 'live', 'Live'),
        document.createTextNode(mins == null ? '' : mins < 1 ? ', just checked' : `, checked ${mins} min ago`)
      );
      summary.title = '';
    } else {
      const day = calendar.importedAt ? new Date(calendar.importedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
      summary.textContent = `${todayCount} today · snapshot${day ? ` of ${day}` : ''}`;
      summary.title = "An exported copy: it won't show changes. Paste the calendar's secret link to keep it in sync.";
    }

    const rows = [];
    let lastDay = '';
    events.forEach((e, i) => {
      const day = e.start <= now ? 'Today' : dayLabel(e.start);
      if (day !== lastDay) { rows.push(el('div', 'day-head', day)); lastDay = day; }
      const ongoing = e.start <= now && !e.allDay;
      const row = el('div', `row${ongoing ? ' now' : ''}`);
      row.style.setProperty('--i', i);
      const text = el('div', 'row-text');
      const sub = e.allDay ? e.location : [`${hm(e.start)}–${hm(e.end)}`, e.location].filter(Boolean).join(' · ');
      text.append(el('div', 'row-title', e.title), el('div', 'row-sub', sub));
      row.append(
        el('span', 'ev-time', e.allDay ? 'All day' : hm(e.start)),
        el('span', 'ev-bar'),
        text,
        el('span', 'row-time', e.allDay ? '' : ongoing ? 'now' : until(e.start))
      );
      row.addEventListener('click', () => bridge.openCalendar());
      rows.push(row);
    });
    if (calendar.configured && !events.length) {
      const msg = el('div', 'list-empty');
      msg.style.display = 'flex';
      msg.append(el('div', '', calendar.error || 'Nothing in the next 7 days.'));
      rows.push(msg);
    }
    calList.replaceChildren(...rows);

    // Home card
    const card = $('.card-next');
    const label = $('[data-next-label]');
    const title = $('[data-next-title]');
    const when = $('[data-next-when]');
    const progress = $('[data-next-progress]');
    const e = nextEvent(now);
    let frac = 0;
    card.classList.remove('now');
    if (!calendar.configured) {
      label.textContent = 'Calendar';
      title.textContent = 'Connect Google Calendar';
      when.textContent = 'Click to set up';
    } else if (!e) {
      label.textContent = 'Up next';
      title.textContent = 'Nothing coming up';
      when.textContent = 'Next 7 days are clear';
    } else if (e.allDay) {
      label.textContent = 'Up next';
      title.textContent = e.title;
      when.textContent = `${e.start <= now ? 'Today' : dayLabel(e.start)} · all day`;
    } else if (e.start <= now) {
      card.classList.add('now');
      label.textContent = 'Now';
      title.textContent = e.title;
      when.textContent = `until ${hm(e.end)} · ${until(e.end).replace('in ', '')} left`;
      frac = (now - e.start) / (e.end - e.start);
    } else {
      label.textContent = 'Up next';
      title.textContent = e.title;
      when.textContent = `${hm(e.start)}–${hm(e.end)} · ${until(e.start) || dayLabel(e.start)}`;
    }
    progress.style.scale = `${clamp(frac, 0, 1)} 1`;
  }

  function fillEventBanner(e, phase) {
    $('[data-banner-event-title]').textContent = e.title;
    $('[data-banner-event-when]').textContent = phase === 'start'
      ? `Starting now · until ${hm(e.end)}`
      : `${until(e.start)} · ${hm(e.start)}–${hm(e.end)}`;
  }

  // A heads-up ten minutes before each timed event, and again as it starts.
  function checkReminders() {
    const now = Date.now();
    for (const e of calendar.events) {
      if (e.allDay) continue;
      const lead = e.start - now;
      if (lead > 0 && lead <= 10 * 60e3 && !reminded.has(`${e.id}:soon`)) {
        reminded.add(`${e.id}:soon`);
        fillEventBanner(e, 'soon');
        showBanner('event', 8000);
        return;
      }
      if (lead <= 0 && lead > -60e3 && !reminded.has(`${e.id}:start`)) {
        reminded.add(`${e.id}:start`);
        fillEventBanner(e, 'start');
        showBanner('event', 8000);
        return;
      }
    }
  }

  function onCalendar(c) {
    calendar = { configured: !!c.configured, events: c.events || [], error: c.error || null, source: c.source, importedAt: c.importedAt, fetchedAt: c.fetchedAt };
    $('[data-cal-refresh]').classList.remove('spinning');
    if (calendar.configured && !calendar.error && calError.classList.contains('ok')) calError.textContent = '';
    renderCalendar();
    checkReminders();
  }

  function showCalendarResult(r) {
    if (r.canceled) { calError.textContent = ''; return; }
    calError.classList.toggle('ok', !!r.ok);
    calError.textContent = r.ok ? r.message || 'Linked. Loading your events…' : r.error;
    if (r.ok) setTimeout(() => shell.classList.remove('cal-edit'), 1200);
  }

  $('[data-cal-paste]').addEventListener('click', async (e) => {
    e.stopPropagation();
    calError.classList.remove('ok');
    calError.textContent = 'Reading the clipboard…';
    showCalendarResult(await bridge.pasteCalendarLink());
  });
  $('[data-cal-import]').addEventListener('click', async (e) => {
    e.stopPropagation();
    calError.classList.remove('ok');
    calError.textContent = 'Choose the export…';
    state.pinned = true; // the file dialog takes the pointer away; stay open for the result
    showCalendarResult(await bridge.importCalendar());
  });
  $('[data-open-calendar]').addEventListener('click', (e) => { e.stopPropagation(); bridge.openCalendar(); });
  $('[data-cal-refresh]').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 8000); // in case no answer comes back
    bridge.refreshCalendar();
  });
  // Opening the island is a good moment to look for changes: if the last look is over a minute old,
  // failed, or never arrived (main skips it quickly when there's truly nothing set up).
  function refreshCalendarIfStale() {
    if (!calendar.configured || calendar.error || !calendar.fetchedAt || Date.now() - calendar.fetchedAt > 60000) bridge.refreshCalendar();
  }
  // From the tray: paste or import happened outside the island; show the outcome on the Calendar page.
  bridge.onCalendarResult((r) => {
    if (r.canceled) return;
    if (!r.ok) shell.classList.add('cal-edit');
    expand('calendar');
    state.pinned = true;
    showCalendarResult(r);
  });

  setInterval(() => {
    renderCalendar();
    checkReminders();
    $$('.page-messages .row-time').forEach((t) => { t.textContent = ago(+t.dataset.time); });
  }, 30000);

  // ---------- Japanese flashcards (kana and words from the Japanese tracker) ----------
  // Leitner boxes: "Got it" moves a card up a box, "Again" sends it back to box 1, and lower boxes
  // come round more often. About 10 cards are in play at once, in table order (あ い う…): each one
  // learned lets the next new one in. Home's mini card ignores all this and picks from the whole deck.
  const JP = window.JP_DATA || { kana: [], words: [] };
  const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const DECKS = {
    hira: { name: 'Hiragana', tag: 'ひらがな', cards: JP.kana.map((k) => ({ id: `h:${k.h}`, front: k.h, back: k.r })) },
    kata: { name: 'Katakana', tag: 'カタカナ', cards: JP.kana.map((k) => ({ id: `k:${k.h}`, front: toKata(k.h), back: k.r })) },
    words: { name: 'Words', tag: 'ことば', cards: JP.words.map((w) => ({ id: `w:${w.k}`, front: w.k, back: w.r[0], meaning: w.m })) }
  };
  const JP_KEY = 'island.japanese';
  const WEIGHT = [6, 8, 5, 3, 1.5, 0.6]; // by box; box 0 = not seen yet
  const LEARNED_BOX = 3;
  const IN_PLAY = 10;      // cards being learned at once
  const jp = (() => {
    const base = { deck: 'hira', boxes: {} };
    if (DEMO) return base;
    try { return { ...base, ...JSON.parse(localStorage.getItem(JP_KEY)) }; } catch { return base; }
  })();
  const saveJp = () => {
    if (DEMO) return;
    try { localStorage.setItem(JP_KEY, JSON.stringify(jp)); } catch { /* ignore */ }
  };
  try { localStorage.removeItem('island.focus'); } catch { /* the old focus timer's state */ }

  const recentCards = [];
  let jpCurrent = null;
  let miniCurrent = null;

  function pickCard(avoid = []) {
    const cards = DECKS[jp.deck].cards;
    const box = (c) => jp.boxes[c.id] || 0;
    const seen = cards.filter((c) => box(c) > 0);
    const learning = seen.filter((c) => box(c) < LEARNED_BOX).length;
    const fresh = cards.filter((c) => box(c) === 0).slice(0, Math.max(IN_PLAY - learning, 0));
    let pool = seen.concat(fresh).filter((c) => !avoid.includes(c.id));
    if (!pool.length) pool = cards.filter((c) => !avoid.includes(c.id));
    if (!pool.length) pool = cards;
    let roll = Math.random() * pool.reduce((sum, c) => sum + WEIGHT[box(c)], 0);
    for (const c of pool) { roll -= WEIGHT[box(c)]; if (roll <= 0) return c; }
    return pool[pool.length - 1];
  }

  function makeCard(card, deck) {
    const node = el('div', 'fc');
    const inner = el('div', 'fc-inner');
    const front = el('div', 'fc-face fc-front');
    front.append(el('span', 'fc-tag', DECKS[deck].tag));
    const glyph = el('span', 'fc-glyph', card.front);
    glyph.style.setProperty('--len', Math.min([...card.front].length, 6));
    front.append(glyph);
    const back = el('div', 'fc-face fc-back');
    back.append(el('span', 'fc-small', card.front), el('span', 'fc-romaji', card.back));
    if (card.meaning) back.append(el('span', 'fc-meaning', card.meaning));
    inner.append(front, back);
    node.append(inner);
    return node;
  }

  // The old card flies off (up for "Got it", aside for "Again") as the new one springs in.
  function swapCard(stage, card, how) {
    const old = stage.querySelector('.fc:not(.leaving)');
    if (old) {
      old.classList.add('leaving', how || 'good');
      setTimeout(() => old.remove(), 500);
    }
    const node = makeCard(card, jp.deck);
    node.classList.add('entering');
    stage.append(node);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('entering')));
    return node;
  }

  const jpStage = $('[data-jp-stage]');
  const jpPage = $('.page-japanese');
  const miniStage = $('[data-jp-mini-stage]');
  const miniCard = $('[data-jp-mini]');
  const deckChips = $$('[data-deck]');
  const moveDeckGlider = edgeGlider($('.jp-decks .chip-glider'));
  let deckGliderDrawn = false;

  function nextPageCard(how) {
    jpCurrent = pickCard(recentCards);
    recentCards.push(jpCurrent.id);
    if (recentCards.length > 3) recentCards.shift();
    jpPage.classList.remove('flipped');
    swapCard(jpStage, jpCurrent, how);
  }

  function nextMiniCard(how) {
    const cards = DECKS[jp.deck].cards;
    let next;
    do { next = cards[Math.floor(Math.random() * cards.length)]; }
    while (cards.length > 1 && miniCurrent && next.id === miniCurrent.id);
    miniCurrent = next;
    miniCard.classList.remove('flipped');
    swapCard(miniStage, miniCurrent, how);
  }

  function renderJapanese() {
    const deck = DECKS[jp.deck];
    const learned = deck.cards.filter((c) => (jp.boxes[c.id] || 0) >= LEARNED_BOX).length;
    const learnedEl = $('[data-jp-learned]');
    learnedEl.replaceChildren(document.createTextNode(`${deck.name} · `), el('b', '', String(learned)), document.createTextNode(` / ${deck.cards.length} learned`));
    $('[data-jp-bar]').style.scale = `${deck.cards.length ? learned / deck.cards.length : 0} 1`;
    $('[data-jp-deck-name]').textContent = deck.name;
    const active = deckChips.findIndex((c) => c.dataset.deck === jp.deck);
    deckChips.forEach((c, i) => c.classList.toggle('is-active', i === active));
    const chip = deckChips[active];
    if (chip) {
      moveDeckGlider(chip.offsetLeft, chip.offsetLeft + chip.offsetWidth, !deckGliderDrawn);
      deckGliderDrawn = true;
    }
  }

  function grade(result) {
    if (!jpCurrent || !jpPage.classList.contains('flipped')) return;
    const box = jp.boxes[jpCurrent.id] || 0;
    jp.boxes[jpCurrent.id] = result === 'good' ? Math.min(box + 1, 5) : 1;
    saveJp();
    buddyReact(result === 'good' ? 'hop' : 'shake');
    renderJapanese();
    nextPageCard(result);
  }

  jpStage.addEventListener('click', (e) => {
    const card = e.target.closest('.fc:not(.leaving)');
    if (!card) return;
    card.classList.toggle('flipped');
    jpPage.classList.toggle('flipped', card.classList.contains('flipped'));
  });
  $$('[data-jp-grade]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); grade(b.dataset.jpGrade); }));
  deckChips.forEach((c) => c.addEventListener('click', () => {
    if (jp.deck === c.dataset.deck) return;
    jp.deck = c.dataset.deck;
    saveJp();
    recentCards.length = 0;
    renderJapanese();
    nextPageCard('again');
    nextMiniCard('again');
  }));
  // Home's mini card: tap to flip, tap again for the next one. No grading there; that's the page's job.
  miniCard.addEventListener('click', () => {
    const card = miniStage.querySelector('.fc:not(.leaving)');
    if (card && !card.classList.contains('flipped')) {
      card.classList.add('flipped');
      miniCard.classList.add('flipped');
    } else {
      nextMiniCard('good');
    }
  });

  // ---------- character ----------
  // Sits behind the island at its right edge. Its own spring chases the island's shape every frame,
  // so it trails the morph a beat behind with a little bounce instead of being glued on.
  const buddy = $('[data-buddy]');
  const buddyBody = $('.buddy-body', buddy);
  const BUDDY_W = 70;
  const BUDDY_H = 96;
  const BUDDY_KEY = 'island.buddy';
  const buddySpring = new Spring({ x: 0, y: 0, s: 0.6 }, {
    response: 0.36,
    damping: 0.64,
    precision: 0.02,
    onUpdate: (v) => {
      if (pull) return; // the pull places her itself
      buddy.style.transform = `translate(${v.x.toFixed(2)}px, ${v.y.toFixed(2)}px) scale(${v.s.toFixed(4)})`;
    }
  });
  let buddyPlaced = false;

  function followIsland(v) {
    if (buddy.hidden || pull) return;
    const expanded = state.mode === 'expanded';
    const s = expanded ? 1 : state.mode === 'banner' ? 0.74 : 0.62;
    const w = BUDDY_W * s;
    const h = BUDDY_H * s;
    const right = window.innerWidth / 2 + v.w / 2;
    const target = {
      x: right - w * 0.24,
      // Resting: hangs from the top of the screen beside the pill. Open: perched on the bottom corner.
      // Tucked: slides up out of sight with the island, and drops back down a beat after it.
      y: state.mode === 'tucked' ? -h - 12 : expanded ? 6 + v.h - h * 0.8 : 1,
      s
    };
    if (!buddyPlaced) { buddySpring.jump(target); buddyPlaced = true; } else buddySpring.to(target);
  }

  function buddyReact(kind) {
    if (buddy.hidden) return;
    buddyBody.classList.remove('hop', 'shake');
    void buddyBody.offsetWidth;
    buddyBody.classList.add(kind);
  }
  buddyBody.addEventListener('animationend', () => buddyBody.classList.remove('hop', 'shake'));

  function setBuddyShown(on) {
    const hasImage = !!$('.buddy-img', buddy).getAttribute('src');
    buddy.hidden = !(on && hasImage);
    $('[data-buddy-toggle]').textContent = buddy.hidden ? 'Show character' : 'Hide character';
    $('[data-buddy-toggle]').hidden = !hasImage;
    if (!DEMO) try { localStorage.setItem(BUDDY_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    buddyPlaced = false;
    followIsland(shape.value);
  }

  // A newly chosen picture (tray > Change character…) is shown even if the old one had been hidden.
  function loadBuddy(url, justChosen = false) {
    const img = $('.buddy-img', buddy);
    if (url) img.src = url; else img.removeAttribute('src');
    let on = true;
    try { on = justChosen || DEMO || localStorage.getItem(BUDDY_KEY) !== 'off'; } catch { /* default on */ }
    setBuddyShown(on);
    if (justChosen && on) buddyReact('hop');
  }

  buddy.addEventListener('click', () => {
    buddyReact('hop');
    if (state.mode !== 'expanded') expand();
  });

  // ---------- she pulls the island down ----------
  // When the island drops from its line, she falls in from above the screen holding a cord hooked
  // to the line. Once the cord goes taut her fall drags the island open: its bottom edge follows her,
  // braking her as it stretches. Then she lets it go with what speed is left, so the island's own
  // spring overshoots and settles like a released blind, while she bounces and swings on the cord
  // for a moment and hops into her seat. Her pose never changes (one image); the cord sells the grab.
  const cord = $('[data-cord]');
  const cordLine = $('.cord-line', cord);
  const cordHook = $('.cord-hook', cord);
  const cordBead = $('.cord-bead', cord);
  const CORD_LEN = 26;               // px from the island's edge to her hand
  const HAND = { x: 0.72, y: 0.6 };  // where her hand is in the image, as fractions
  const PULL_SCALE = 0.62;
  const GRAVITY = 1100;              // px/s², her fall
  const CATCH = 0.65;                // speed she keeps when the cord snaps taut (the jolt)
  const BRAKE = 1300;                // px/s², how hard the island resists while she drags it
  const LET_GO = 0.75;               // she lets go this far open; the island's spring does the rest
  const YANK = 240;                  // px/s the island is flung open with as she lets go
  const SWING_FOR = 0.36;            // s of swinging before she hops to her seat
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let pull = null;

  function canPull() { return !buddy.hidden && !reducedMotion.matches; }

  const anchorX = () => window.innerWidth / 2 + 12;

  // Puts her hand at (hx, hy), tilted by `tilt` degrees about the hand, and draws the cord to it.
  function drawPull(ax, ay, hx, hy, tilt) {
    const s = PULL_SCALE;
    const x = hx - s * BUDDY_W * HAND.x;
    const y = hy - s * BUDDY_H * HAND.y;
    pull.box = { x, y };
    buddy.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s})`;
    buddy.style.setProperty('--swing', `${tilt.toFixed(2)}deg`);
    // Taut it's straight; slack it sags by however much cord is spare.
    const d = Math.hypot(hx - ax, hy - ay);
    const sag = d < CORD_LEN ? Math.sqrt(CORD_LEN * CORD_LEN - d * d) * 0.5 : 0;
    cordLine.setAttribute('d', `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${((ax + hx) / 2).toFixed(1)} ${((ay + hy) / 2 + sag).toFixed(1)} ${hx.toFixed(1)} ${hy.toFixed(1)}`);
    cordHook.setAttribute('cx', ax.toFixed(1));
    cordHook.setAttribute('cy', ay.toFixed(1));
    cordBead.setAttribute('cx', hx.toFixed(1));
    cordBead.setAttribute('cy', hy.toFixed(1));
  }

  function startPull(onDone) {
    // She starts just out of sight above the screen edge (her whole body above y = 0).
    pull = { phase: 'fall', driving: true, hy: -26, vy: 90, t: 0, last: 0, swing: null, box: null, onDone };
    buddySpring.jump({ ...buddySpring.value }); // stop her own spring; the pull places her now
    buddy.classList.add('pulling');
    cord.classList.add('on');
    state.mode = 'compact'; // the eyes start fading in as it opens
    layout();
    requestAnimationFrame(stepPull);
  }

  function stepPull(now) {
    const p = pull;
    if (!p) return;
    // Like the springs: catch up after a slow frame (in small steps) rather than slow the motion down.
    const dt = p.last ? Math.min((now - p.last) / 1000, 0.25) : 1 / 60;
    p.last = now;
    const pill = targetSize();
    const ax = anchorX();
    const lineBottom = 1 + SIZE.tucked.h;
    const pillBottom = pill.top + pill.h;

    if (p.driving) {
      const steps = Math.max(1, Math.ceil(dt * 240));
      const step = dt / steps;
      for (let i = 0; i < steps; i++) {
        if (p.phase === 'fall') p.vy += GRAVITY * step;
        else p.vy = Math.max(p.vy - BRAKE * step, 70);
        p.hy += p.vy * step;
        if (p.phase === 'fall' && p.hy - CORD_LEN >= lineBottom) {
          p.phase = 'drag';
          p.vy *= CATCH;
        }
        if (p.phase === 'drag' && (p.hy - CORD_LEN - lineBottom) / (pillBottom - lineBottom) >= LET_GO) break;
      }
      let bottom = lineBottom;
      if (p.phase === 'drag') bottom = Math.min(p.hy - CORD_LEN, pillBottom);
      // The line grows toward the pill as its bottom edge is dragged down.
      const k = clamp((bottom - lineBottom) / (pillBottom - lineBottom), 0, 1);
      const top = 1 + (pill.top - 1) * k;
      const h = Math.max(bottom - top, SIZE.tucked.h);
      shape.jump({ top, h, w: SIZE.tucked.w + (pill.w - SIZE.tucked.w) * k, r: Math.min(h / 2, pill.r) });
      drawPull(ax, top + h, ax, p.hy, 0);
      if (p.phase === 'drag' && k >= LET_GO) {
        // Let go: the island carries on with her speed, and its spring opens the rest of the way,
        // overshooting a little and settling like a released blind.
        p.driving = false;
        p.phase = 'swing';
        const widthPerHeight = (pill.w - SIZE.tucked.w) / (pill.h - SIZE.tucked.h);
        shape.to(pill, { response: 0.48, damping: 0.6, velocity: { h: YANK, w: YANK * widthPerHeight * 0.7 } });
        p.swing = new Spring({ hy: p.hy, th: 0 }, { response: 0.6, damping: 0.32, precision: 0.05 });
        p.swing.to({ hy: p.hy, th: 0 }, { velocity: { hy: 160, th: 140 } });
      }
    } else {
      // Bouncing and swinging on the cord, which hangs from the island's (still settling) bottom edge.
      p.t += dt;
      const bottom = shape.value.top + shape.value.h;
      const th = p.swing.value.th;
      const rad = (th * Math.PI) / 180;
      p.swing.to({ hy: bottom + CORD_LEN * Math.cos(rad) });
      drawPull(ax, bottom, ax + CORD_LEN * Math.sin(rad), p.swing.value.hy, -th);
      if (p.t >= SWING_FOR) { endPull(true); return; }
    }
    requestAnimationFrame(stepPull);
  }

  // Hands her back to her own spring. With `hop`, she springs up into her seat (the normal end);
  // without, she just goes wherever the island now wants her (the pull was cut short).
  function endPull(hop) {
    const p = pull;
    if (!p) return;
    pull = null;
    buddy.classList.remove('pulling');
    cord.classList.remove('on'); // gone the moment she lets go of it
    if (p.box) {
      buddySpring.jump({ x: p.box.x, y: p.box.y, s: PULL_SCALE });
      buddyPlaced = true;
    }
    followIsland(shape.value);
    if (hop) {
      buddySpring.to(buddySpring.target, { velocity: { y: -380 } });
      buddyReact('hop');
      if (p.onDone) p.onDone();
    }
  }

  // ---------- notes ----------
  // The window never takes keyboard focus, except while you're in the note: clicking the pad asks
  // main for focus; Esc, clicking elsewhere or closing the island hands it back.
  const NOTES_KEY = 'island.notes';
  const notes = $('[data-notes]');
  const notesState = $('[data-notes-state]');
  let notesSaveTimer = 0;

  if (DEMO) {
    notes.value = 'Buy oat milk\nCall the bank about the card\nIdea: show the next train on the island';
  } else {
    try { notes.value = localStorage.getItem(NOTES_KEY) || ''; } catch { /* start empty */ }
  }

  function saveNotes() {
    clearTimeout(notesSaveTimer);
    if (DEMO) return;
    try {
      localStorage.setItem(NOTES_KEY, notes.value);
      notesState.textContent = notes.value ? 'Saved' : '';
    } catch {
      notesState.textContent = 'Not saved';
    }
  }

  function endEditing() {
    if (!state.editing) return;
    state.editing = false;
    shell.classList.remove('editing');
    saveNotes();
    notes.blur();
  }

  notes.addEventListener('pointerdown', () => {
    if (state.editing) return;
    state.editing = true;
    shell.classList.add('editing');
    bridge.focusInput();
  });
  notes.addEventListener('input', () => {
    notesState.textContent = 'Editing…';
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(saveNotes, 400);
  });
  notes.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      endEditing();
      bridge.releaseFocus();
    }
  });
  bridge.onBlur(() => {
    if (!state.editing) return;
    endEditing();
    if (!state.hover && state.mode === 'expanded' && !state.pinned) collapse();
  });

  // ---------- debug hooks (used by `npm run capture` / `selftest` and the browser preview) ----------
  window.__island = {
    // A loop between two song times (seconds), as if set from the timeline's menu; nulls clear it.
    loop(a, b) {
      if (a == null && b == null) { clearLoop(); return; }
      setLoop('a', a);
      setLoop('b', b);
    },
    // Tests only: pretend the player reported this position and status.
    testPosition(seconds, status) {
      media = { ...media, position: seconds, status: status || media.status };
      mediaAt = performance.now();
      renderMedia();
    },
    // The drop as if the pointer had rested on the line (no hover, so the panel doesn't open after).
    pull() {
      if (state.mode !== 'tucked') return false;
      if (canPull()) startPull(null); else { state.mode = 'compact'; layout(); }
      return true;
    },
    set(mode, arg) {
      if (mode === 'expanded') { state.pinned = true; expand(arg); return; }
      collapse();
      clearTimeout(tuckTimer);
      if (mode === 'compact' || mode === 'tucked') { state.mode = mode; layout(); }
      if (mode === 'hud') { showHud(); clearTimeout(hudTimer); }
      if (mode === 'banner') {
        const kind = arg || 'media';
        if (kind === 'message' && messages.items[0]) fillMessageBanner(messages.items[0]);
        if (kind === 'event') {
          const e = nextEvent();
          if (e) fillEventBanner(e, 'soon');
        }
        showBanner(kind, 600000);
      }
    },
    state() {
      return {
        mode: state.mode,
        page: state.page,
        editing: state.editing,
        size: { ...shape.value },
        target: { ...shape.target },
        media: { active: media.active, status: media.status, title: media.title, duration: media.duration, position: mediaPosition(), canSeek: canSeek() },
        loop: { a: loop.a, b: loop.b, active: loopActive(), menuOpen: loopMenu.classList.contains('is-open') },
        hasArt: !!artUrl,
        volume: { ...volume },
        messages: { unread: messages.unread, count: messages.items.length },
        calendar: { configured: calendar.configured, count: calendar.events.length },
        japanese: {
          deck: jp.deck,
          card: jpCurrent && jpCurrent.id,
          flipped: jpPage.classList.contains('flipped'),
          box: jpCurrent ? jp.boxes[jpCurrent.id] || 0 : 0,
          seen: Object.keys(jp.boxes).length
        },
        buddy: { shown: !buddy.hidden, pulling: pull ? pull.phase : null, ...buddySpring.value }
      };
    }
  };

  // ---------- start ----------
  labelW = dockBtns.map((b) => $('.dock-label', b).scrollWidth);
  setPage('home', { instant: true });
  setAutoHide(autoHide);
  state.mode = restMode();
  shape.jump(targetSize());
  layout();
  tickClock();
  renderJapanese();
  nextPageCard();
  nextMiniCard();
  renderMedia();
  renderVolume();
  renderMessages();
  renderCalendar();
  bridge.onMedia(onMedia);
  bridge.onArt(onArt);
  bridge.onVolume(onVolume);
  bridge.onMessages(onMessages);
  bridge.onCalendar(onCalendar);
  bridge.onCharacter(({ url }) => loadBuddy(url, true));
  bridge.current().then((s) => {
    loadBuddy(s.character);
    if (s.art) onArt(s.art);
    if (s.media && s.media.active && !media.active) onMedia(s.media);
    if (s.volume) onVolume(s.volume);
    if (s.messages) onMessages(s.messages);
    if (s.calendar) onCalendar(s.calendar);
  });
})();
