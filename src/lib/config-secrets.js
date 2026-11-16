'use strict';

// Secret config fields live encrypted on disk and plain in memory. The keychain
// is injected: { ready(): bool, encrypt(string): Buffer, decrypt(Buffer): string }.
// When it is not ready the plain value is written as before (file mode 0600).

const SECRET_FIELDS = ['agentApiKey'];
const ENC_SUFFIX = 'Enc';

// The object to write to disk.
function sealConfig(cfg, keychain) {
  const out = { ...cfg };
  const ready = !!(keychain && keychain.ready());
  for (const field of SECRET_FIELDS) {
    const encKey = field + ENC_SUFFIX;
    const value = typeof out[field] === 'string' ? out[field] : '';
    if (!value) { delete out[field]; if (ready) delete out[encKey]; continue; }
    if (!ready) continue;
    try {
      out[encKey] = keychain.encrypt(value).toString('base64');
      delete out[field];
    } catch (_) { delete out[encKey]; }
  }
  return out;
}

// Decrypt sealed fields into the in-memory config. A value that cannot be
// decrypted stays sealed and is reported, so it is never silently lost.
function unsealConfig(cfg, keychain) {
  const out = { ...cfg };
  const failed = [];
  const ready = !!(keychain && keychain.ready());
  for (const field of SECRET_FIELDS) {
    const encKey = field + ENC_SUFFIX;
    if (typeof out[encKey] !== 'string' || !out[encKey]) continue;
    if (!ready) continue;
    try {
      out[field] = keychain.decrypt(Buffer.from(out[encKey], 'base64'));
      delete out[encKey];
    } catch (_) { failed.push(field); }
  }
  return { config: out, failed };
}

// True when a plain secret should be re-written sealed.
function needsSeal(cfg, keychain) {
  if (!keychain || !keychain.ready()) return false;
  return SECRET_FIELDS.some((f) => typeof cfg[f] === 'string' && cfg[f]);
}

module.exports = { SECRET_FIELDS, sealConfig, unsealConfig, needsSeal };
