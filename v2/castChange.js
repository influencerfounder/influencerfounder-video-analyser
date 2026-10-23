// 🎭 BACKGROUND PEOPLE GET A SMALL CHANGE (Mike, 2026-10-23: "only have the AI influencer exactly as is … the people
// in the background need to change a little bit. So they don't look identical … small changes in the face or hair";
// "and also changes in the face, so it doesn't look like the same person"). Video Quality Lab case 2026-10-23-01.
//
// Picked ONCE, in code, at analysis time and stored on spec.cast[i].change, so the first-frame edit (tool,
// castFrameLine) and the video prompt (compile.js "Also in the video") read the SAME change — a frame that changes the
// hair while the prompt still describes the old hair would pull the original back after a cut.
//
// Guards (Video Quality Lab rules):
// - R7 / P8: the change never moves anyone toward the influencer — it is a small, concrete item from a fixed list, and
//   the frame line says nobody takes a look from the reference images.
// - R14 (naming a thing draws it): one concrete change per person, never "look a bit different".
// - Never contradict the person's own label (R7 labels name hair/beard/age): an option whose subject the label or look
//   already names (beard, glasses, a hat over the hair) is skipped.
// - Only people whose face is clearly visible (writer field face:"clear"); children stay exactly as they are.
'use strict';

const MAX_CHANGED = 4;   // a crowd stays a crowd: the four most visible people at most (writer order = prominence)

const HAIR_HIDDEN = /\b(hat|cap|beanie|hood(?:ie)? up|hooded|helmet|headscarf|hijab|turban|bandana|durag|wig|bald|shaved head)\b/i;
const FACIAL_WORDS = /\b(beard\w*|bearded|stubble|moustache|mustache|goatee|clean[- ]shaven|shaven)\b/i;
const GLASSES_WORDS = /\b(glasses|sunglasses|shades|spectacles|goggles)\b/i;

function low(x) { return String(x == null ? '' : x).toLowerCase().trim(); }

// The options that fit THIS person and do not contradict their label/look. Each is a short phrase that reads after
// "with" in the prompt.
function optionsFor(p, rnd = Math.random) {
  const text = `${p.label || ''} ${p.look || ''}`;
  const sex = low(p.sex), fh = low(p.facial_hair);
  const opts = [];
  if (!HAIR_HIDDEN.test(text)) {
    opts.push({ kind: 'parting', text: 'the hair parted on the other side' });
    // No colour shift (2026-10-23, first take): "one shade lighter" on a dark-haired man came back grey and ~15 years
    // older. A styling change keeps colour and length (Mike: "keep age, baldness and hair length exactly the same").
    opts.push({ kind: 'combed', text: 'the hair combed straight back' });
  }
  if (sex === 'man' && !FACIAL_WORDS.test(text)) {
    if (fh === 'none') opts.push({ kind: 'facial', text: 'light stubble' });
    else if (fh === 'stubble') opts.push({ kind: 'facial', text: 'a clean-shaven face' });
    else if (fh === 'beard') opts.push({ kind: 'facial', text: 'the beard trimmed shorter' });
  }
  // Glasses are an object, not a face or hair change, and an object can drift onto the influencer (reviewer, 2026-10-23):
  // only when nothing else fits.
  if (!opts.length && p.glasses === false && !GLASSES_WORDS.test(text)) opts.push({ kind: 'glasses', text: 'thin clear-framed glasses' });
  return opts;
}

// spec → a NEW spec whose cast members with a clear face carry change: { face: true, text, kind }. `rnd` is injectable
// for the selftest. A spec without cast, or a product-only run, comes back unchanged.
function pickCastChanges(spec, rnd = Math.random) {
  if (!spec || !Array.isArray(spec.cast) || !spec.cast.length) return spec;
  let n = 0;
  const cast = spec.cast.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const { change, ...rest } = p;   // never trust a change the writer made up itself
    if (n >= MAX_CHANGED || low(p.face) !== 'clear' || low(p.sex) === 'child' || !String(p.label || '').trim()) return rest;
    const opts = optionsFor(p, rnd);
    n++;
    const o = opts.length ? opts[Math.floor(rnd() * opts.length) % opts.length] : null;
    return { ...rest, change: { face: true, kind: o ? o.kind : 'face', text: o ? o.text : '' } };
  });
  return { ...spec, cast };
}

// The phrase compile.js appends to a cast member in "Also in the video" ('' when there is nothing describable — a face
// change alone cannot be written for a video model; the first frame carries it).
function castChangeText(p) {
  const c = p && p.change;
  return c && typeof c.text === 'string' ? c.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

module.exports = { pickCastChanges, castChangeText, optionsFor, MAX_CHANGED };
