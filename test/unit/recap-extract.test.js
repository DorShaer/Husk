'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractRecap } = require('../../src/lib/recap-extract');

const row = (text, wrapped = false) => ({ text, wrapped });

test('reads the speech-balloon summary from its own row', () => {
  const rows = [
    row('● I\'m Husk, your terminal assistant.'),
    row('\u{1F5E3}\u{FE0F} Husk: Nice to meet you too, happy to help with anything you need.'),
  ];
  assert.equal(extractRecap(rows), 'Nice to meet you too, happy to help with anything you need.');
});

test('does NOT pick up UI chrome from other rows', () => {
  // A full-screen agent draws status bars and prompts on separate rows; the
  // recap must contain none of that UI chrome.
  const rows = [
    row('\u{1F5E3}\u{FE0F} Husk: Nice to meet you too, happy to help with anything you need.'),
    row('~'),
    row('❯'),
    row('/ commands · ? help                              Claude Opus 4.6'),
  ];
  assert.equal(extractRecap(rows), 'Nice to meet you too, happy to help with anything you need.');
});

test('joins a soft-wrapped recap across continuation rows', () => {
  const rows = [
    row('\u{1F5E3}\u{FE0F} Husk: Eight Husk Electron sessions are currently'),
    row(' running on this machine right now.', true),
  ];
  assert.equal(extractRecap(rows), 'Eight Husk Electron sessions are currently running on this machine right now.');
});

test('returns the LAST recap when several are present', () => {
  const rows = [
    row('\u{1F5E3}\u{FE0F} Husk: First answer summary.'),
    row('some later output'),
    row('\u{1F5E3}\u{FE0F} Husk: Second answer summary.'),
  ];
  assert.equal(extractRecap(rows), 'Second answer summary.');
});

test('reads the Claude Code recap form', () => {
  assert.equal(extractRecap([row('  * recap: did the thing and verified it')]), 'did the thing and verified it');
});

test('returns null when there is no recap', () => {
  assert.equal(extractRecap([row('just output'), row('/ commands ? help')]), null);
  assert.equal(extractRecap([]), null);
});

test('a partial (still-streaming) recap row is returned as-is', () => {
  // Completeness is the caller's job (settle); the extractor just reads rows.
  assert.equal(extractRecap([row("\u{1F5E3}\u{FE0F} Husk: I'm")]), "I'm");
});
