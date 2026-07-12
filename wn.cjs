const { _electron: electron } = require('playwright');
const path = require('path'); const fs = require('fs');
(async () => {
  const cfgDir = path.join(process.env.HOME, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ firstRunDone: true, theme: 'light', lastSeenVersion: '2.8.8' }));
  const app = await electron.launch({ args: [path.join('/home/dor/Desktop/husk','src/main.js'), '--no-sandbox'], timeout: 60000 });
  const win = await app.firstWindow();
  await win.waitForTimeout(3000);
  await win.evaluate(() => showWhatsNew('2.8.9'));
  await win.waitForTimeout(1000);
  await win.screenshot({ path: '/tmp/kern/whatsnew.png' });
  console.log('captured');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
