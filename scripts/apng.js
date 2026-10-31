// Minimal PNG / animated PNG (APNG) writer for demo recordings. Node built-ins only.
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(w, h) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8;   // bit depth
  b[9] = 6;   // RGBA
  return chunk('IHDR', b);
}

// Scanlines with the "Up" filter (each row minus the one above), which compresses animation frames well.
function compress(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) {
      const up = y ? rgba[(y - 1) * stride + x] : 0;
      raw[y * (stride + 1) + 1 + x] = (rgba[y * stride + x] - up) & 0xff;
    }
  }
  return zlib.deflateSync(raw, { level: 9 });
}

function encodePNG(rgba, w, h) {
  return Buffer.concat([SIGNATURE, ihdr(w, h), chunk('IDAT', compress(rgba, w, h)), chunk('IEND', Buffer.alloc(0))]);
}

// frames: RGBA buffers of w x h; delays: milliseconds each frame stays on screen. Loops forever.
function encodeAPNG(frames, w, h, delays) {
  const parts = [SIGNATURE, ihdr(w, h)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4);
  parts.push(chunk('acTL', actl));
  let seq = 0;
  frames.forEach((rgba, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(w, 4);
    fctl.writeUInt32BE(h, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(Math.max(1, Math.round(delays[i])), 20);
    fctl.writeUInt16BE(1000, 22);
    fctl[24] = 0; // dispose: none
    fctl[25] = 0; // blend: source (frames are opaque)
    parts.push(chunk('fcTL', fctl));
    const data = compress(rgba, w, h);
    if (i === 0) {
      parts.push(chunk('IDAT', data));
    } else {
      const s = Buffer.alloc(4);
      s.writeUInt32BE(seq++);
      parts.push(chunk('fdAT', Buffer.concat([s, data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Electron's bitmaps are BGRA with premultiplied alpha; flatten onto an opaque background colour.
function flattenBGRA(bgra, [r, g, b]) {
  const out = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3] / 255;
    out[i] = Math.min(255, bgra[i + 2] + r * (1 - a));
    out[i + 1] = Math.min(255, bgra[i + 1] + g * (1 - a));
    out[i + 2] = Math.min(255, bgra[i] + b * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

module.exports = { encodePNG, encodeAPNG, flattenBGRA };
