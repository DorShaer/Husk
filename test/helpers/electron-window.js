'use strict';

const assert = require('node:assert/strict');

// The inspector can lose an internal promise even for a synchronous callback.
// Setting absolute dimensions is idempotent, so only this operation can safely
// recover from that specific transport failure. Other errors fail immediately.
async function setWindowContentSize(app, width, height) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const actual = await app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(size.width, size.height);
        return win.getContentSize();
      }, { width, height });
      assert.deepEqual(actual, [width, height]);
      return;
    } catch (err) {
      if (attempt === 4 || !String(err && err.message).includes('Resulting promise was garbage collected')) throw err;
      console.warn('Retrying an idempotent window resize after an inspector reply was collected.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

module.exports = { setWindowContentSize };
