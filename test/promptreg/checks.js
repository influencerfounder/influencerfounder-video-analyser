// Assertion patterns for the prompt regression suite.
//
// ⚠️ CALIBRATION RULE. Every pattern here is checked against the 7 BASELINE prompts
// (results/before.json) before it is trusted. A pattern that fires on a known-good
// baseline is a BROKEN PATTERN, not a broken prompt — tighten it here. Never loosen
// the system prompt to satisfy a regex.
//
// Word boundaries matter more than they look. "build" appears inside "building",
// "tan" inside "distant", "olive" in "olive-toned walls". Each pattern below is
// anchored so it can only match a description OF THE PERSON.

module.exports = {

  // A — appearance leak. The recreate prompt must never describe how the SOURCE
  // person looks; the user substitutes their own influencer, whose look comes from
  // reference photos, and references beat prompt text on anything they depict.
  // So describing the source can only ever fight them.
  appearance: [
    /\b(?:short|long|shoulder-length|medium-length|cropped|buzzed|shaved)\s+(?:\w+\s+)?hair\b/i,
    /\b(?:dark|light|blonde|blond|brown|black|red|ginger|grey|gray|silver)\s+hair\b(?!\s*(?:dryer|drier|product|jar|tub|brush|comb|clip|tie|band|gel|wax|spray|oil|serum|mask|cream|salon|straightener|curler|clipper|trimmer|towel))/i,
    /\bhair\s+is\s+(?:dark|light|blonde|blond|brown|black|red|grey|gray)\b/i,
    /\b(?:full|short|thick|trimmed|neat|scruffy|dark|light)\s+beard\b/i,
    /\bbeard(?:ed)?\s+(?:man|guy|male)\b/i,
    /\bclean-shaven\b/i,
    /\bstubble\b/i,
    /\b(?:blue|brown|green|hazel|grey|gray|dark)\s+eyes\b/i,
    /\beyes\s+are\s+(?:blue|brown|green|hazel|grey|gray)\b/i,
    /\b(?:pale|fair|olive|tan|tanned|dark|light|brown|black)\s+skin\b/i,
    /\bskin\s+tone\b/i,
    /\b(?:in\s+his|in\s+her|in\s+their)\s+(?:early|mid|late)?\s?(?:teens|twenties|thirties|forties|fifties)\b/i,
    /\b(?:early|mid|late)-(?:twenties|thirties|forties)\b/i,
    /\b\d{2}-year-old\b/i,
    /\b(?:tall|short)\s+(?:man|woman|guy|girl|male|female)\b/i,
    /\b(?:muscular|athletic|slim|slender|stocky|lean|heavyset)\s+(?:build|frame|physique|man|woman)\b/i,
    /\bbuild\s+is\s+(?:muscular|athletic|slim|lean|stocky)\b/i,
    /\b(?:tattoo|tattoos|tattooed)\b/i,
    /\b(?:asian|black|white|caucasian|hispanic|latino|latina|middle-eastern|african)\s+(?:man|woman|guy|girl|male|female)\b/i,
  ],

  // B — generation parameters stated as prose. These are set by the tool's own
  // chips (aspect, resolution, duration); repeating them in the prompt spends
  // Seedance's ~150-word attention budget on something the parameter already
  // guarantees, and a stated duration can actively fight the real one.
  params: [
    /\b9:16\b/,
    /\b16:9\b/,
    /\b4:5\b/,
    /\b(?:480|720|1080)p\b/i,
    /\b4K\b/,
    /\b\d{1,2}\s?fps\b/i,
    /\bframe\s+rate\b/i,
    /\bvertical\s+(?:video|format|orientation)\b/i,
    /\bportrait\s+format\b/i,
    /\baspect\s+ratio\b/i,
    /\b(?:total\s+)?duration\s+(?:of\s+)?\d/i,
    /\b\d{1,2}[- ]second\s+(?:clip|video)\b/i,
  ],

  // C — crowd/paparazzi filler. The ACCURACY OVER EMBELLISHMENT guard exists
  // because one source (a man walking past a woman who glances at him) was being
  // inflated into a filming crowd. These are the exact inventions it bans.
  crowdFiller: [
    /\beveryone\s+(?:is\s+)?(?:filming|recording|staring|watching)\b/i,
    /\bcelebrity\s+(?:sighting|moment|energy)\b/i,
    /\bpaparazzi\b/i,
    /\bcrowd\s+(?:staring|filming|recording|gathering)\b/i,
    /\bphones?\s+(?:raised|held\s+up|pointed)\s+(?:at|toward|towards)\b/i,
    /\bfilming\s+(?:him|her|them|\[INFLUENCER\])\b/i,
    /\bfans\s+(?:filming|recording|screaming)\b/i,
    /\bbystanders\s+(?:all\s+)?(?:staring|filming|reacting)\b/i,
  ],

  // ⭐ F — MOTION. The reason this suite exists.
  //
  // movement: at least one of these must appear. A prompt describing nothing that
  // moves produces a frozen video — the cosanostra failure (source motion 0.862,
  // recreate 0.149, 17% kept).
  movement: [
    // ⚠️ 'step' is a NOUN as often as a verb ('a low stone entrance step'), so the bare
    // word is not evidence of movement. Require a direction to make it a verb.
    /\b(?:walks?|walking|strides?|striding)\b/i,
    /\b(?:steps?|stepping)\s+(?:forward|back|backward|down|up|out|in|into|onto|off|toward|towards|aside|over|through|past)\b/i,
    /\b(?:turns?|turning|spins?|spinning|pivots?)\b/i,
    /\b(?:reaches?|reaching|lifts?|lifting|raises?|raising|lowers?|lowering)\b/i,
    /\b(?:pulls?|pulling|pushes?|pushing)\b/i,
    /\b(?:looks?\s+(?:up|down|back|over|away|toward)|glances?|glancing)\b/i,
    /\b(?:runs?\s+(?:his|her|their)\s+hand|brushes?|adjusts?|adjusting)\b/i,
    /\b(?:leans?|leaning|crouches?|crouching|sits?\s+down|stands?\s+up|rises?)\b/i,
    /\b(?:exits?|exiting|enters?|entering|climbs?|climbing|gets?\s+(?:in|out))\b/i,
    /\b(?:hands?\s+(?:move|moving)|gestures?|gesturing|waves?|waving)\b/i,
    /\b(?:passes?|passing|crosses?|crossing|approaches?|approaching)\b/i,
    /\b(?:swings?|swinging|throws?|throwing|drops?|dropping|places?|placing)\b/i,
    /\b(?:dances?|dancing|jumps?|jumping|sways?|swaying|rocks?|rocking)\b/i,
    /\b(?:sprays?|spraying|pours?|pouring|drinks?|drinking|eats?|eating)\b/i,
    /\bmoves?\s+(?:toward|forward|closer|past|through|across)\b/i,
  ],

  // stillSubject: on a source that measurably moves, the prompt must NOT claim the
  // subject holds still. A static CAMERA is legitimate and is NOT in this list —
  // only claims about the PERSON being motionless.
  stillSubject: [
    /\bnearly\s+still\b/i,
    /\bstands?\s+(?:completely\s+|perfectly\s+|almost\s+|nearly\s+)?still\b/i,
    /\b(?:remains?|stays?|holds?)\s+(?:completely\s+|perfectly\s+|almost\s+)?(?:still|motionless|frozen)\b/i,
    /\bmotionless\b/i,
    /\bbarely\s+(?:moves?|moving|perceptible)\b/i,
    /\bonly\s+the\s+very\s+subtle\b/i,
    /\bminimal\s+movement\b/i,
    /\bno\s+(?:real\s+)?(?:movement|motion)\b/i,
    /\balmost\s+no\s+(?:movement|motion)\b/i,
    /\bstatic\s+(?:pose|posture|figure|subject)\b/i,
    /\bfrozen\s+in\s+place\b/i,
  ],

  // ⭐ ATTRIBUTION. Measured 2026-09-04 on the real baselines: matching movement verbs
  // anywhere in the prompt is WORSE THAN NO CHECK. The freeze case scored 5 movement
  // hits and every one was a false positive — a noun ("entrance step"), a narrative verb
  // ("the clip opens"), the camera ("sway of the camera hold"), and two explicit
  // NEGATIONS ("does not walk", "does not wave"). So the one prompt in the set that
  // described nothing moving looked the healthiest. Same negation-matching trap this
  // codebase has hit before (2026-09-01, a "no slow motion" check matching its own ban).
  //
  // Fix: only count a verb when the SENTENCE it sits in is about the person and is not
  // a negation. Sentence scope is the unit because that is where the subject lives.
  PERSON: /\[INFLUENCER\]|\b(?:he|she|they|him|her|them|his|their)\b/i,
  NEGATION: /\b(?:does|do|did|is|are|was|were)\s+not\b|\bmakes?\s+no\b|\bnever\b|\bwithout\b|\bno\s+(?:gesture|movement|motion|other)\b|\bnor\b/i,

  // The camera moving is not the subject moving. A sentence about the camera is excluded
  // even when it names the person, because "the camera drifts past [INFLUENCER]" describes
  // the lens, not the body.
  CAMERA_SUBJECT: /\b(?:the\s+)?(?:camera|lens|shot|clip|video|footage|frame)\b[^.]{0,40}\b(?:opens?|holds?|stays?|remains?|drifts?|pans?|tilts?|pushes?|moves?|begins?|starts?)\b/i,

  // ⭐ G — TEMPO WORDS ON THE PERSON (added 2026-09-05, the Paris-recreate class).
  //
  // The failure: a slowed-down source (a "slowed" track, slow-mo edit) made the analyser write
  // "slowly pulls the sunglasses down… a deliberate, unhurried pull-down… calm and unhurried",
  // and Seedance rendered those words as PLAYBACK slow motion — the fake, floaty look — while the
  // clip length matched the source exactly (9.97s → 10.04s). Duration was not the lever; the
  // words were. The system prompt now bans this exact list for anyone in frame; this list MUST
  // stay identical to the one quoted in ORIGINAL_CLONE_SYSTEM.
  //
  // ⚠️ CALIBRATION NOTE: the 7 stored baselines PREDATE this rule and 6 of them carry 1–2 hits
  // (calibrate.js shows them). That is expected — they are the old behaviour, not false positives.
  // ⚠️ "deliberate" (adjective) is NOT matched, on purpose: the first full run under the rule had
  // Claude still writing "a short deliberate look" / "deliberate strokes" — intent, not tempo, and
  // a slow LOOK described as "short" is the opposite of the failure. Only "deliberately" counts.
  // The camera exclusion IS calibrated on them: "the camera slowly pushes in", "the camera slowly
  // drifts in", "a slow push-in" must never count, because a slow LENS is legitimate.
  tempo: /\b(?:slowly|slow|unhurried(?:ly)?|deliberately|lingering|lingers?|languid(?:ly)?|leisurely|gradual(?:ly)?|for\s+a\s+beat|dreamlike|slow[- ]motion|slowed(?:-down)?)\b/gi,
  // A tempo word within ~45 chars of one of these describes the lens, not the body.
  CAMERA_WORD: /\b(?:camera|lens|shot|frame|framing|focus|push-in|push|pan|pans|tilt|drift|drifts|zoom|dolly|rack|tracking)\b/i,
  // A sentence has to be ABOUT people for a tempo word in it to be a subject-tempo claim; "the
  // lantern light gradually…" is scenery.
  PEOPLE: /\[INFLUENCER\]|\b(?:he|she|they|him|her|them|his|their|man|woman|person|people|figure|figures|exchange|conversation|gesture|hands?|head|body|arm|arms|fingers?)\b/i,

  // Informational only — a static camera alone is fine and often correct.
  staticCamera: [
    /\bcamera\s+(?:holds?|remains?|stays?)\s+(?:completely\s+)?static\b/i,
    /\bstatic\s+(?:camera|shot|frame)\b/i,
    /\blocked[- ]off\s+(?:camera|shot)\b/i,
    /\bno\s+pan,?\s+no\s+tilt\b/i,
    /\bcamera\s+does\s+not\s+move\b/i,
  ],
};

// Movement attributed to the PERSON. Returns the genuine hits only.
// Verified against the three real baselines (2026-09-04): the freeze case drops
// 5 → 0 while the two healthy sources keep 6 and 3. That separation is the whole
// point — a check that cannot fail on the known-bad case is false confidence.
module.exports.findMovement = function (prompt) {
  const M = module.exports;
  const hits = [];
  // Split on sentence enders AND em-dashes: the freeze case hangs its negation off a
  // dash ("still throughout the clip — he does not walk"), so a dash begins a new claim.
  for (const raw of String(prompt || '').split(/(?<=[.!?])\s+|\s+—\s+/)) {
    const sent = raw.trim();
    if (!sent) continue;
    if (!M.PERSON.test(sent)) continue;        // not about the person
    if (M.NEGATION.test(sent)) continue;       // "does not walk", "makes no gesture"
    if (M.CAMERA_SUBJECT.test(sent)) continue; // the lens moving is not the body moving
    for (const r of M.movement) {
      const m = sent.match(r);
      if (m) hits.push({ verb: m[0], sentence: sent.slice(0, 90) });
    }
  }
  return hits;
};

// Stillness claims about the PERSON only.
//
// ⚠️ Symmetrical to findMovement, and for a concrete reason: "the camera holds still" is a
// LEGITIMATE and common instruction — the system prompt explicitly allows it ("a static
// CAMERA is legitimate ... but 'the camera holds' must never become 'the person holds
// still'"). Matching the raw pattern anywhere would fail a healthy prompt for obeying the
// rule it was given. The freeze case escaped this only by chance — it happened to phrase it
// "the camera stays locked in this position", which no pattern matches.
module.exports.findStillness = function (prompt) {
  const M = module.exports;
  const hits = [];
  for (const raw of String(prompt || '').split(/(?<=[.!?])\s+|\s+—\s+/)) {
    const sent = raw.trim();
    if (!sent) continue;
    // A sentence about the lens is not a claim about the body.
    if (/\b(?:camera|lens|shot|frame|framing)\b/i.test(sent) && !M.PERSON.test(sent)) continue;
    for (const r of M.stillSubject) {
      const m = sent.match(r);
      if (m) hits.push({ phrase: m[0], sentence: sent.slice(0, 90) });
    }
  }
  return hits;
};

// Crowd filler, negation- and style-aware.
//
// ⚠️ Calibrated on a real false positive (2026-09-04): a prompt described "through-the-crowd
// paparazzi-style framing EVEN THOUGH NO CROWD EXISTS — just this one individual". That is a
// camera-framing description that explicitly denies a crowd, i.e. the OPPOSITE of the failure
// this guard exists for, and the bare /paparazzi/ pattern failed it anyway.
//
// Safe to soften: the real 2026-09-02 failure ("phones pointed at", "everyone filming",
// "celebrity sighting", "fans filming") trips several of the other patterns, none of which
// sit in a negation. A single adjectival "paparazzi-style" is not that failure.
module.exports.findCrowdFiller = function (prompt) {
  const M = module.exports;
  const hits = [];
  for (const raw of String(prompt || '').split(/(?<=[.!?])\s+/)) {
    const sent = raw.trim();
    if (!sent) continue;
    // "no crowd exists", "does not turn", "without onlookers" — a denial is not an invention.
    if (M.NEGATION.test(sent) || /\bno\s+(?:crowd|onlookers?|bystanders?|paparazzi|attention)\b/i.test(sent)) continue;
    for (const r of M.crowdFiller) {
      const m = sent.match(r);
      // "paparazzi-style/-like framing" describes the LENS, not invented attention.
      if (m && /^paparazzi$/i.test(m[0]) && /paparazzi[-\s](?:style|like|esque)/i.test(sent)) continue;
      if (m) hits.push(m[0]);
    }
  }
  return hits;
};

// they/them used as the INFLUENCER'S pronoun.
//
// ⚠️ CALIBRATED TWICE ON REAL FALSE POSITIVES, both on healthy baselines:
//   1. "a second person ... THEIR out-of-focus back frames [INFLUENCER]" -- a real bystander
//      whose gender is genuinely not visible; inventing one would be an appearance claim
//      that a different rule already bans.
//   2. "pulling THEM down from his eyes" -- "them" is the SUNGLASSES. A plural object.
//      Ordinary English, in a prompt that is otherwise fully he/him.
//
// So antecedent-guessing is the wrong tool. Key on the failure's actual signature instead:
// the 2026-09-03 bug was the analyser having NO gender and writing the whole prompt neutral
// (he/him 0, they/them everywhere). A prompt that leans gendered is fine no matter how many
// objects it refers to as "them". Flag only when the neutral pronouns MATCH OR OUTNUMBER the
// gendered ones -- that is the fallback, and the positive "pronouns are he/him" assertion
// already covers the total-absence case from the other side.
module.exports.findWrongPronoun = function (prompt, gender) {
  const text = String(prompt || '');
  const count = (re) => (text.match(re) || []).length;
  const gendered = gender === 'male'
    ? count(/\b(he|him|his)\b/gi)
    : gender === 'female' ? count(/\b(she|her|hers)\b/gi) : 0;
  const neutral = count(/\b(they|them|their)\b/gi);
  if (!neutral) return [];
  // ⚠️ THRESHOLD, calibrated against real false positives -- see above. A prompt refers to
  // objects ("pulling THEM down from his eyes") and to genuine third parties ("THEIR blurred
  // shoulder") in ordinary English, so any neutral pronoun at all is not evidence. Requiring
  // neutral to merely MATCH gendered was still too tight: it fired at 2-vs-2 and 1-vs-1.
  // The bug's real signature is a prompt that LEANS neutral -- gendered absent, or swamped.
  // The positive "pronouns are she/her" assertion already covers gendered===0 from the other
  // side, so this rule's job is the mixed case, and a 3x lean is unambiguous.
  if (gendered > 0 && neutral < 3 * gendered) return [];
  return [`${neutral} they/them vs ${gendered} ${gender === 'male' ? 'he/him' : 'she/her'}`];
};

// Tempo words attributed to a PERSON (not the camera). Returns the genuine hits only.
//
// Same attribution discipline as findMovement: sentence-scoped, and a word is skipped when a
// camera noun sits within 45 characters before it or 30 after ("the camera slowly drifts in",
// "a slow push-in"). Negated sentences are skipped too — the prompt is allowed to SAY "never
// slow motion" (the 2026-09-01 negation-matching trap).
module.exports.findTempo = function (prompt) {
  const M = module.exports;
  const hits = [];
  for (const raw of String(prompt || '').split(/(?<=[.!?])\s+|\s+—\s+|\n+/)) {
    const sent = raw.trim();
    if (!sent) continue;
    if (!M.PEOPLE.test(sent)) continue;
    if (M.NEGATION.test(sent)) continue;
    const re = new RegExp(M.tempo.source, 'gi');
    let m;
    while ((m = re.exec(sent))) {
      const before = sent.slice(Math.max(0, m.index - 45), m.index);
      const after = sent.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (M.CAMERA_WORD.test(before) || M.CAMERA_WORD.test(after)) continue;
      hits.push({ word: m[0], sentence: sent.slice(0, 90) });
    }
  }
  return hits;
};
