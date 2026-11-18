'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../src/lib/image-preview');
function png(w = 100, h = 100) {
  const b = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function gif(w = 100, h = 100, frameW = w, frameH = h, ext = false) {
  const head = Buffer.alloc(13);
  head.write('GIF89a'); head.writeUInt16LE(w, 6); head.writeUInt16LE(h, 8);
  const frame = Buffer.alloc(10);
  frame[0] = 0x2c; frame.writeUInt16LE(frameW, 5); frame.writeUInt16LE(frameH, 7);
  const control = ext ? Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]) : Buffer.alloc(0);
  return Buffer.concat([head, control, frame]);
}
test('reads format and size from the leading bytes', () => {
  assert.deepEqual(P.inspect(png(200, 100)), { format: 'png', mime: 'image/png', width: 200, height: 100 });
  assert.deepEqual(P.inspect(gif(200, 100)), { format: 'gif', mime: 'image/gif', width: 200, height: 100 });
});
test('refuses bytes that are not a supported image', () => {
  assert.throws(() => P.inspect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
  assert.throws(() => P.inspect(Buffer.from('<!doctype html>')));
  assert.throws(() => P.inspect(gif(0, 5)));
  assert.throws(() => P.inspect(gif(10, 10, 5000, 5000)));
  assert.throws(() => P.inspect(gif(10, 10).subarray(0, 13)));
  assert.equal(P.inspect(gif(10, 10, 10, 10, true)).width, 10);
  assert.throws(() => P.inspect(gif(60000, 60000)), /megapixels/);
  assert.throws(() => P.inspect('not a buffer'));
});
test('accepts helper output only as RGBA bytes of the stated size', () => {
  const data = Buffer.alloc(2 * 3 * 4, 7).toString('base64');
  const ok = P.pixels({ width: 2, height: 3, data });
  assert.equal(ok.data.length, 24);
  assert.throws(() => P.pixels({ width: 2, height: 4, data }));
  assert.throws(() => P.pixels({ width: 0, height: 3, data }));
  assert.throws(() => P.pixels({ width: 2.5, height: 3, data }));
  assert.throws(() => P.pixels({ width: P.MAX_SIDE + 1, height: 1, data: Buffer.alloc((P.MAX_SIDE + 1) * 4).toString('base64') }));
  assert.throws(() => P.pixels({ width: 2, height: 3, data: Buffer.alloc(24) }));
  assert.throws(() => P.pixels('data:image/png;base64,AAAA'));
  assert.throws(() => P.pixels(null));
});
