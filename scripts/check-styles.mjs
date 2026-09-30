// Check styles.css against DESIGN.md. Prints every rule that breaks one, and exits 1 if any.
//   node scripts/check-styles.mjs [path/to/styles.css]      (npm run check:styles)
import fs from 'node:fs';
const file = process.argv[2] || new URL('../styles.css', import.meta.url);
const css = fs.readFileSync(file, 'utf8');
const rules = [];
css.replace(/([^{}]+)\{([^{}]*)\}/g, (w, sel, body) => { rules.push({ sel: sel.replace(/\/\*[\s\S]*?\*\//g, '').trim(), body }); return w; });
const problems = [];
const say = (rule, why) => problems.push(`${why.padEnd(44)} ${rule.sel.replace(/\s+/g, ' ').slice(0, 90)}`);

const COLOUR = /accent-fill|good-fill|bad-fill|warn-fill|var\(--(accent|good|bad|warn)(-hi)?\)|rgba\((122,120,245|var\(--accent-rgb\)|111,191,134|236,124,114|234,183,103)/;
// Colour by nature, not boxes (DESIGN.md §3).
const NATURE = /si-time|dot\b|-dot|\.dot|\.d\b|fill\b|-fill|\.lt-mk|caret|::selection|::before|::after|\bi\b|bigplay|lt-step|radial|-mark|ac-status|\.lt-run\[|@keyframes|^\d+%$/;
const ACCENT_RING = /rgba\((?:122,120,245|var\(--accent-rgb\)),\.(\d+)\)/;

for (const r of rules) {
  if (!r.sel || r.sel.startsWith('@')) continue;
  const bg = /(^|;|\s)background(?:-color)?:([^;]+)/.exec(r.body)?.[2] || '';
  // §3 no coloured fills
  if (COLOUR.test(bg) && !/radial-gradient/.test(bg) && !NATURE.test(r.sel)) say(r, '§3 coloured fill (use an outline)');
  // §2 corner tokens only
  const radius = /border-radius:([^;]+)/.exec(r.body)?.[1] || '';
  if (/\d+(\.\d+)?px/.test(radius) && !/^0(px)?$/.test(radius.trim())) say(r, '§2 raw px border-radius (use --r tokens)');
  // §4 purple text inside a purple outline
  if (/(^|;|\s)color:var\(--accent(-hi)?\)/.test(r.body) && /(box-shadow|border(-color)?):[^;]*(rgba\(122,120,245|var\(--accent-rgb\)|var\(--accent)/.test(r.body)) say(r, '§4 purple text inside an outline (use --text)');
  // §6 odd icon sizes
  const w = /(^|;|\s)width:(\d+)px/.exec(r.body)?.[2];
  if (/\bsvg\b/.test(r.sel) && w && Number(w) % 2 === 1 && Number(w) > 9) say(r, `§6 odd icon size ${w}px (use even)`);
}
// §5 purple at rest: an accent outline on a selector with no state in it
const STATE = /:hover|\.has-update\b|\.about-version\.pending|:focus|:active|\.active\b|\.on\b|\.pinned\b|\.open\b|\.selected\b|\.current\b|\.kb\b|\.sorted\b|\.live\b|\.is-live\b|aria-pressed="true"|aria-selected|dragging|\.compacting|\.running|\.now\b|state-connected|\.settings-badge\.ok|\.mcp-dot\.ok|\.qt-dot\.ok/;
// In use while shown (DESIGN.md §5): purple is right for these.
const IN_USE = /^(\.si-rename|\.drop-overlay|\.approval-dock|\.agent-banner)$/;
for (const r of rules) {
  if (!r.sel || r.sel.startsWith('@') || /^\d+%/.test(r.sel) || IN_USE.test(r.sel)) continue;
  // A row with a rename box in it is in use while you type (DESIGN.md §3/§5).
  if (r.sel.split(',').every((s) => /:has\(\.si-rename\)/.test(s))) continue;
  if (r.sel.split(',').some((s) => STATE.test(s))) continue;
  const outline = /(box-shadow|border(?:-color|-left|-top|-right|-bottom)?):[^;]*(rgba\(122,120,245|var\(--accent-rgb\)|var\(--accent\))/.test(r.body);
  if (outline) say(r, '§5 accent outline at rest (use var(--line-2))');
}
// §5 purple TEXT at rest: only links, and things selected or in use, are purple before hover
const PURPLE_TEXT_OK = /^(\.md a|\.about-inline-link|\.wn-link|\.queued-badge|\.drop-card svg|\.mp-check)$/;
for (const r of rules) {
  if (!r.sel || r.sel.startsWith('@') || /^\d+%/.test(r.sel)) continue;
  if (!/(^|;|\s)color:var\(--accent(-hi)?\)/.test(r.body)) continue;
  for (const s of r.sel.split(',').map((x) => x.trim())) {
    if (STATE.test(s) || s.includes('::selection') || PURPLE_TEXT_OK.test(s)) continue;
    say({ sel: s }, '§5 accent text at rest (white/grey, purple on hover)');
  }
}
// §5 buttons: no grey fill at rest, and a hover that turns purple (red for danger)
const BUTTON = /btn|button|-pick\b|pick-|\.tab\b|-seg\b|toggle|-back\b|\.cicon|lt-pp|lt-run\b|mp-chip|mp-sort|pd-sort-btn|agent-chip/;
// Not buttons, or buttons that must keep a backing: menus and pop-ups, text fields, cards,
// labels, and controls that sit on top of an image.
const NOT_BUTTON = /launch-note|menu|pop\b|-pop|text\b|input|textarea|::|lb-close|lb-nav|att-x|chip\b(?!.*(mp|agent))|km-auto|run\.off|run\.live|disabled|\s\.x\b|\.x:|reveal|:hover \.|focus-visible/;
const GREY_FILL = /var\(--glass-[23]\)|rgba\(255,\s*255,\s*255,\s*\.\d+\)/;
for (const r of rules) {
  if (!r.sel || r.sel.startsWith('@')) continue;
  for (const s of r.sel.split(',').map((x) => x.trim())) {
    if (!BUTTON.test(s) || NOT_BUTTON.test(s)) continue;
    const bg = /(^|;|\s)background:([^;]+)/.exec(r.body)?.[2] || '';
    if (!STATE.test(s) && GREY_FILL.test(bg)) say({ sel: s }, '§5 button with a grey fill at rest');
    if (/:hover$/.test(s) && !/rgba\((122,120,245|var\(--accent-rgb\)|236,124,114|111,191,134)|var\(--(accent|bad|good)\)/.test(r.body)) say({ sel: s }, '§5 button hover that never turns to the accent');
  }
}
// §5 every selected state has a brighter hover
const hovers = new Set();
for (const r of rules) for (const s of r.sel.split(',')) if (s.includes(':hover')) hovers.add(s.trim());
for (const r of rules) {
  const m = ACCENT_RING.exec(r.body);
  if (!m || Number('0.' + m[1]) > 0.6) continue;
  for (const s of r.sel.split(',').map((x) => x.trim())) {
    // A label inside a selected box (`.x.on .label`) lights up with its box: only the box itself needs a :hover.
    if (!/\.(active|on|pinned|open|selected)\b|aria-pressed="true"/.test(s.split(' ').pop()) || s.includes(':hover') || s.includes('::')) continue;
    if (!hovers.has(`${s}:hover`)) say({ sel: s }, '§5 selected state with no brighter :hover');
  }
}
console.log(problems.length ? problems.join('\n') + `\n\n${problems.length} problem(s)` : 'styles.css follows DESIGN.md');
process.exit(problems.length ? 1 : 0);
