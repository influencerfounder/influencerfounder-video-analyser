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
// Bracketed "[3-5s]" / "Shot 2 [1.2-3s]", or a line that STARTS "3–5s:" (the writer uses both).
const TIMED = /(?:\bShot\s+\d+\s*)?\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–]\s*\d+(?:\.\d+)?\s*s?\s*\]|(?:^|\n)[ \t]*(\d+(?:\.\d+)?)\s*s?\s*[-–]\s*\d+(?:\.\d+)?\s*s\s*:/gi;
function hookSegment(prompt) {
  const p = String(prompt || '');
  const re = new RegExp(TIMED.source, 'gi');
  let m;
  while ((m = re.exec(p))) if (parseFloat(m[1] != null ? m[1] : m[2]) > 0) return p.slice(0, m.index + (m[0].match(/^\n/) ? 1 : 0));
  return p.slice(0, 700);
}

// Verbs that are a visible movement of the head, eyes, face or hands. Deliberately NOT here:
// holds, rests/resting, sits, faces, remains, keeps, tracking, settles — those are what a pose is
// written with. "looks" counts only with a direction, because "looks focused" is an expression.
const MOVE = /\b(turn(?:s|ing)?|glanc(?:e|es|ing)|look(?:s|ing)?\s+(?:up|down|around|over|across|away|back|left|right|toward|towards|to|at|off|sideways)|shift(?:s|ing)?|lift(?:s|ing)?|rais(?:e|es|ing)|lower(?:s|ing)?|tilt(?:s|ing)?|nod(?:s|ding)?|shak(?:e|es|ing)|adjust(?:s|ing)?|scroll(?:s|ing)?|tap(?:s|ping)?|lean(?:s|ing)?|swivel(?:s|ling|ing)?|flick(?:s|ing)?|roll(?:s|ing)?|bring(?:s|ing)?|mov(?:e|es|ing)|pull(?:s|ing)?|rub(?:s|bing)?|scratch(?:es|ing)?|gestur(?:e|es|ing)|reach(?:es|ing)?|wip(?:e|es|ing)|blink(?:s|ing)?|dart(?:s|ing)?|scan(?:s|ning)?|sweep(?:s|ing)?|swing(?:s|ing)?|twist(?:s|ing)?|rotat(?:e|es|ing)|check(?:s|ing)?|smirk(?:s|ing)?|smil(?:e|es|ing)|squint(?:s|ing)?|drop(?:s|ping)?|pivot(?:s|ing)?|shrug(?:s|ging)?|point(?:s|ing)?|wav(?:e|es|ing)|touch(?:es|ing)?|swip(?:e|es|ing)|typ(?:e|es|ing)|thumb(?:s|ing)?|bit(?:e|es|ing)|lick(?:s|ing)?|exhal(?:e|es|ing)|inhal(?:e|es|ing)|walk(?:s|ing)?|strid(?:e|es|ing)|step(?:s|ping)?|run(?:s|ning)?|jump(?:s|ing)?|danc(?:e|es|ing)|climb(?:s|ing)?|stand(?:s|ing)?\s+up|sit(?:s|ting)?\s+down|bounc(?:e|es|ing)|sway(?:s|ing)?|spin(?:s|ning)?|hop(?:s|ping)?|slid(?:e|es|ing)|kick(?:s|ing)?|kneel(?:s|ing)?|crouch(?:es|ing)?|push(?:es|ing)?(?!-in)|jiggl(?:e|es|ing)|fidget(?:s|ing)?|uncross(?:es|ing)?|bob(?:s|bing)?)\b/gi;
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
function reviseHookInstruction(prompt, note) {
  return 'Below is a video prompt. Its HOOK — the text before the second timed line — describes [INFLUENCER] as a POSE, or misses a movement that was measured: it names where they sit and what they hold, but not everything they DO. '
    + (note ? note + ' ' : '')
    + 'Using ONLY the HOOK WINDOW frames above, in their time order, rewrite that hook so it names, in order, EVERY movement [INFLUENCER] actually makes across those frames — head, eyes, hands, arms, shoulders, torso, legs, knees and feet, whichever are in frame (for example: the head turns to the right, the eyes drop to the phone, a thumb moves on the screen, a knee bounces, a leg shifts) — at least two, each at real-life speed. '
    + 'Describe only movement the frames show; if they show very little, name the smallest real movements they do show. '
    + 'Never use a tempo word about a person (slowly, slow, gradually, unhurried, deliberately, lingering, for a beat). '
    + 'Keep the camera distance, angle, framing, camera state, outfit and every other person exactly as written. '
    + 'Change NOTHING outside the hook: return the complete prompt, word-for-word identical after the hook, and nothing else — no preamble, no explanation.\n\nPROMPT:\n' + prompt;
}

// Accept a revision only when it is the same prompt with a moving hook: it must name more moves,
// keep the tail (everything from the second timed line) intact, and not have lost [INFLUENCER].
function acceptRevision(before, after, name, m) {
  const a = String(after || '').trim();
  if (!a || a.length < before.length * 0.7 || a.length > before.length * 1.5) return false;
  if (/\[INFLUENCER\]/.test(before) && !/\[INFLUENCER\]/.test(a)) return false;
  const tailOf = (p) => p.slice(hookSegment(p).length).trim();
  const tb = tailOf(before), ta = tailOf(a);
  if (tb && (ta.slice(0, 120) !== tb.slice(0, 120))) return false;
  if (missesMeasured(hookSegment(a), m)) return false;   // the measured leg movement must now be named
  return hookMoves(hookSegment(a), name).length >= HOOK_MIN_MOVES
      && (hookMoves(hookSegment(a), name).length > hookMoves(hookSegment(before), name).length || missesMeasured(hookSegment(before), m));
}


// 👕 GARMENT ON CHEST CLOSE-UPS (v2.56.0, 2026-10-01). Measured on the FIFA takes: every dressed
// take named the jersey in each timed line that framed the chest ("white jersey visible at bottom of
// frame"); the shirtless plain takes had 1-2 timed lines framing "face and upper chest" or the "neck
// tattoo" with NO garment named — and the identity references are shirtless on purpose (the ink),
// so an unnamed chest is filled from them. Trigger-based: only a timed line that frames the chest,
// torso or neck AND names no clothing gets "<NAME> still wears the <top>." after its timestamp.
const CHEST = /\b(?:upper\s+chest|chest|torso|collarbones?|upper\s+body|neck\s+tattoo|face\s+and\s+neck|neck\s+and\s+(?:chest|shoulders))\b/i;
const OTHER_CHEST = /\b(?:her|their)\s+(?:upper\s+)?(?:chest|torso)\b/i;
const CLOTHING = /\b(?:jersey|tee|t-shirt|shirt|hoodie|sweater|sweatshirt|jumper|top|tank|vest|blazer|jacket|coat|collar|kit|outfit|dress|suit|polo|hood|cardigan|blouse|overshirt|sleeves?|neckline)\b/i;
const TIMED_LINE = /^(\s*(?:Shot\s+\d+\s*)?\[\s*\d+(?:\.\d+)?\s*s?\s*[-–]\s*\d+(?:\.\d+)?\s*s?\s*\]\s*)/i;
// The TOP line must agree with the prompt's own outfit sentence. Measured 2026-10-02 (boxing,
// setting override): the writer's TOP said "white adidas jersey black blazer" — the SOURCE's jersey
// mixed into the new outfit — and that got inserted into a close-up line. Every content word of TOP
// must appear in the overall sentence (the first ~700 characters); otherwise nothing is inserted.
function topAgrees(prompt, garment) {
  const head = String(prompt || '').slice(0, 700).toLowerCase();
  const words = garment.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(the|and|with|over|under|plain)$/.test(w));
  return words.length > 0 && words.every(w => head.includes(w));
}
function ensureGarmentOnChest(prompt, top, who = '[INFLUENCER]') {
  const garment = String(top || '').trim().replace(/[.\s]+$/, '');
  if (!garment || /^none$/i.test(garment)) return { text: String(prompt || ''), added: 0 };
  if (!topAgrees(prompt, garment)) return { text: String(prompt || ''), added: 0, disagreed: true };
  let added = 0;
  const text = String(prompt || '').split('\n').map((line) => {
    const m = TIMED_LINE.exec(line);
    if (!m) return line;
    const body = line.slice(m[0].length);
    if (!CHEST.test(body) || OTHER_CHEST.test(body) || CLOTHING.test(body)) return line;
    added++;
    return `${m[0]}${who} still wears the ${garment.replace(/^(?:a|an|the)\s+/i, '')}. ${body}`;
  }).join('\n');
  return { text, added };
}


// 📏 MEASURED HOOK MOTION (v2.59.0, 2026-10-01). hookmotion.py measures, with the camera's move
// removed, how much the head band, the middle and the bottom quarter of the frame move in the hook.
// A band that moves a lot MORE than the head is a movement the writer must name — the FIFA source's
// knees bounce steadily (bottom 1.66 vs head 0.44 px/0.1 s) and no prompt ever had it, because
// frame-to-frame it is a few pixels. Walking moves every band, so it never trips this (calibrated:
// a walk measured 1.78 head / 3.39 bottom = 1.9x). Wording names the band and lets the writer say
// which body part it is — trigger-must-be-the-observer: only the writer sees what is there.
const MOTION_MIN = 1.0, MOTION_RATIO = 2.5;
function motionNote(m) {
  if (!m || !(m.head >= 0)) return '';
  const head = Math.max(m.head, 0.1), out = [];
  if (m.bottom >= MOTION_MIN && m.bottom >= MOTION_RATIO * head)
    out.push(`the BOTTOM quarter of the frame moves ${Math.round(m.bottom / head * 10) / 10}x more than the head — in a seated or standing shot that is [INFLUENCER]'s legs, knees or lap (a knee bouncing, a leg jiggling, the lap and phone moving with it)`);
  if (m.middle >= MOTION_MIN && m.middle >= MOTION_RATIO * head)
    out.push(`the MIDDLE of the frame moves ${Math.round(m.middle / head * 10) / 10}x more than the head — [INFLUENCER]'s hands, arms or torso`);
  return out.length
    ? `MEASURED MOTION in the first ${m.seconds} s (optical flow, the camera's own move removed): ${out.join('; and ')}. This movement is continuous and real even where consecutive frames look almost identical — name it in the hook, which part moves and how, at real-life speed.`
    : '';
}

// The measurement said the legs move; does the hook actually name a leg MOVEMENT? ("the phone
// resting in the lap" names the lap, not a movement, so a body word alone is not enough.)
const LEG_MOVE = /\b(?:knees?|legs?|feet|foot|thighs?)\b[^.;\n]{0,50}\b(?:bounc\w*|jiggl\w*|shift\w*|tap\w*|mov\w*|swing\w*|rock\w*|bob\w*|twitch\w*|fidget\w*)|\b(?:bounc\w*|jiggl\w*|tap\w*|rock\w*|bob\w*)\b[^.;\n]{0,30}\b(?:knees?|legs?|feet|foot|thighs?)\b/i;
function missesMeasured(segment, m) {
  if (!m || !(m.head >= 0)) return false;
  const legsMove = m.bottom >= MOTION_MIN && m.bottom >= MOTION_RATIO * Math.max(m.head, 0.1);
  return legsMove && !LEG_MOVE.test(String(segment || ''));
}


// 👥 THE CROWD KEEPS MOVING (v2.60.0, 2026-10-02, Mike: "People in the background are frozen again").
// Measured: on Seedance the bystanders moved at ~half the source (boxing 0.32, fashion 0.45 vs 0.73)
// when the prompt described them once, in the hook, half of them as a pose. The writer is asked for
// the sentence below whenever people are around; this puts it in when the writer forgot it. Trigger:
// the prompt names another person (a woman, a man, fans, a crowd…). Placed right after the outfit
// sentence, so it is early (late text weighs less on Seedance).
const CROWD_SENTENCE = (who) => `Throughout the whole clip, the people around ${who} keep moving naturally — talking, glancing around, shifting in their seats; nobody is frozen.`;
const PEOPLE_AROUND = /\b(?:woman|women|man|men|girl|boy|people|crowd|fans|(?<!\b(?:ceiling|desk|electric|table|standing|floor|box|exhaust|wall)\s)fan|spectators?|audience|bystanders?|onlookers?|photographers?|guests?|neighbou?rs?)\b/i;
// Said ABSENT is not present: "no other people", "nobody else", "alone" (toolscan F5, 2026-10-02 — a solo
// scene that said "no other people in the room" got "the people around … keep moving", and naming
// people draws them).
const PEOPLE_ABSENT = /\b(?:no\s+(?:other\s+)?(?:people|one|person|crowd|bystanders?|onlookers?)|nobody(?:\s+else)?|no\s*-?\s*one\s+else|(?:completely\s+|totally\s+)?(?:alone|empty|deserted)|by\s+(?:him|her|them)sel(?:f|ves)|on\s+(?:his|her|their)\s+own)\b[^.;\n]{0,40}/gi;
function ensureCrowdMoves(prompt, who = '[INFLUENCER]') {
  const p = String(prompt || '');
  if (!PEOPLE_AROUND.test(p.replace(PEOPLE_ABSENT, ' ')) || /nobody is frozen|keep moving naturally/i.test(p)) return { text: p, added: 0 };
  const m = /wears this same outfit, fully dressed, in every shot\./i.exec(p);
  const at = m ? m.index + m[0].length : (p.indexOf('\n\n') > 0 ? p.indexOf('\n\n') : p.length);
  return { text: p.slice(0, at) + ' ' + CROWD_SENTENCE(who) + p.slice(at), added: 1 };
}


// 🧊 STILLNESS SCRUB (v2.61.0, 2026-10-02, Mike: "Kryfex freezes now the first 2 seconds"). Measured on
// the fashion re-take: his head moved 0.05-0.14 for ~1.2 s (source 0.15-0.45) and the hook said
// "facing directly into the camera … the shoulders stay square" and "eyes hold a direct, unblinking"
// stare — stillness words the model renders literally, and ones the writer's motionless-ban list does
// not name. Deleted from the HOOK only, never when the clause is about the camera or another person;
// the movements the hook names stay. Same discipline as the tempo scrub.
const STILL = [
  [/\b(remains?|stays?)\s+(?:perfectly\s+|completely\s+|totally\s+)?(?:still|motionless|frozen)\b/gi, 'keeps moving naturally'],
  [/\b(sits?|stands?|sitting|standing)\s+(?:perfectly\s+|completely\s+|totally\s+|dead\s+)?(?:still|motionless|frozen)\b/gi, '$1'],
  /(?:,\s*|\s+and\s+|\s+while\s+)?\b(?:(?:the|his|her|their)\s+)?(?:shoulders|head|torso|body|posture|chin|jaw)\s+(?:stay|stays|remain|remains|held|kept|keep|keeps)\s+(?:perfectly\s+|completely\s+)?(?:square|still|rigid|level|fixed|locked|motionless|frozen)\b/gi,
  /\b(?:perfectly|completely|totally|utterly)\s+(?:still|motionless|frozen|rigid)\b/gi,
  /(?:,\s*)?\b(?:unblinking|unmoving|motionless|without\s+blinking|never\s+blinking|does\s+not\s+blink|doesn['’]t\s+blink)\b/gi,
  /\b(?:holds?|holding)\s+(?:dead\s+|perfectly\s+)?still\b/gi,
];
function scrubHookStillness(prompt) {
  const p = String(prompt || '');
  const hook = hookSegment(p);
  const removed = [];
  const parts = hook.split(/((?<=[.!?;])\s+|\s+—\s+|\n+)/);
  const out = parts.map((sent) => {
    if (!sent || !sent.trim()) return sent;
    // Everyone in the hook — the influencer AND the people around ("a man sits perfectly still"
    // fights "nobody is frozen") — but never the camera ("the camera holds perfectly still").
    let t = sent;
    for (const entry of STILL) {
      const [rx, rep] = Array.isArray(entry) ? entry : [entry, ''];
      t = t.replace(new RegExp(rx.source, 'gi'), (...args) => {
        const m = args[0], off = args[args.length - 2], whole = args[args.length - 1];
        const before = whole.slice(Math.max(0, off - 40), off);
        // A hook-first label ("Shot 1 [0-1.2s]") is not the camera: strip it before the camera test, or
        // the label alone protected every stillness word in every hook-first hook (toolscan F4, 2026-10-02).
        if (/\b(?:camera|lens|frame|framing|shot)\b/i.test((before + m).replace(/\bshot\s*\d+\b(?:\s*\[[^\]]*\]?)?/gi, ' '))) return m;
        removed.push(m.trim());
        return rep ? m.replace(new RegExp(rx.source, 'i'), rep) : '';
      });
    }
    return t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/,\s*,/g, ',').replace(/\b(a|an)\s+(?=[,.;])/gi, '');
  }).join('');
  return { text: out + p.slice(hook.length), removed };
}

// ⏱ ONE TIMED-LINE FORMAT (v2.64.0, 2026-10-04). The writer is asked for "[a-bs]" but drifts:
// measured on 12 test prompts, 6 wrote "0s–2s:", "0-3s:" or "0–3.5s]". Every matcher here
// (TIMED_LINE, hookSegment) only reads the bracket form, so on those prompts the top-garment
// insertion saw 0 of 7 lines — and the real G63 take lost its hoodie from ~2 s. Rewritten in code,
// at the start of a line only, and only when there is a dash, a second number, and a closing mark
// ("s", "]" or ":") — a sentence that merely starts with a number is left alone.
const LOOSE_TIMED = /^(\s*)(Shot\s+\d+\s*)?\[?\s*(\d+(?:\.\d+)?)\s*s?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(s(?![a-z])\s*\]?\s*:?|\]\s*:?|:)\s*/i;   // s(?![a-z]): '2-3 seconds later' is prose, not '[2-3s]' + 'econds' (/toolscan 2026-10-09)
function normalizeTimedLines(prompt) {
  let changed = 0;
  const out = String(prompt || '').split('\n').map(line => {
    const m = LOOSE_TIMED.exec(line);
    if (!m) return line;
    const fixed = `${m[1]}${m[2] ? m[2].trim() + ' ' : ''}[${m[3]}-${m[4]}s] `;
    const next = fixed + line.slice(m[0].length);
    if (next !== line) changed++;
    return next;
  }).join('\n');
  return { text: out, changed };
}

module.exports = { normalizeTimedLines, scrubHookStillness, ensureCrowdMoves, motionNote, missesMeasured, ensureGarmentOnChest, HOOK_MIN_MOVES, hookSegment, hookMoves, isPosed, scrubPersonTempo, reviseHookInstruction, acceptRevision };
