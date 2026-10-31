// The renderer's only door to the main process.
const { contextBridge, ipcRenderer } = require('electron');

// Errors go to main's island.log. One thrown inside a handler below never reaches the page's own
// error event (app.js listens there), so each handler reports its own.
const report = (text) => ipcRenderer.send('island:log', String(text));
const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => {
  try { fn(payload || {}); } catch (err) { report(`${channel}: ${(err && err.stack) || err}`); }
});

contextBridge.exposeInMainWorld('island', {
  setInteractive: (value) => ipcRenderer.send('island:interactive', !!value),
  hide: () => ipcRenderer.send('island:hide'),
  quit: () => ipcRenderer.send('island:quit'),
  focusInput: () => ipcRenderer.send('island:focus-input'),
  releaseFocus: () => ipcRenderer.send('island:release-focus'),
  onBlur: on('island:blur'),
  command: (cmd) => ipcRenderer.send('bridge:command', String(cmd)),
  openWhatsApp: () => ipcRenderer.send('open:whatsapp'),
  openCalendar: () => ipcRenderer.send('open:calendar'),
  pasteCalendarLink: () => ipcRenderer.invoke('calendar:paste'),
  importCalendar: () => ipcRenderer.invoke('calendar:import'),
  refreshCalendar: () => ipcRenderer.send('calendar:refresh'),
  current: () => ipcRenderer.invoke('state:current'),
  log: (text) => report(text),
  onMedia: on('media'),
  onArt: on('media:art'),
  onVolume: on('volume'),
  onMessages: on('messages'),
  onCalendar: on('calendar'),
  onCalendarResult: on('calendar:result'),
  onCursor: on('cursor'),
  onCharacter: on('character'),
  onPointerOut: on('island:pointer-out'),
  onToggle: on('island:toggle')
});
