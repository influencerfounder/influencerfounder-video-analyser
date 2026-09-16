#!/usr/bin/env node
// 👥 WHO IS THIS SENTENCE ABOUT? — the appearance check's subject scoping (2026-09-16).
//
// The recreate prompt must not describe how [INFLUENCER] looks (their look comes from reference
// photos, and references beat prompt text on anything they depict). Since v2.39.0 it MUST
// describe everyone else, including whether their skin is bare or marked — nobody else has
// references behind them, so an undescribed second man is drawn from the influencer's.
//
// Those two rules put the checker in a position where it has to know WHO a sentence is about,
// and prose does not say so in every sentence. The model introduces the second man in one
// sentence and continues about him with a pronoun:
//
//     "Beside him walks a second man. His bare arms show no tattoos."
//
// The first version scoped per sentence, so the second sentence — which has no other-person
// marker — was scanned as though it were about the influencer, and reported the word the new
// rule had just asked for. MEASURED that day on the checker alone, no model calls: the same
// fact as a noun phrase came back clean while the pronoun follow-up flagged "tattoos". Pure
// phrasing, which is exactly the shape of an INTERMITTENT flag — a peer session hit it live
// while three saved samples of the same fixture were clean.
//
// The fix carries the subject forward (nearest antecedent). This file pins both directions,
// because the tempting fix — "ignore pronoun sentences" — would silence the false positive by
// blinding the check to the real leak it exists to catch, which is the worse failure.
const RX = require('./promptreg/checks.js');
let p = 0, f = 0;
const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };

const CASES = [
  // [ label, text, should it flag? ]
  ['second man, noun phrase',
   'Beside him stands a second man — a broad-shouldered young man with short dirty-blond wavy hair, bare arms showing no tattoos, wearing a fitted navy polo.', false],
  ['second man, PRONOUN follow-up sentence',
   'Beside him walks a second man. His bare arms show no tattoos and his hair is short and blond.', false],
  ['second man, pronoun in the same sentence',
   'A second man keeps pace — he has no tattoos on his arms and his hair is cropped.', false],
  ['second man, two pronoun sentences deep',
   'A second man walks alongside. He has close-cropped grey hair. His forearms are bare.', false],
  // ── must STILL flag ──────────────────────────────────────────────────────────────────────
  ['influencer named in the sentence',
   '[INFLUENCER] walks toward the lens, his heavily tattooed forearms swinging, dark hair cropped short.', true],
  ['influencer, PRONOUN follow-up sentence',
   '[INFLUENCER] steps out of the car. His hair is dark and cropped, his skin tone pale.', true],
  ['a claim about BOTH men',
   'Neither man has visible tattoos on his forearms.', true],
  // ⚠️ "His beard is full and dark" would NOT flag — the pattern list has "full beard" but no
  // "beard is full", unlike hair and eyes which both have an is/are form. A real gap, pre-dating
  // this scoping work and left alone here so this file tests one thing; the phrasing below is
  // one the patterns genuinely cover, so the assertion is about SUBJECT CARRYING, not coverage.
  ['subject returns to the influencer after the second man',
   'A second man waits by the door. [INFLUENCER] turns to him. His hair is dark and cropped.', true],
];

for (const [label, text, shouldFlag] of CASES) {
  const hits = RX.findAppearanceLeak(text);
  ok((hits.length > 0) === shouldFlag,
    `${shouldFlag ? 'should FLAG' : 'should be clean'}: ${label} → ${JSON.stringify(hits)}`);
}

// The stripper itself, since the subject logic leans on it.
ok(RX.stripOtherPeople('Beside him stands a second man in a navy polo.').indexOf('navy polo') === -1,
  'stripOtherPeople removes the other person and their clothing');
ok(RX.stripOtherPeople('[INFLUENCER] adjusts his cuff.').indexOf('cuff') !== -1,
  'stripOtherPeople leaves a sentence about the influencer alone');

// And the second-person rule it works alongside, so the two cannot be changed apart.
// Realistic LENGTH matters here: the placement rule is a percentage, so a 54-word toy put its
// disclaimer at 44% and failed a sample I had called compliant. That was the test being wrong,
// not the rule — in a real ~500-word prompt the same sentence lands at 16-22%.
const good = 'The video opens on [INFLUENCER] walking a sunlit European street toward the lens, chin lifted, sunglasses on. '
  + '[INFLUENCER] is the person shown in the reference images; the second man beside him is a different person entirely and does not resemble him. '
  + 'That second man has close-cropped grey hair and bare, unmarked arms, and wears a navy polo. '
  + [...Array(18)].map((_, i) => `The camera tracks back a step as they pass a stone facade, shopfront ${i + 1} sliding by behind them.`).join(' ');
ok(RX.findSecondPersonGaps(good).length === 0, 'a compliant two-hander passes the second-person rule');
ok(RX.findSecondPersonGaps(good.replace('is a different person entirely and does not resemble him', 'keeps pace')).length > 0,
  'dropping the no-resemblance sentence is caught');

console.log(f ? `\nappearance-scope: ${f} FAILED, ${p} passed\n` : `\nappearance-scope: ${p} checks green\n`);
process.exit(f ? 1 : 0);
