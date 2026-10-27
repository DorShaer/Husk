'use strict';

// Report a bug / request a feature: prefilled GitHub issue links. Pure, so the
// body text and encoding are unit tested; main.js supplies the facts.
const REPO = 'https://github.com/DorShaer/Husk';

function issueUrl(kind, facts) {
  const f = facts || {};
  const isBug = kind === 'bug';
  const lines = isBug
    ? ['## What happened', '', '', '## What you expected', '', '', '## Steps to reproduce', '1. ', '2. ', '']
    : ['## The problem this solves', '', '', '## What you would like', '', '', '## Alternatives you considered', '', ''];
  const env = [
    '## Environment',
    `- Husk ${f.huskVersion || 'unknown'}`,
    `- OS ${f.platform || process.platform} ${f.arch || process.arch}${f.osVersion ? ' (' + f.osVersion + ')' : ''}`,
    `- Electron ${f.electron || 'unknown'}`,
    `- Agent ${f.agentCommand || 'unknown'}${f.agentVersion ? ' ' + f.agentVersion : ''}`,
    `- Chat view ${f.chatView || 'chat'}`,
  ];
  const body = lines.concat(env).join('\n');
  const params = new URLSearchParams({
    labels: isBug ? 'bug' : 'enhancement',
    title: isBug ? '[Bug] ' : '[Feature] ',
    body,
  });
  return `${REPO}/issues/new?${params.toString()}`;
}

module.exports = { issueUrl, REPO };
