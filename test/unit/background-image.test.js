'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../../src/lib/background-image');
function png(w = 100, h = 100) {
  const b = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
test('reads dimensions from PNG, JPEG and WebP headers', () => {
  assert.deepEqual(B.readSize(png()), { width: 100, height: 100 });
  const jpeg = Buffer.from('ffd8ffc0001108006400c803011100021101031101', 'hex');
  assert.deepEqual(B.readSize(jpeg), { width: 200, height: 100 });
  for (const type of ['VP8X', 'VP8L', 'VP8 ']) {
    const b = Buffer.alloc(30); b.write('RIFF'); b.write('WEBP', 8); b.write(type, 12);
    if (type === 'VP8X') { b.writeUIntLE(199, 24, 3); b.writeUIntLE(99, 27, 3); }
    if (type === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(199 | (99 << 14), 21); }
    if (type === 'VP8 ') { Buffer.from([0x9d, 1, 0x2a]).copy(b, 23); b.writeUInt16LE(200, 26); b.writeUInt16LE(100, 28); }
    assert.deepEqual(B.readSize(b), { width: 200, height: 100 });
  }
});
test('validates bytes and pixel limits before decoding', () => {
  assert.throws(() => B.inspectImage(Buffer.from('<svg/>')));
  assert.throws(() => B.inspectImage(png(10000, 10000)), /megapixels/);
  assert.throws(() => B.inspectImage(Buffer.alloc(B.MAX_BYTES + 1)), /15 MB/);
  assert.throws(() => B.inspectImage(png(0, 5)));
  assert.throws(() => B.inspectImage(png().subarray(0, 20)));
});
test('serves only stored names on the dedicated image host', () => {
  const name = 'a'.repeat(64) + '.png';
  assert.equal(B.storedPathForUrl('/tmp/images', B.urlFor(name)), path.join('/tmp/images', name));
  for (const value of ['../x', '/etc/passwd', 'x.svg', 'a'.repeat(64) + '.webp']) assert.equal(B.storedPath('/tmp/images', value), null);
  assert.equal(B.storedPathForUrl('/tmp/images', `husk-bg://other/${name}`), null);
  assert.equal(B.storedPathForUrl('/tmp/images', `https://image/${name}`), null);
});
test('reads regular files by content and refuses links', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-bg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'image.txt'); fs.writeFileSync(file, png());
  assert.equal(B.inspectImage(B.readRegularFile(file)).format, 'png');
  assert.throws(() => B.readRegularFile(dir));
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link.png'); fs.symlinkSync(file, link);
    assert.throws(() => B.readRegularFile(link));
  }
  assert.throws(() => B.readRegularFile(file, 10));
});
test('stores private content-addressed files and removes unused copies', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-bg-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stored = B.storeImage(dir, png());
  const name = `${stored.hash}.${stored.ext}`;
  assert.match(name, B.STORED_NAME);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  B.pruneStored(dir, name); assert.equal(fs.readdirSync(dir).length, 1);
  B.pruneStored(dir); assert.equal(fs.readdirSync(dir).length, 0);
  assert.throws(() => B.storeImage(dir, png(4000, 100)));
});
