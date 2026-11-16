'use strict';

// Wrapped: this file is also loaded as a classic renderer script.
(function () {

// The theme and accent registry. Main, the preload, the renderer and the tests
// all read this list. A theme is one entry here plus its [data-theme] block in
// styles.css; `bg` mirrors that block's --bg and `light` its --term-light.
const THEMES = [
  { id: 'light', name: 'Light', light: true, bg: '#fafafa' },
  { id: 'dark', name: 'Dark', bg: '#0c0a09' },
  { id: 'midnight', name: 'Midnight', bg: '#0f1626' },
  { id: 'tokyo-night', name: 'Tokyo Night', bg: '#1a1b26' },
  { id: 'catppuccin', name: 'Catppuccin', bg: '#11111b' },
  { id: 'rose-pine', name: 'Rose Pine', bg: '#1f1d2e' },
  { id: 'gruvbox', name: 'Gruvbox', bg: '#282828' },
  { id: 'nord', name: 'Nord', bg: '#2e3440' },
  { id: 'dracula', name: 'Dracula', bg: '#282a36' },
  { id: 'sepia', name: 'Sepia', light: true, bg: '#f3ead6' },
  { id: 'ember', name: 'Ember', bg: '#171311' },
  { id: 'solarized-light', name: 'Solarized Light', light: true, bg: '#fdf6e3' },
  { id: 'solarized-dark', name: 'Solarized Dark', bg: '#002b36' },
  { id: 'one-dark', name: 'One Dark', bg: '#282c34' },
  { id: 'monokai', name: 'Monokai', bg: '#272822' },
  { id: 'everforest', name: 'Everforest', bg: '#2d353b' },
  { id: 'kanagawa', name: 'Kanagawa', bg: '#1f1f28' },
  { id: 'glass', name: 'Glass', bg: '#0a0e16' },
  { id: 'hc-dark', name: 'High contrast dark', bg: '#000000', highContrast: true },
  { id: 'hc-light', name: 'High contrast light', light: true, bg: '#ffffff', highContrast: true },
];

// `swatch` is the pair of stops the picker draws for the accent.
const ACCENTS = [
  { id: 'orange', name: 'Orange', swatch: ['#ff7847', '#ff5a3c'] },
  { id: 'cyan', name: 'Cyan', swatch: ['#67e8f9', '#5eead4'] },
  { id: 'indigo', name: 'Indigo', swatch: ['#818cf8', '#a78bfa'] },
  { id: 'emerald', name: 'Emerald', swatch: ['#34d399', '#6ee7b7'] },
  { id: 'rose', name: 'Rose', swatch: ['#fb7185', '#f9a8d4'] },
  { id: 'violet', name: 'Violet', swatch: ['#c084fc', '#d8b4fe'] },
  { id: 'amber', name: 'Amber', swatch: ['#fbbf24', '#fcd34d'] },
  { id: 'teal', name: 'Teal', swatch: ['#2dd4bf', '#5eead4'] },
  { id: 'slate', name: 'Slate', swatch: ['#94a3b8', '#cbd5e1'] },
];
const CUSTOM_ACCENT = 'custom';
const DEFAULT_CUSTOM_ACCENT = '#818cf8';

const THEME_IDS = THEMES.map((t) => t.id);
const ACCENT_IDS = ACCENTS.map((a) => a.id);

// An unknown id resolves to Dark, the theme the :root tokens describe.
function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === 'dark');
}
function isLightTheme(id) { return !!themeById(id).light; }
function themeBackground(id) { return themeById(id).bg; }
function isAccent(id) { return id === CUSTOM_ACCENT || ACCENT_IDS.includes(id); }

function normalizeHex(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}
function hexToRgb(hex) {
  const n = parseInt(normalizeHex(hex).slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
function hslToHex(hsl) { return rgbToHex(hslToRgb(hsl)); }

// WCAG relative luminance and contrast ratio of two opaque sRGB colours.
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// The accent tokens for a user-picked colour on a theme. The hue and saturation
// are kept; lightness moves away from the theme ground until the accent holds
// the same contrast floor the built-in palettes meet.
function deriveAccent(hex, themeId) {
  const theme = themeById(themeId);
  const bg = hexToRgb(theme.bg);
  const [h, s, picked] = rgbToHsl(hexToRgb(normalizeHex(hex) || DEFAULT_CUSTOM_ACCENT));
  const floor = theme.highContrast ? 7 : theme.light ? 4.5 : 3;
  const step = theme.light ? -0.01 : 0.01;
  let l = picked;
  while (contrast(hslToRgb([h, s, l]), bg) < floor && (step > 0 ? l < 1 : l > 0)) l = clamp01(l + step);
  const accent = hslToRgb([h, s, l]);
  const second = hslToHex([h, s, clamp01(l + 0.06)]);
  const ink = [0, 0, 0];
  const onAccent = contrast(ink, accent) >= contrast([255, 255, 255], accent) ? rgbToHex(ink) : '#ffffff';
  const accentHex = rgbToHex(accent);
  return {
    '--accent': accentHex,
    '--accent-2': second,
    '--accent-3': hslToHex([h, s, clamp01(l - 0.14)]),
    '--accent-glow': `rgba(${accent.map(Math.round).join(', ')}, ${theme.light ? 0.22 : 0.32})`,
    '--grad': `linear-gradient(135deg, ${accentHex}, ${second})`,
    '--on-accent': onAccent,
  };
}
const ACCENT_VARS = ['--accent', '--accent-2', '--accent-3', '--accent-glow', '--grad', '--on-accent'];

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskThemes = exports;
})({
  THEMES, ACCENTS, THEME_IDS, ACCENT_IDS, CUSTOM_ACCENT, DEFAULT_CUSTOM_ACCENT, ACCENT_VARS,
  themeById, isLightTheme, themeBackground, isAccent,
  normalizeHex, hexToRgb, rgbToHsl, hslToHex, contrast, deriveAccent,
});
})();
