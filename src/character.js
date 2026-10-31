// The character that sits beside the island. Each person picks their own picture; it's kept in the
// app's data folder (%APPDATA%\Floating Island\character.png), never in the repo. Any image works, but
// a PNG with a transparent background looks best: anything else shows as a rectangle.
// Used by main.js (tray > Change character…) and scripts/character.js (the terminal prompt).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IMAGE = /\.(png|jpe?g|gif|bmp)$/i;

// FLOATING_ISLAND_DATA lets tests use a scratch folder instead of the real one.
const dataDir = () => process.env.FLOATING_ISLAND_DATA || path.join(process.env.APPDATA || '', 'Floating Island');
const characterFile = (dir = dataDir()) => path.join(dir, 'character.png');

// 'yes', 'no' or 'unknown'. PNGs say so in their header (an alpha channel, or a tRNS chunk before the
// image data); JPEG and BMP can't be transparent; GIF might be.
function transparency(file) {
  if (/\.(jpe?g|bmp)$/i.test(file)) return 'no';
  if (!/\.png$/i.test(file)) return 'unknown';
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(65536);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, n);
    if (buf.length < 33 || buf.toString('latin1', 1, 4) !== 'PNG') return 'unknown';
    const colourType = buf[25];
    if (colourType === 4 || colourType === 6) return 'yes';
    const idat = buf.indexOf('IDAT', 0, 'latin1');
    const trns = buf.indexOf('tRNS', 0, 'latin1');
    return trns !== -1 && (idat === -1 || trns < idat) ? 'yes' : 'no';
  } finally {
    fs.closeSync(fd);
  }
}

// Copies the picture in, scaled down to 240 px tall with Windows' own imaging (keeping transparency):
// the island shows it at most about 100 px tall, and a smaller file renders crisper and lighter.
function install(source, dir = dataDir()) {
  if (!fs.existsSync(source)) throw new Error("Couldn't find that file.");
  if (!IMAGE.test(source)) throw new Error('Pick an image file: PNG, JPG, GIF or BMP.');
  fs.mkdirSync(dir, { recursive: true });
  const out = characterFile(dir);
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Drawing.Image]::FromFile($env:FI_SRC)',
    'try {',
    '  $h = [Math]::Min(240, $img.Height); $w = [Math]::Max(1, [int][Math]::Round($img.Width * $h / $img.Height))',
    '  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
    "  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'",
    '  $g.Clear([System.Drawing.Color]::Transparent); $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()',
    '  $bmp.Save($env:FI_OUT, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()',
    '} finally { $img.Dispose() }'
  ].join('\n');
  const tmp = `${out}.new`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FI_SRC: path.resolve(source), FI_OUT: tmp },
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to tidy */ }
    throw new Error("Couldn't read that image. Try saving it as a PNG first.");
  }
  fs.renameSync(tmp, out);
  return out;
}

function remove(dir = dataDir()) {
  fs.rmSync(characterFile(dir), { force: true });
}

module.exports = { IMAGE, dataDir, characterFile, transparency, install, remove };
