// 🪝 HOOK GUARD — hookfirst only (v2.54.0, 2026-10-01).
//
// Two checks on the prompt the writer RETURNED, because the instruction alone did not reach it.
// Measured on the FIFA trial-reel retest (2026-10-01): v2.53.0 told the writer "write the hook as
// a MOMENT, never a pose", and it still wrote "faces the lens straight-on … phone resting in both
// hands" (Kryfex motion 5.7 vs the source's 16.2), while the other take wrote "eyes shift slowly
// right" — a tempo word the system prompt already bans by name. A rule in the writer's prompt is a
// request; these two run on the output.
//
//   1. hookMoves(): the head/eye/hand movements named for the influencer in the hook. Fewer than
//      HOOK_MIN_MOVES distinct ones = a pose, and index.js asks the writer ONCE to rewrite only the
//      hook from the hook frames (trigger-based: costs nothing when the hook already moves).
//   2. scrubPersonTempo(): deletes tempo words attached to a person, anywhere in the prompt. Same
//      list and camera exclusion as test/promptreg/checks.js `tempo` / findTempo (kept 1:1): a
//      slow PUSH-IN is legitimate, a slow HEAD TURN renders as playback slow motion.

const HOOK_MIN_MOVES = 2;

// The hook = everything before the first timed line that starts AFTER 0 s. The writer puts the
// overall sentence and the opening description first, then "[0-3s]" (or "Shot 1 [0-1.2s]"), or
// sometimes no [0-…] line at all and goes straight to "[3s-5s]"; either way the first timed line
// with a start above zero is where the hook ends. No such line → the first ~700 characters.
const TIMED = /(?:\bShot\s+\d+\s*)?\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–]\s*\d+(?:\.\d+)?\s*s?\s*\]/gi;
function hookSegment(prompt) {
  const p = String(prompt || '');
  const re = new RegExp(TIMED.source, 'gi');
  let m;
  while ((m = re.exec(p))) if (parseFloat(m[1]) > 0) return p.slice(0, m.index);
  return p.slice(0, 700);
}

// Verbs that are a visible movement of the head, eyes, face or hands. Deliberately NOT here:
// holds, rests/resting, sits, faces, remains, keeps, tracking, settles — those are what a pose is
// written with. "looks" counts only with a direction, because "looks focused" is an expression.
const MOVE = /\b(turn(?:s|ing)?|glanc(?:e|es|ing)|look(?:s|ing)?\s+(?:up|down|around|over|across|away|back|left|right|toward|towards|to|at|off|sideways)|shift(?:s|ing)?|lift(?:s|ing)?|rais(?:e|es|ing)|lower(?:s|ing)?|tilt(?:s|ing)?|nod(?:s|ding)?|shak(?:e|es|ing)|adjust(?:s|ing)?|scroll(?:s|ing)?|tap(?:s|ping)?|lean(?:s|ing)?|swivel(?:s|ling|ing)?|flick(?:s|ing)?|roll(?:s|ing)?|bring(?:s|ing)?|mov(?:e|es|ing)|pull(?:s|ing)?|rub(?:s|bing)?|scratch(?:es|ing)?|gestur(?:e|es|ing)|reach(?:es|ing)?|wip(?:e|es|ing)|blink(?:s|ing)?|dart(?:s|ing)?|scan(?:s|ning)?|sweep(?:s|ing)?|swing(?:s|ing)?|twist(?:s|ing)?|rotat(?:e|es|ing)|check(?:s|ing)?|smirk(?:s|ing)?|smil(?:e|es|ing)|squint(?:s|ing)?|drop(?:s|ping)?|pivot(?:s|ing)?|shrug(?:s|ging)?|point(?:s|ing)?|wav(?:e|es|ing)|touch(?:es|ing)?|swip(?:e|es|ing)|typ(?:e|es|ing)|thumb(?:s|ing)?|bit(?:e|es|ing)|lick(?:s|ing)?|exhal(?:e|es|ing)|inhal(?:e|es|ing)|walk(?:s|ing)?|strid(?:e|es|ing)|step(?:s|ping)?|run(?:s|ning)?|jump(?:s|ing)?|danc(?:e|es|ing)|climb(?:s|ing)?|stand(?:s|ing)?\s+up|sit(?:s|ting)?\s+down|bounc(?:e|es|ing)|sway(?:s|ing)?|spin(?:s|ning)?|hop(?:s|ping)?|slid(?:e|es|ing)|kick(?:s|ing)?|kneel(?:s|ing)?|crouch(?:es|ing)?|push(?:es|ing)?(?!-in))\b/gi;
// A clause about OTHER people or the CAMERA never counts as the influencer moving.
const OTHER = /\b(?:woman|women|man|men|girl|boy|people|person|crowd|fans?|spectators?|bystanders?|audience|someone|neighbou?r|stranger|guard|bodyguard|driver|waiter)\b/i;
// The influencer is ONE person: a clause led by a plural/collective subject is about the others —
// measured 2026-10-01, "Both shift their weight and glance toward the pitch" (the two spectators)
// passed a seated, posed hook as moving.
const PLURAL_LEAD = /^(?:both|each|all|everyone|everybody|others?|the\s+(?:two|pair|others|rest|figures|spectators|fans)|two\s+\w+|several|some)\b/i;
const CAMERA = /\b(?:camera|lens|push-in|pull-out|pans?|tilt(?:s|ing)?\s+(?:up|down)\s+(?:to|from)|zoom|dolly|framing|frame)\b/i;
const PERSON = /\[INFLUENCER\]|\b(?:eyes?|gaze|head|chin|jaw|brows?|lips|mouth|face|hands?|fingers?|thumbs?|wrists?|arms?|shoulders?|body|torso|feet|foot|legs?|knees?|hips?|he|she|they|his|her|their)\b/i;

// Whole-body movement: a hook in which the influencer walks, runs or dances is not a pose,
// whatever else it says.
const LOCOMOTION = new Set(['walk', 'stri', 'step', 'runn', 'run', 'runs', 'jump', 'danc', 'climb', 'hop', 'hops', 'hopp', 'spin', 'bounc']);
function isPosed(segment, name) {
  const mv = hookMoves(segment, name);
  return mv.length < HOOK_MIN_MOVES && !mv.some((v) => LOCOMOTION.has(v));
}

function hookMoves(segment, name) {
  const who = name ? new RegExp('\\b' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null;
  const found = new Set();
  for (const raw of String(segment || '').split(/[.;:!?,]|\s[—–]\s/)) {
    // A camera clause tail ("…fingers opening as the camera pushes in") is cut off, not the
    // whole clause; another person as the OBJECT ("gestures toward the other men") is not
    // another person as the SUBJECT.
    let c = raw.replace(/\b(?:as|while|and)?\s*(?:the\s+)?(?:camera|lens)\b.*$/i, '')
      .replace(/\b(?:toward|towards|at|to|with|beside|behind|past|around|across|of|among|between)\s+(?:the\s+|a\s+|an\s+|other\s+|two\s+|both\s+)*(?:woman|women|man|men|girl|boy|people|person|crowd|fans?|group|spectators?)\b/gi, ' ')
      .trim();
    if (!c) continue;
    const named = (who && who.test(c)) || /\[INFLUENCER\]/.test(c);
    if (!named && (OTHER.test(c) || CAMERA.test(c) || PLURAL_LEAD.test(c))) continue;
    if (!named && !PERSON.test(c)) continue;
    const re = new RegExp(MOVE.source, 'gi');
    let m;
    while ((m = re.exec(c))) found.add(m[1].toLowerCase().slice(0, 4));   // 4-letter stem: turns/turning → turn
  }
  return [...found];
}

// Person-tempo scrub. Sentence-scoped like findTempo; a word within 45 chars before / 30 after a
// camera noun is the LENS and stays; a negated sentence ("never slow motion") stays.
const TEMPO = /\b(?:slowly|slow|unhurried(?:ly)?|deliberately|lingering|lingers?|languid(?:ly)?|leisurely|gradual(?:ly)?|for\s+a\s+beat|dreamlike|slow[- ]motion|slowed(?:-down)?)\b/gi;
const CAMERA_WORD = /\b(?:camera|lens|shot|frame|framing|focus|push-in|push|pan|pans|tilt|drift|drifts|zoom|dolly|rack|tracking)\b/i;
const PEOPLE = /\[INFLUENCER\]|\b(?:he|she|they|him|her|them|his|their|man|woman|person|people|figure|figures|exchange|conversation|gesture|hands?|head|body|arm|arms|fingers?|eyes?|gaze|chin|face)\b/i;
const NEGATION = /\b(?:no|never|not|without|avoid)\b/i;
// Verbs get a real-speed replacement; everything else is an adverb/adjective that is simply dropped.
const VERB_SWAP = { lingers: 'stays', linger: 'stay', lingering: 'staying' };

function scrubPersonTempo(prompt, name) {
  const removed = [];
  const who = name ? new RegExp('\\b' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null;
  // Split on ';' too (unlike findTempo): "…a bust framing; his eyes shift slowly right" is two
  // clauses, and the camera noun in the first must not shield the tempo word in the second.
  const parts = String(prompt || '').split(/((?<=[.!?;])\s+|\s+—\s+|\n+)/);
  const out = parts.map((sent) => {
    if (!sent || !sent.trim()) return sent;
    if (!PEOPLE.test(sent) && !(who && who.test(sent))) return sent;
    if (NEGATION.test(sent)) return sent;
    const re = new RegExp(TEMPO.source, 'gi');
    let res = '', last = 0, n = 0, m;
    while ((m = re.exec(sent))) {
      const before = sent.slice(Math.max(0, m.index - 45), m.index);
      const after = sent.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (CAMERA_WORD.test(before) || CAMERA_WORD.test(after)) continue;
      const w = m[0].toLowerCase();
      res += sent.slice(last, m.index) + (VERB_SWAP[w] || '');
      last = m.index + m[0].length;
      removed.push(m[0]); n++;
    }
    if (!n) return sent;
    res += sent.slice(last);
    // Tidy what a deletion leaves: doubled spaces, "a  head turn", " ,", "in  ".
    return res.replace(/\b(in|a|an)\s+(?=[,.;])/gi, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/,\s*,/g, ',');
  });
  return { text: out.join(''), removed };
}

// The one revision request. Hook frames ride in front (same order the writer saw them).
function reviseHookInstruction(prompt) {
  return 'Below is a video prompt. Its HOOK — the text before the second timed line — describes [INFLUENCER] as a POSE: it names where they sit and what they hold, but not what they DO. '
    + 'Using ONLY the HOOK WINDOW frames above, in their time order, rewrite that hook so it names at least two movements [INFLUENCER]\'s head, eyes or hands actually make across those frames (for example: the head turns to the right, the eyes drop to the phone, a thumb moves on the screen, the chin lifts), each at real-life speed. '
    + 'Describe only movement the frames show; if they show very little, name the smallest real movements they do show. '
    + 'Never use a tempo word about a person (slowly, slow, gradually, unhurried, deliberately, lingering, for a beat). '
    + 'Keep the camera distance, angle, framing, camera state, outfit and every other person exactly as written. '
    + 'Change NOTHING outside the hook: return the complete prompt, word-for-word identical after the hook, and nothing else — no preamble, no explanation.\n\nPROMPT:\n' + prompt;
}

// Accept a revision only when it is the same prompt with a moving hook: it must name more moves,
// keep the tail (everything from the second timed line) intact, and not have lost [INFLUENCER].
function acceptRevision(before, after, name) {
  const a = String(after || '').trim();
  if (!a || a.length < before.length * 0.7 || a.length > before.length * 1.5) return false;
  if (/\[INFLUENCER\]/.test(before) && !/\[INFLUENCER\]/.test(a)) return false;
  const tailOf = (p) => p.slice(hookSegment(p).length).trim();
  const tb = tailOf(before), ta = tailOf(a);
  if (tb && (ta.slice(0, 120) !== tb.slice(0, 120))) return false;
  return hookMoves(hookSegment(a), name).length >= HOOK_MIN_MOVES
      && hookMoves(hookSegment(a), name).length > hookMoves(hookSegment(before), name).length;
}

module.exports = { HOOK_MIN_MOVES, hookSegment, hookMoves, isPosed, scrubPersonTempo, reviseHookInstruction, acceptRevision };
