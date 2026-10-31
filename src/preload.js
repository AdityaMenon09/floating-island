// The renderer's only door to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload || {}));

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
