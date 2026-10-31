// Runs after `npm install`. Some npm versions skip Electron's own download step, which leaves the
// package without the actual app; fetch it if it's missing. Also warns that the island is Windows-only.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.warn('\n  Floating Island only works on Windows 10 or 11 (it uses Windows media, volume and notification APIs).\n');
}

const dir = path.join(__dirname, '..', 'node_modules', 'electron');
const exe = path.join(dir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (fs.existsSync(path.join(dir, 'install.js')) && !fs.existsSync(exe)) {
  console.log('  Downloading Electron (about 100 MB, once)…');
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
