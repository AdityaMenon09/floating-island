// Stand-in for the Electron bridge when the renderer is opened in a plain browser, so the island's
// design and motion can be previewed without Electron. All data here is made up. In the app,
// preload.js defines window.island first and this file does nothing.
if (!window.island) {
  (function () {
    document.documentElement.classList.add('preview');

    const tracks = [
      { title: 'Demo Track', artist: 'Preview Artist', album: 'Preview', duration: 187, hues: [18, 340] },
      { title: 'Second Song With A Longer Title', artist: 'Another Artist', album: 'Preview', duration: 214, hues: [200, 250] }
    ];
    let index = 0;
    let status = 'Playing';
    let position = 42;
    let at = Date.now();
    let volume = { type: 'volume', level: 0.55, muted: false };
    const listeners = {};
    const on = (name) => (fn) => { (listeners[name] = listeners[name] || []).push(fn); };
    const emit = (name, payload) => (listeners[name] || []).forEach((fn) => fn(payload));

    const keyOf = (t) => `Preview.exe|${t.title}|${t.artist}`;
    const artOf = (t) => 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${t.hues[0]} 70% 55%)"/><stop offset="1" stop-color="hsl(${t.hues[1]} 60% 22%)"/></linearGradient></defs>` +
      `<rect width="200" height="200" fill="url(#g)"/><circle cx="140" cy="60" r="38" fill="hsl(${t.hues[0]} 90% 80%)" opacity=".55"/></svg>`
    );

    function media() {
      const t = tracks[index];
      const pos = status === 'Playing' ? position + (Date.now() - at) / 1000 : position;
      return {
        type: 'media', active: true, key: keyOf(t), app: 'Spotify.exe',
        title: t.title, artist: t.artist, album: t.album, status,
        duration: t.duration, position: Math.min(pos, t.duration), canPrev: true, canNext: true
      };
    }
    const art = () => ({ type: 'art', key: keyOf(tracks[index]), art: artOf(tracks[index]) });

    const now = Date.now();
    const minute = (m) => Math.round((now + m * 60e3) / 60e3) * 60e3;
    const messages = {
      type: 'messages', unread: 2, readable: true,
      items: [
        { id: 'p1', title: 'Riya', body: 'Are we still on for dinner tonight?', time: now - 2 * 60e3 },
        { id: 'p2', title: 'Project group', body: 'Sam: I pushed the slides, have a look when you can', time: now - 26 * 60e3 }
      ]
    };
    const calendar = {
      configured: true, error: null, fetchedAt: now,
      events: [
        { id: 'c1', title: 'Design review', start: minute(25), end: minute(55), allDay: false, location: 'Meet' },
        { id: 'c2', title: 'Gym', start: minute(180), end: minute(240), allDay: false, location: '' },
        { id: 'c3', title: 'Call with Mum', start: minute(26 * 60), end: minute(26 * 60 + 30), allDay: false, location: '' }
      ]
    };

    // The eyes follow the mouse inside the page.
    document.addEventListener('mousemove', (e) => emit('cursor', { x: e.clientX, y: e.clientY }));

    window.island = {
      setInteractive() {},
      hide() {},
      quit() {},
      focusInput() {},
      releaseFocus() {},
      openWhatsApp() {},
      openCalendar() {},
      refreshCalendar() {},
      pasteCalendarLink: async () => ({ ok: false, error: 'Preview only: nothing is read from the clipboard.' }),
      importCalendar: async () => ({ ok: false, error: 'Preview only: nothing is imported.' }),
      command(cmd) {
        const s = media();
        if (cmd === 'toggle') { position = s.position; at = Date.now(); status = status === 'Playing' ? 'Paused' : 'Playing'; }
        if (cmd === 'next' || cmd === 'prev') {
          index = (index + (cmd === 'next' ? 1 : tracks.length - 1)) % tracks.length;
          position = 0; at = Date.now(); status = 'Playing';
          setTimeout(() => emit('art', art()), 120);
        }
        const seek = /^seek ([\d.]+)$/.exec(cmd);
        if (seek) { position = +seek[1]; at = Date.now(); }
        const v = /^volume ([\d.]+)$/.exec(cmd);
        if (v) volume = { type: 'volume', level: +v[1], muted: false };
        if (cmd === 'mute' || cmd === 'unmute') volume = { ...volume, muted: cmd === 'mute' };
        setTimeout(() => { emit('media', media()); emit('volume', volume); }, 180);
      },
      current: async () => ({ media: media(), art: art(), volume, messages, calendar }),
      onMedia: on('media'),
      onArt: on('art'),
      onVolume: on('volume'),
      onMessages: on('messages'),
      onCalendar: on('calendar'),
      onCalendarResult: on('calendar-result'),
      onCursor: on('cursor'),
      onBlur: on('blur'),
      onPointerOut: on('pointer-out'),
      onToggle: on('toggle')
    };
  })();
}
