// Free structural check — no API calls, no cost.
//
// The suite only exercises promptStyle:'original'. REALISM_CLONE_SYSTEM is not a hand-kept
// copy, it is derived from ORIGINAL by a single .replace() at module load — so the classic
// twin-drift failure ("fixed one path, sibling kept the bug", which this codebase has shipped
// repeatedly) is structurally impossible HERE, with exactly one exception: if the .replace()
// anchor sentence is ever edited or moved, the replace silently matches nothing and REALISM
// stops being what anyone thinks it is. That is what this file asserts, for $0, so the second
// arm never has to be paid for on every run.
const fs = require('path').join(__dirname, '..', '..', 'index.js');
const src = require('fs').readFileSync(fs, 'utf8');

// Pull a string constant out of the shipping file, quote-aware.
function literal(name) {
  const i = src.indexOf('const ' + name);
  if (i < 0) return null;
  let j = src.indexOf('=', i) + 1, q = null, out = '';
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { out += c; if (c === '\\') { out += src[++j]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; out += c; continue; }
    if (c === ';') break;
    out += c;
  }
  return out;
}

const ORIG = literal('ORIGINAL_CLONE_SYSTEM');
const REAL = literal('REALISM_CLONE_SYSTEM');
const out = [];
const t = (name, ok, detail) => out.push({ name, ok, detail: ok ? '' : detail });

t('ORIGINAL_CLONE_SYSTEM exists', !!ORIG, 'constant not found — index.js changed shape');
t('REALISM_CLONE_SYSTEM exists', !!REAL, 'constant not found — index.js changed shape');
t('REALISM is DERIVED from ORIGINAL, not a second copy',
  /ORIGINAL_CLONE_SYSTEM\s*\.replace\(/.test(REAL || ''),
  'REALISM no longer derives from ORIGINAL — the two are now hand-maintained twins and WILL drift');

// The anchor the .replace() targets must still exist verbatim in ORIGINAL, or the replace is
// a silent no-op and REALISM loses its lane line while looking fine.
const anchor = (REAL || '').match(/\.replace\(\s*'([^']+)'/);
t('the .replace() anchor still exists in ORIGINAL',
  !!(anchor && ORIG && ORIG.includes(anchor[1])),
  anchor ? `anchor "${anchor[1].slice(0, 48)}..." is NOT present in ORIGINAL — the replace matches nothing` : 'could not read the anchor');

// Every rule the motion fix added must be inside ORIGINAL, so REALISM inherits it for free.
const RULES = [
  ['motion-is-accuracy rule', /MOTION IS PART OF ACCURACY/],
  ['never-motionless rule', /NEVER write the subject as motionless/],
  ['banned stillness phrasings', /stands completely still/],
  ['camera-still vs person-still distinction', /the camera holds.{0,40}the person holds still/i],
  ['do-not-invent-action guard', /do not invent action the frames do not show/i],
  ['crowd accuracy guard', /crowd staring/i],
  ['parameters-not-prose rule', /PARAMETERS ARE NOT PROSE/],
  ['tempo-word ban (real-time even on a slowed source)', /NEVER attach a tempo word to a person/],
];
for (const [name, re] of RULES) {
  t(`ORIGINAL carries the ${name}`, re.test(ORIG || ''), 'rule missing from ORIGINAL');
  t(`REALISM inherits the ${name}`, re.test(REAL || '') || re.test(ORIG || ''), 'rule would not reach the realism arm');
}

let fails = 0;
console.log('\nTWIN CHECK — does the realism arm inherit every rule the original arm has?\n');
for (const r of out) {
  if (!r.ok) fails++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '\n         ↳ ' + r.detail}`);
}
console.log(fails ? `\n${fails} FAILED — the two Recreate arms are out of sync\n` : '\nBoth Recreate arms carry the same rules.\n');
process.exit(fails ? 1 : 0);
