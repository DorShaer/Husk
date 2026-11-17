'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInside } = require('./path-confine');

// The user's background image: what may be read, what is kept, and how the
// kept copy is named and found again.

const SCHEME = 'husk-bg';
const HOST = 'image';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 50 * 1000 * 1000;
const MAX_SIDE = 3840;
const STORED_NAME = /^[a-f0-9]{64}\.(jpg|png)$/;
const DIM = { min: 30, max: 95, fallback: 70 };
const BLUR = { min: 0, max: 24, fallback: 0 };

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function startsWith(buf, bytes, at = 0) {
  if (buf.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}

// The format the leading bytes declare: 'png', 'jpeg', 'webp', or null.
function detectFormat(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Walks the segment list to the first frame header.
function jpegSize(buf) {
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buf.readUInt16BE(at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (!startsWith(buf, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// Width and height as the file header states them, without decoding.
function readSize(buf, format = detectFormat(buf)) {
  const size = format === 'png' ? pngSize(buf) : format === 'jpeg' ? jpegSize(buf) : format === 'webp' ? webpSize(buf) : null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

// Format, mime and size of an accepted image. Throws with a message for the user.
function inspectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_BYTES) throw new Error('That image is larger than 15 MB.');
  const format = detectFormat(buf);
  if (!format) throw new Error('Choose a PNG, JPEG or WebP image.');
  const size = readSize(buf, format);
  if (!size) throw new Error('That image could not be read.');
  if (size.width * size.height > MAX_PIXELS) throw new Error('That image has more than 50 megapixels.');
  return { format, mime: MIME[format], width: size.width, height: size.height };
}

// The bytes of a regular file, read from one handle that does not follow a link.
// `check` sees the open handle's stat and throws to refuse the file.
function readRegularFile(file, maxBytes = MAX_BYTES, check = null) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  let before;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the picked image, read without following links
  try { before = fs.lstatSync(file); } catch (_) { throw new Error('Choose the image file itself.'); }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose the image file itself.');
  let fd;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the picked image, read without following links
  try { fd = fs.openSync(file, flags); } catch (_) { throw new Error('Choose the image file itself.'); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) throw new Error('Choose the image file itself.');
    if (check) check(st);
    if (st.size > maxBytes) throw new Error('That image is larger than 15 MB.');
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (!n) break;
      total += n;
    }
    if (total > maxBytes) throw new Error('That image is larger than 15 MB.');
    return buf.subarray(0, total);
  } finally { fs.closeSync(fd); }
}

// The absolute path of a stored image by name, or null when the name is not one.
function storedPath(dir, name) {
  if (typeof name !== 'string' || !STORED_NAME.test(name)) return null;
  try { return resolveInside(dir, name); } catch (_) { return null; }
}

// The stored file a husk-bg URL names, or null.
function storedPathForUrl(dir, url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return null; }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST || u.username || u.password || u.port) return null;
  return storedPath(dir, u.pathname.slice(1));
}

function urlFor(name) { return STORED_NAME.test(String(name)) ? `${SCHEME}://${HOST}/${name}` : null; }

function clampInt(value, { min, max, fallback }) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// A config `background` entry reduced to known fields, or null when it names no stored image.
function sanitizeBackground(value) {
  if (!value || typeof value !== 'object') return null;
  const name = `${value.hash}.${value.ext}`;
  if (!STORED_NAME.test(name)) return null;
  return { hash: value.hash, ext: value.ext, dim: clampInt(value.dim, DIM), blur: clampInt(value.blur, BLUR) };
}

// Checks re-encoded bytes and writes them as <sha256>.<ext>, private to the user.
function storeImage(dir, bytes) {
  const info = inspectImage(bytes);
  if (info.format === 'webp' || Math.max(info.width, info.height) > MAX_SIDE) throw new Error('That image could not be read.');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const ext = info.format === 'png' ? 'png' : 'jpg';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the app's own image folder
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = storedPath(dir, `${hash}.${ext}`);
  fs.rmSync(file, { force: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a stored name resolved inside the image folder
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  return { hash, ext };
}

// Deletes every stored image except the one named.
function pruneStored(dir, keepName = null) {
  let names = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the app's own image folder
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of names) {
    const file = name === keepName ? null : storedPath(dir, name);
    if (file) { try { fs.rmSync(file, { force: true }); } catch (_) {} }
  }
}

module.exports = {
  SCHEME, HOST, MAX_BYTES, MAX_PIXELS, MAX_SIDE, STORED_NAME, DIM, BLUR,
  detectFormat, readSize, inspectImage, readRegularFile,
  storedPath, storedPathForUrl, urlFor, sanitizeBackground, storeImage, pruneStored,
};
