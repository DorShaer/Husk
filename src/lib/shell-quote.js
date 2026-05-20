'use strict';

// shJoin serializes an (exe, argv) tuple into a string the POSIX shell
// rebuilds as the same argv. Single-quote every token (exe included);
// escape an embedded single quote with the canonical close-escape-open
// trick ('\''). Quoting the first word lets the shell treat it as a
// literal program name even when it contains metacharacters or spaces.
function shJoin(exe, args) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return [q(exe), ...(args || []).map(q)].join(' ');
}

module.exports = { shJoin };
