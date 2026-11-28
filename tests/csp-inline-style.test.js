'use strict';
// Smoke test: the CSP is `style-src 'self'` (src/http.js), so any inline style the page
// creates as an attribute (el(..., { style: '...' }), setAttribute('style', ...), style="..."
// in an HTML string) is blocked and logs a CSP console error. Hide/show with the `hidden`
// attribute instead. CSSOM writes such as `el.style.x = ...` are allowed and not flagged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Intl.NumberFormat options legitimately use `style:` (e.g. { style: 'currency' }).
const INTL_STYLES = new Set(['currency', 'percent', 'decimal', 'unit']);

function offenders() {
  const found = [];
  source.split('\n').forEach((line, i) => {
    const hits = [];
    for (const m of line.matchAll(/\bstyle\s*:\s*(['"`])?([\w-]*)/g)) {
      if (!(m[1] && INTL_STYLES.has(m[2]))) hits.push(m[0]);
    }
    if (/setAttribute\(\s*['"]style['"]/.test(line)) hits.push("setAttribute('style'");
    if (/\bstyle\s*=\s*\\?["']/.test(line)) hits.push('style="..." in markup');
    if (hits.length) found.push(`public/app.js:${i + 1}: ${hits.join(', ')}`);
  });
  return found;
}

test('public/app.js creates no inline-style attributes (blocked by CSP style-src)', () => {
  assert.deepEqual(offenders(), [], 'inline style found; use the hidden attribute or a CSS class');
});

test('inline-style detector flags the patterns it should', () => {
  const bad = ["el('img', { style: 'display: none' })", "n.setAttribute('style', 'x')", '`<p style="color:red">`'];
  for (const s of bad) {
    const hit = /\bstyle\s*:\s*(['"`])?([\w-]*)/.test(s) || /setAttribute\(\s*['"]style['"]/.test(s) || /\bstyle\s*=\s*\\?["']/.test(s);
    assert.ok(hit, s);
  }
});
