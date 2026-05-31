'use strict';

// E2E fixture standing in for a full-screen agent like copilot: it draws the
// recap line and UI chrome on SEPARATE grid rows using cursor positioning, so
// the raw byte stream interleaves them (no newline between recap and chrome,
// which is what used to pollute the spoken recap) while the rendered grid keeps
// each on its own clean row. It also redraws the recap later to exercise the
// once-per-turn / no-re-read guarantee.

const w = (s) => process.stdout.write(s);
const RECAP = '\u{1F5E3}\u{FE0F} Husk: Nice to meet you too, happy to help with anything you need.';

function paint() {
  w('\x1b[2J');                       // clear
  w('\x1b[1;1H~');                    // chrome (tilde marker)
  w('\x1b[3;1H' + RECAP);             // the recap, on its own row
  w('\x1b[5;1H/ commands · ? help                              Claude Opus 4.6'); // status bar
}

paint();
// Redraw later (a TUI repaint): must NOT cause a second read.
setTimeout(paint, 3000);
setTimeout(() => process.exit(0), 10000);
