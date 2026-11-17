'use strict';

const bgImage = require('./background-image');

// Checks and limits for showing a changed image file as a picture.

const MAX_SIDE = 1600;

function isGif(buf) {
  const sig = buf.length >= 6 ? buf.toString('latin1', 0, 6) : '';
  return sig === 'GIF87a' || sig === 'GIF89a';
}

// The canvas size, given only when the first frame lies inside it.
function gifSize(buf) {
  if (buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  let at = 13 + (buf[10] & 0x80 ? 3 * (1 << ((buf[10] & 7) + 1)) : 0);
  while (at < buf.length && buf[at] === 0x21) {
    at += 2;
    while (at < buf.length && buf[at] !== 0) at += buf[at] + 1;
    at += 1;
  }
  if (at + 10 > buf.length || buf[at] !== 0x2c) return null;
  const right = buf.readUInt16LE(at + 1) + buf.readUInt16LE(at + 5);
  const bottom = buf.readUInt16LE(at + 3) + buf.readUInt16LE(at + 7);
  return right <= width && bottom <= height ? { width, height } : null;
}

// Format, mime and size from the leading bytes. The file name plays no part.
function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > bgImage.MAX_BYTES) throw new Error('That image is larger than 15 MB.');
  if (!isGif(buf)) return bgImage.inspectImage(buf);
  const gif = gifSize(buf);
  if (!gif || gif.width <= 0 || gif.height <= 0) throw new Error('That image could not be read.');
  if (gif.width * gif.height > bgImage.MAX_PIXELS) throw new Error('That image has more than 50 megapixels.');
  return { format: 'gif', mime: 'image/gif', width: gif.width, height: gif.height };
}

// What the helper returned, as RGBA bytes of exactly width by height. Throws on anything else.
function pixels(result) {
  const width = result && result.width;
  const height = result && result.height;
  const sideOk = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;
  if (!sideOk(width) || !sideOk(height) || typeof result.data !== 'string') throw new Error('That image could not be read.');
  const data = Buffer.from(result.data, 'base64');
  if (data.length !== width * height * 4) throw new Error('That image could not be read.');
  return { width, height, data };
}

module.exports = { MAX_SIDE, inspect, pixels };
