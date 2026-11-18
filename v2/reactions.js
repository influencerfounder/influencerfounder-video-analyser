// 👀 REACTIONS PASS (2.105.0 / v2-1.16.0, Video Quality Lab case 2026-11-17-05).
// Rule 10b (2.104.0) asks the writer where other people look, but the writer reads 240-px contact-sheet cells and two
// frames per shot: on Leilaa's mall source ("People's reactions to this blue outfit") it caught 2 of 5 reactions — a
// 1.2 s turn-round fell between frames and two stares into the lens were written as "neutral". This pass looks ONLY at
// the shots where a reaction can be the point — cutaways to other people (a shot without MAIN that shows someone), and
// every shot with people when the overlay announces reactions — with 4 larger frames per shot, and rewrites only the
// events of people already in the cast. No such shot = no call (0 cost, spec unchanged). Fails open: the writer's
// spec stays as it was.
const REACTION_OVERLAY = /\breact|\bpeople'?s\s+(faces?|eyes)|\beveryone\b.{0,30}\b(look|star|stop)|\bheads?\s+turn|\bstar(e|ing)\b|\bjaw/i;
const MAX_SHOTS = 8;
const FRAMES_PER_SHOT = 4;
const LOOK_WORDS = /\b(look|looks|looking|stare|stares|staring|glance|glances|gaze|gazes|eyes|double-take|neutral|expression|turns? (round|around|back))\b/i;

/** Pure: which shot indexes to check. Shots with people in them that are cutaways (no MAIN), or every shot with
 *  people when the overlay text announces reactions. */
function pickReactionShots(spec) {
  const shots = (spec && Array.isArray(spec.shots)) ? spec.shots : [];
  const cast = (spec && Array.isArray(spec.cast)) ? spec.cast : [];
  if (!cast.length) return [];
  const announced = REACTION_OVERLAY.test(String((spec && spec.overlay_text) || ''));
  const out = [];
  shots.forEach((s, i) => {
    const hasOthers = Array.isArray(s.others) && s.others.some((o) => o && o.id);
    if (s.main_visible === false ? (hasOthers || announced) : (announced && hasOthers)) out.push(i);
  });
  return out.slice(0, MAX_SHOTS);
}

/** Pure: frame times inside one shot window (10/37/63/90 %). */
function reactionFrameTimes(start, end) {
  const d = Math.max(0.1, end - start);
  return [0.1, 0.37, 0.63, 0.9].slice(0, FRAMES_PER_SHOT).map((f) => Math.round((start + d * f) * 100) / 100);
}

const REACTIONS_SYSTEM = `You check ONE thing in a short video: where the OTHER people (not MAIN) look, and what their faces do. MAIN is the main person of the video. You get the cast (people already identified, by id), and for some shots their current events plus 4 frames spread over that shot, in time order.
For each person in a shot, compare the frames one by one and decide: do they look at MAIN, or (in a shot WITHOUT MAIN) into the lens / toward one screen side? When? What does the face do (eyebrows raised, mouth open, wide-eyed, smiling, frowning, deadpan)? Do they stop, turn round, look back over the shoulder, do a double-take, touch the face?
Then rewrite that person's events for that shot (at most 4 short present-tense items, in the order the frames show):
- A look is an action: "turns round and stares at MAIN, eyebrows raised", "stares into the camera while walking toward it, mouth open", "looks back over the shoulder straight into the camera".
- In a shot WITHOUT MAIN never write "MAIN" — write the look as into the camera or toward screen-left/right.
- A reaction the shot is built on comes first; fold a walk into it ("stares into the camera while walking past"), but keep real time order: a look that only comes at the end stays last.
- Keep every other action they really do (walking, carrying, phone).
- Write the face as it is: an ordinary glance is "glances at …"; a person who never looks gets NO look — then leave them out of your answer.
- Never "neutral", never an invented stare, never a person who is not in the cast list, never MAIN's actions.
Return ONLY JSON: {"shots":[{"start":<shot start exactly as given>,"others":[{"id":"P1","events":["…"]}]}]} — only the people whose look you saw; an empty list is a fine answer.`;

/** Pure: merge the pass's answer into the spec. Only shots that were asked, only cast ids, MAIN never named in a shot
 *  without MAIN, at most 4 events of ≤160 chars. A person not yet listed in that shot is added only if in the cast.
 *  Returns { spec, changed: [{start,id,events}] }. */
function mergeReactions(spec, answer, askedIdx) {
  const out = JSON.parse(JSON.stringify(spec));
  const castIds = new Set((out.cast || []).map((c) => c && c.id).filter(Boolean));
  const rows = (answer && Array.isArray(answer.shots)) ? answer.shots : [];
  const changed = [];
  for (const i of askedIdx) {
    const s = out.shots[i];
    if (!s) continue;
    const row = rows.find((r) => r && Math.abs(Number(r.start) - Number(s.start)) < 0.05);
    if (!row || !Array.isArray(row.others)) continue;
    for (const o of row.others) {
      if (!o || !castIds.has(o.id) || !Array.isArray(o.events)) continue;
      const ev = o.events.map((e) => String(e || '').replace(/\s+/g, ' ').trim().slice(0, 160)).filter(Boolean).slice(0, 4);
      if (!ev.length || !ev.some((e) => LOOK_WORDS.test(e))) continue;            // the pass exists for looks; nothing else
      if (ev.some((e) => /\bneutral\b/i.test(e))) continue;
      if (s.main_visible === false && ev.some((e) => /\bMAIN\b/.test(e))) continue; // would pull MAIN into the cutaway
      if (!Array.isArray(s.others)) s.others = [];
      const have = s.others.find((x) => x && x.id === o.id);
      if (have) have.events = ev; else s.others.push({ id: o.id, events: ev });
      changed.push({ start: s.start, id: o.id, events: ev });
    }
  }
  return { spec: out, changed };
}

/** Run the pass. deps: { callWriter, parseSpec, validateSpec, frameAt, ff, video, tmp, path } */
async function reactionsPass({ spec, duration, key, kieKey, deadline, deps }) {
  const idx = pickReactionShots(spec);
  if (!idx.length) return { spec, changed: [], asked: 0 };
  if (deadline && deadline - Date.now() < 70000) return { spec, changed: [], asked: idx.length, error: 'no time left' };
  const { callWriter, parseSpec, validateSpec, frameAt, ff, video, tmp, path } = deps;
  const shots = spec.shots;
  const content = [{ type: 'text', text: `CAST: ${JSON.stringify((spec.cast || []).map((c) => ({ id: c.id, label: c.label, look: c.look })))}\nOVERLAY TEXT: ${String(spec.overlay_text || '') || 'none'}` }];
  for (const i of idx) {
    const s = shots[i];
    const end = i + 1 < shots.length ? Number(shots[i + 1].start) : duration;
    const ts = reactionFrameTimes(Number(s.start), end);
    content.push({ type: 'text', text: `SHOT start ${s.start} s (to ${Math.round(end * 100) / 100} s), MAIN ${s.main_visible === false ? 'NOT in this shot' : 'in this shot'}. Current events of others: ${JSON.stringify(s.others || [])}. Frames at ${ts.join(', ')} s:` });
    for (const t of ts) {
      const b = await frameAt(ff, video, t, 640, path.join(tmp, `react-${i}-${t}.jpg`));
      if (b) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } });
    }
  }
  content.push({ type: 'text', text: 'Return only JSON.' });
  const w = await callWriter({ system: REACTIONS_SYSTEM, content, key, kieKey, deadline, maxTokens: 1500 });
  const j = parseSpec(w.text);
  if (!j) return { spec, changed: [], asked: idx.length, error: 'no JSON' };
  const m = mergeReactions(spec, j, idx);
  if (validateSpec(m.spec).length) return { spec, changed: [], asked: idx.length, error: 'merged spec invalid' };
  return { spec: m.spec, changed: m.changed, asked: idx.length, usage: w.usage };
}

module.exports = { pickReactionShots, reactionFrameTimes, mergeReactions, reactionsPass, REACTIONS_SYSTEM, REACTION_OVERLAY };
