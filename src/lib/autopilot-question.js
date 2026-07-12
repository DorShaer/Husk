'use strict';

const QUESTION_RE = new RegExp([
  '\\?\\s*$',
  '\\bwhat (would|should) (you|i)\\b',
  '\\bwhich (option|approach|file|package|dependency)\\b',
  '\\bdo you want\\b',
  '\\bwould you like\\b',
  '\\bcan you (confirm|clarify|provide)\\b',
  '\\bplease (confirm|clarify|provide|tell me)\\b',
  '\\bneed (your )?(input|confirmation|approval)\\b',
  '\\bwaiting for (input|confirmation|approval)\\b',
].join('|'), 'i');

function isAutonomousQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (isPermissionPrompt(t)) return false;
  return QUESTION_RE.test(t.slice(-700));
}

function isPermissionPrompt(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return /\brun this command\?/i.test(t)
    && /\b1\.\s*Yes\b/i.test(t)
    && /\b(No|don't ask again|do not ask again)\b/i.test(t);
}

function permissionPromptChoice(text) {
  return /don't ask again|do not ask again/i.test(String(text || '')) ? '2' : '1';
}

function buildQuestionRedirect() {
  return [
    'No human is available to answer questions.',
    'Do not ask for confirmation or clarification.',
    'Choose the safest sensible default, record the assumption in the status file, and continue autonomously until the goal is complete or explicitly blocked.',
  ].join(' ');
}

module.exports = {
  buildQuestionRedirect,
  isAutonomousQuestion,
  isPermissionPrompt,
  permissionPromptChoice,
};
