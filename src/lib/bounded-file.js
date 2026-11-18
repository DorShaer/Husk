'use strict';

const nodeFs = require('node:fs');

// Reads one regular file through the descriptor checked for identity and size.
function readBoundedFile(file, maxBytes, fs = nodeFs) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('A byte limit is required');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) throw new Error('The file changed while opening it');
    if (st.size > maxBytes) throw new Error('The file exceeds its byte limit');
    const bytes = Buffer.alloc(Math.min(st.size + 1, maxBytes + 1));
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!n) break;
      read += n;
    }
    if (read > st.size || read > maxBytes) throw new Error('The file changed while reading it');
    return bytes.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

module.exports = { readBoundedFile };
