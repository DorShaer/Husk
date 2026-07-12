'use strict';

// MCP install-from-repo helpers. Pure / fs-only logic that can be unit
// tested without spinning up Electron, mirroring src/lib/pai-state.js.
//
// What a "repo of MCP servers" looks like, the layout we scan for:
//
//   <repoRoot>/
//     mcp-servers/
//       <serverName>/
//         package.json        required: { main, scripts.build, scripts.start }
//         .env.example        optional: lines like KEY=description
//         dist/               optional: present when build has already run
//
// The scanner is forgiving. Missing files, missing fields, inconsistent casing -
// each branch produces a sensible status rather than throwing.

const fs = require('fs');
const path = require('path');

const SERVERS_SUBDIR = 'mcp-servers';
const ENV_EXAMPLE = '.env.example';

// Cap the number of servers we surface so an oversized monorepo cannot
// blow up the modal. The first N alphabetically; the rest are silently
// ignored. Surfaced in the scan result so the renderer can show a hint.
const MAX_SERVERS_SHOWN = 50;

function safeRead(filePath, encoding = 'utf8') {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded reads under repoRoot
    return fs.readFileSync(filePath, encoding);
  } catch (_) {
    return null;
  }
}

function safeStat(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded stat under repoRoot
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function safeReaddir(dirPath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded readdir under repoRoot
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

// parseEnvExample reads `KEY=description` style entries from a
// dotenv-template file. The "value" half is treated as a hint, not a
// secret. Returns an array of { key, hint } objects in file order.
function parseEnvExample(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let hint = line.slice(eq + 1).trim();
    if ((hint.startsWith('"') && hint.endsWith('"')) ||
        (hint.startsWith("'") && hint.endsWith("'"))) {
      hint = hint.slice(1, -1);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    out.push({ key, hint });
  }
  return out;
}

// scanRepoForMcpServers walks <repoRoot>/mcp-servers/* and returns a
// list of `serverSummary` records, each describing what we found.
// The shape stays serializable so the renderer can render it directly.
function scanRepoForMcpServers(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot) {
    return { ok: false, error: 'absolute path required' };
  }
  const serversDir = path.join(repoRoot, SERVERS_SUBDIR);
  const dirStat = safeStat(serversDir);
  if (!dirStat || !dirStat.isDirectory()) {
    return { ok: true, root: repoRoot, serversDir, servers: [], hasServersDir: false };
  }
  const entries = safeReaddir(serversDir)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const truncated = entries.length > MAX_SERVERS_SHOWN;
  const limited = entries.slice(0, MAX_SERVERS_SHOWN);
  const servers = [];
  for (const name of limited) {
    servers.push(describeServer(serversDir, name));
  }
  return {
    ok: true,
    root: repoRoot,
    serversDir,
    hasServersDir: true,
    servers,
    truncated,
    totalFound: entries.length,
  };
}

function describeServer(serversDir, name) {
  const dir = path.join(serversDir, name);
  const pkgPath = path.join(dir, 'package.json');
  const pkgText = safeRead(pkgPath);
  let pkg = null;
  let parseError = null;
  if (pkgText) {
    try { pkg = JSON.parse(pkgText); } catch (err) { parseError = err.message; }
  }
  const envText = safeRead(path.join(dir, ENV_EXAMPLE));
  const envVars = parseEnvExample(envText || '');
  const mainRel = pkg && typeof pkg.main === 'string' ? pkg.main : null;
  const mainAbs = mainRel ? path.join(dir, mainRel) : null;
  const mainExists = mainAbs ? !!safeStat(mainAbs) : false;
  const hasBuild = !!(pkg && pkg.scripts && typeof pkg.scripts.build === 'string');
  const hasStart = !!(pkg && pkg.scripts && typeof pkg.scripts.start === 'string');
  const needsBuild = hasBuild && !mainExists;
  return {
    name,
    dir,
    pkgPath,
    pkgFound: !!pkgText,
    pkgParseError: parseError,
    displayName: (pkg && typeof pkg.name === 'string') ? pkg.name : name,
    description: pkg && typeof pkg.description === 'string' ? pkg.description : '',
    mainRel,
    mainAbs,
    mainExists,
    hasBuild,
    hasStart,
    needsBuild,
    envVars,
    installable: !!(pkgText && (mainExists || hasBuild || hasStart)),
  };
}

// buildServerSpec turns a scanned server + user-provided env values into
// the canonical transport spec that every adapter consumes. Splitting of
// command and args happens here, so callers downstream cannot accidentally
// glue them back into one string. Returns either { ok: true, spec } or
// { ok: false, error }.
function buildServerSpec(server, envValues) {
  if (!server || typeof server !== 'object') {
    return { ok: false, error: 'server summary required' };
  }
  if (!server.installable) {
    return { ok: false, error: 'server has no resolvable entry point' };
  }
  // Prefer an absolute path to the built main file. Fall back to the
  // first token of the start script (e.g. "node dist/index.js") if main
  // is missing but start is set.
  let command = 'node';
  let args = [];
  if (server.mainAbs) {
    args = [server.mainAbs];
  } else if (server.hasStart) {
    const startScript = server.dir && server.pkgPath
      ? (() => {
          const pkg = (() => { try { return JSON.parse(safeRead(server.pkgPath) || '{}'); } catch (_) { return {}; } })();
          return (pkg.scripts && pkg.scripts.start) || '';
        })()
      : '';
    const tokens = String(startScript).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { ok: false, error: 'start script is empty' };
    command = tokens.shift();
    args = tokens.map((tok) => {
      // Resolve relative paths against the server dir so the command
      // works regardless of cwd at launch time.
      if (tok.startsWith('./') || tok.startsWith('../') || (!path.isAbsolute(tok) && /\.[a-zA-Z]+$/.test(tok))) {
        return path.join(server.dir, tok);
      }
      return tok;
    });
  } else {
    return { ok: false, error: 'no main entry point and no start script' };
  }
  // env: collect ONLY keys the .env.example declared; pass them through
  // as strings. Trim wrapping whitespace and matched outer quotes.
  const env = {};
  const declared = Array.isArray(server.envVars) ? server.envVars : [];
  const declaredKeys = new Set(declared.map((e) => e.key));
  const provided = envValues && typeof envValues === 'object' ? envValues : {};
  for (const key of declaredKeys) {
    if (!Object.prototype.hasOwnProperty.call(provided, key)) continue;
    let value = String(provided[key] || '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) env[key] = value;
  }
  const spec = {
    transport: 'stdio',
    command,
    args,
  };
  if (Object.keys(env).length) spec.env = env;
  return { ok: true, spec };
}

// renderCodexSnippet produces a TOML [[mcp_servers]] block the user can
// drop into ~/.codex/config.toml. Codex's MCP support is newer and the
// schema can shift; this snippet matches the published examples as of
// the time of writing. We do NOT auto-write the file (yet) because
// Codex's config is shared with non-MCP fields and we do not own a
// safe TOML merge path.
function renderCodexSnippet(serverId, spec) {
  if (!serverId || !spec) return '';
  const lines = [];
  lines.push('[[mcp_servers]]');
  lines.push(`name = ${tomlString(serverId)}`);
  lines.push(`command = ${tomlString(spec.command)}`);
  lines.push(`args = ${tomlStringArray(spec.args || [])}`);
  if (spec.env && Object.keys(spec.env).length) {
    const pairs = Object.keys(spec.env)
      .map((k) => `${tomlBareKey(k)} = ${tomlString(spec.env[k])}`)
      .join(', ');
    lines.push(`env = { ${pairs} }`);
  }
  return lines.join('\n') + '\n';
}

// renderAiderSnippet produces a JSON object that fits aider's --mcp
// command-line flag (which accepts inline JSON). aider's stable
// programmatic config does not currently sit in a well-known file;
// the snippet is therefore a CLI flag preview, not a config-file
// fragment.
function renderAiderSnippet(serverId, spec) {
  if (!serverId || !spec) return '';
  const obj = { [serverId]: { command: spec.command, args: spec.args || [] } };
  if (spec.env && Object.keys(spec.env).length) obj[serverId].env = spec.env;
  return `--mcp '${JSON.stringify(obj)}'`;
}

function tomlString(s) {
  const v = String(s == null ? '' : s);
  // Escape backslashes and double quotes, escape control chars by
  // dropping them. TOML basic-string rules are stricter than JSON's.
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f]/g, '');
  return `"${escaped}"`;
}

function tomlStringArray(arr) {
  if (!Array.isArray(arr)) return '[]';
  return `[${arr.map(tomlString).join(', ')}]`;
}

function tomlBareKey(k) {
  // TOML bare keys allow [A-Za-z0-9_-]+: fall back to a quoted key
  // when the input has anything else.
  if (/^[A-Za-z0-9_-]+$/.test(String(k))) return String(k);
  return tomlString(k);
}

module.exports = {
  SERVERS_SUBDIR,
  MAX_SERVERS_SHOWN,
  parseEnvExample,
  scanRepoForMcpServers,
  describeServer,
  buildServerSpec,
  renderCodexSnippet,
  renderAiderSnippet,
};
