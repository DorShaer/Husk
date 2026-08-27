'use strict';

// A throwaway git repository with a known shape, shared by the unit and e2e
// suites.
//
// Two rules keep it honest on a real developer's machine. The identity is
// supplied per command with -c, so nothing is written to the machine's git
// config and no global user.name is needed for the fixture to build. The
// initial branch is named with -c init.defaultBranch=main, so a runner whose
// own default is master still gets a repository the assertions can name.
//
// The shape every caller can rely on:
//   main            two commits
//   feature/side    one commit ahead of main
//   src/lib/util.js modified and staged
//   src/app.js      modified in the working tree, two hunks apart
//
// So git status reports exactly one staged file and one unstaged file, and
// the unstaged file's diff has two hunks with a readable gap between them.
//
// makeGlobRepo builds a second shape beside it, for the rule that a path git
// reads back out of status is a name and not a pattern.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Identity travels with every command rather than being committed to a config
// file, so the fixture leaves no trace outside its own directory.
const IDENTITY = [
  '-c', 'user.email=test@example.com',
  '-c', 'user.name=Test',
  '-c', 'commit.gpgsign=false',
];

const APP_V1 = [
  "'use strict';",
  '',
  'function alpha() {',
  '  return 1;',
  '}',
  '',
  'function beta() {',
  '  return 2;',
  '}',
  '',
  'function gamma() {',
  '  return 3;',
  '}',
  '',
  'function delta() {',
  '  return 4;',
  '}',
  '',
  'function epsilon() {',
  '  return 5;',
  '}',
  '',
  'module.exports = { alpha, beta, gamma, delta, epsilon };',
  '',
].join('\n');

// The working-tree edit: line 4 and line 20, far enough apart that a diff at
// three lines of context reports two hunks.
const APP_DIRTY = APP_V1
  .replace('  return 1;', '  return 11;')
  .replace('  return 5;', '  return 55;');

const UTIL_V1 = [
  "'use strict';",
  '',
  'function slug(s) {',
  "  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  '}',
  '',
  'module.exports = { slug };',
  '',
].join('\n');

const UTIL_STAGED = UTIL_V1.replace('module.exports = { slug };', 'function trim(s) {\n  return String(s).trim();\n}\n\nmodule.exports = { slug, trim };');

const ROUTE_V1 = [
  "'use strict';",
  '',
  'module.exports = function handler() {',
  "  return 'route';",
  '};',
  '',
].join('\n');

const ROUTE_DIRTY_BRACKET = ROUTE_V1.replace("return 'route';", "return 'route by id';");
const ROUTE_DIRTY_PLAIN = ROUTE_V1.replace("return 'route';", "return 'route i';");

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), String(prefix || 'husk-repo') + '-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const write = (rel, text) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };

  execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', 'init', '-q'], { stdio: 'pipe' });

  write('README.md', '# fixture\n\nA repository built for a test.\n');
  write('src/app.js', APP_V1);
  git('add', '--', 'README.md', 'src/app.js');
  git('commit', '-qm', 'chore(fixture): add the first two files');

  write('src/lib/util.js', UTIL_V1);
  git('add', '--', 'src/lib/util.js');
  git('commit', '-qm', 'feat(lib): add the slug helper');

  // One commit that lives only on the side branch, so a branch list has
  // something ahead to report and main stays where the assertions expect it.
  git('switch', '-q', '-c', 'feature/side');
  write('src/lib/side.js', "'use strict';\n\nmodule.exports = { side: true };\n");
  git('add', '--', 'src/lib/side.js');
  git('commit', '-qm', 'feat(lib): add the side helper');
  git('switch', '-q', 'main');

  write('src/lib/util.js', UTIL_STAGED);
  git('add', '--', 'src/lib/util.js');
  write('src/app.js', APP_DIRTY);

  return { dir, git };
}

// A repository whose two modified files collide under wildmatch. The literal
// name src/routes/[id].js is also a glob, and src/routes/i.js is one of the
// names that glob matches, so an action naming either file proves it acted on
// the name rather than on the pattern. Bracket characters in a path are
// ordinary in a routing tree, so this is a shape a real project has.
//
// Returns null when the filesystem refuses those characters in a name, so a
// caller on such a platform can skip the case instead of failing in it.
function makeGlobRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), String(prefix || 'husk-glob-repo') + '-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const write = (rel, text) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };

  const bracket = 'src/routes/[id].js';
  const plain = 'src/routes/i.js';

  // The name has to survive the round trip to disk unchanged, so it is written
  // and read back before the repository is built around it.
  try {
    write(bracket, ROUTE_V1);
    const listed = fs.readdirSync(path.join(dir, 'src', 'routes'));
    if (!listed.includes('[id].js')) throw new Error('name not kept');
  } catch (_) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', 'init', '-q'], { stdio: 'pipe' });
  write(plain, ROUTE_V1);
  write('README.md', '# routes fixture\n');
  git('add', '-A');
  git('commit', '-qm', 'chore(fixture): add the two route files');

  write(bracket, ROUTE_DIRTY_BRACKET);
  write(plain, ROUTE_DIRTY_PLAIN);

  return { dir, git, bracket, plain, base: ROUTE_V1 };
}

module.exports = { makeRepo, makeGlobRepo };
