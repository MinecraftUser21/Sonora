'use strict';

// A theme only needs four colours; everything else is worked out from them.
// Presets may pin any derived token to keep a hand-tuned look.
const PRESET_THEMES = [
  { id: 'midnight', name: 'Midnight', bg: '#000000', surface: '#161617', text: '#f5f5f7', accent: '#ffffff',
    surface2: '#1d1d1f', field: '#232325', text2: '#86868b', text3: '#6e6e73', accentHover: '#d2d2d7' },
  { id: 'graphite', name: 'Graphite', bg: '#1c1c1e', surface: '#2a2a2d', text: '#f2f2f7', accent: '#0a84ff' },
  { id: 'daylight', name: 'Daylight', bg: '#f5f5f7', surface: '#ffffff', text: '#1d1d1f', accent: '#1d1d1f',
    surface2: '#ececf0', field: '#e3e3e8', text2: '#6e6e73', text3: '#8e8e93' },
  { id: 'sunset', name: 'Sunset', bg: '#140c0a', surface: '#24150f', text: '#fff1ea', accent: '#ff7a45' },
  { id: 'ocean', name: 'Ocean', bg: '#06121c', surface: '#0e2131', text: '#e6f4ff', accent: '#38bdf8' },
  { id: 'forest', name: 'Forest', bg: '#0b120d', surface: '#15211a', text: '#eaf5ec', accent: '#4ade80' },
  { id: 'synthwave', name: 'Synthwave', bg: '#0f0a1e', surface: '#1b1233', text: '#f3e9ff', accent: '#ff4fd8' },
  { id: 'amber', name: 'Amber', bg: '#0d0b07', surface: '#1c1810', text: '#fbf3e4', accent: '#f5b942' },
  { id: 'rose', name: 'Rosé', bg: '#fbf3f1', surface: '#ffffff', text: '#2b1a1e', accent: '#d0506e' },
];
const DEFAULT_THEME = 'midnight';
const THEME_CACHE = 'sonora.theme';

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbHex(rgb) {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}
// t of b mixed into a
function mixHex(a, b, t) {
  const x = hexRgb(a), y = hexRgb(b);
  return rgbHex(x.map((c, i) => c + (y[i] - c) * t));
}
function alpha(hex, a) {
  return `rgba(${hexRgb(hex).join(', ')}, ${a})`;
}
function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function themeVars(t) {
  const dark = luminance(t.bg) < 0.4;
  return {
    scheme: dark ? 'dark' : 'light',
    '--bg': t.bg,
    '--surface': t.surface,
    '--surface-2': t.surface2 || mixHex(t.surface, t.text, dark ? 0.05 : 0.04),
    '--field': t.field || mixHex(t.surface, t.text, dark ? 0.09 : 0.08),
    '--text': t.text,
    '--text-2': t.text2 || mixHex(t.text, t.bg, 0.45),
    '--text-3': t.text3 || mixHex(t.text, t.bg, 0.58),
    '--line': alpha(t.text, dark ? 0.12 : 0.14),
    '--line-soft': alpha(t.text, dark ? 0.07 : 0.08),
    '--line-strong': alpha(t.text, dark ? 0.3 : 0.32),
    '--accent': t.accent,
    '--accent-hover': t.accentHover || mixHex(t.accent, t.bg, 0.18),
    '--on-accent': contrast(t.accent, '#000000') >= contrast(t.accent, '#ffffff') ? '#000000' : '#ffffff',
    '--ok': dark ? '#30d158' : '#1f9d4a',
    '--bad': dark ? '#ff453a' : '#d70015',
    '--warn': dark ? '#ffd60a' : '#b25e00',
    '--shadow': dark ? 'rgba(0, 0, 0, .9)' : 'rgba(30, 20, 40, .22)',
    '--scrim': dark ? 'rgba(0, 0, 0, .6)' : 'rgba(20, 20, 30, .28)',
  };
}

function applyVars(vars) {
  const root = document.documentElement;
  root.style.colorScheme = vars.scheme;
  root.dataset.scheme = vars.scheme;
  for (const [k, v] of Object.entries(vars)) if (k.startsWith('--')) root.style.setProperty(k, v);
}

function applyTheme(theme, remember = true) {
  const vars = themeVars(theme);
  applyVars(vars);
  if (remember) {
    // Painted from here on the next start, before Python has answered
    try { localStorage.setItem(THEME_CACHE, JSON.stringify(vars)); } catch { /* storage off */ }
  }
}

try {
  const cached = JSON.parse(localStorage.getItem(THEME_CACHE));
  if (cached) applyVars(cached);
} catch { /* first start, or storage off */ }
