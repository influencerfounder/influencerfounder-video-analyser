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
const LOOK_WORDS = /\b(look|looks|looking|stare|stares|staring|glance|glances|gaze|gazes|eyes|double-take|watch|watches|watching|gawks?|turns? (round|around|back))\b/i;

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

const REACTIONS_SYSTEM = `You check ONE thing in a short video: where the OTHER people (not MAIN) look, and what their faces do. MAIN is the main person of the video. You get the cast (people already identified, by id) and, for some shots, 4 frames spread over that shot in time order.
STEP 1 — for EVERY cast person you can see in a shot (never skip one), write "facing": one entry per frame, in order, each one of: "away" (back of the head to the camera), "lens" (face turned to the camera, eyes on it), "MAIN" (face turned to MAIN, in a shot with MAIN), "side" (profile, looking elsewhere), "down" (at a phone, a bag, the floor), "not visible".
STEP 2 — "face": what the face does when it is turned to the lens or MAIN (eyebrows raised, mouth open, wide-eyed, smiling, frowning, staring, deadpan), or "" if it never is.
STEP 3 — "events": that person's actions in the shot, at most 4 short present-tense items, in the order the frames show:
- A look is an action: "turns round and stares at MAIN, eyebrows raised", "stares into the camera while walking toward it, mouth open", "looks back over the shoulder straight into the camera".
- In a shot WITHOUT MAIN the camera stands where MAIN is: someone looking toward the lens there is looking at MAIN — write it as "into the camera", never "MAIN".
- "away" in one frame and "lens" in a later one = the person TURNED ROUND to look: say so ("stops, turns round and stares back into the camera").
- A reaction the shot is built on comes first; fold a walk into it ("stares into the camera while walking past"), but keep real time order: a look that only comes at the end stays last.
- Keep every other action they really do (walking, carrying, phone).
- Write the face as it is: an ordinary glance is "glances at …"; no "lens"/"MAIN" in facing = no look in events.
- Never "neutral", never an invented stare, never a person who is not in the cast list, never MAIN's actions.
Return ONLY JSON: {"shots":[{"start":<shot start exactly as given>,"people":[{"id":"P1","facing":["away","away","lens","lens"],"face":"","events":["…"]}]}]}.`;

/** Pure: one event cleaned — "neutral (expression)" dropped, and in a cutaway a look at MAIN becomes a look into the
 *  camera (the camera stands where MAIN is). Returns '' when nothing is left. */
function repairEvent(e, cutaway) {
  let x = e.replace(/\s+/g, ' ').trim();
  x = x.replace(/,?\s*(with\s+)?(an?\s+)?neutral(\s+(expression|face|look))?/gi, '').replace(/\s+,/g, ',').replace(/,\s*$/, '').trim();
  if (cutaway) {
    x = x.replace(/\b(back at|at|toward|towards)\s+MAIN\b/g, (m, p) => (/back/i.test(p) ? 'back into the camera' : 'into the camera'))
      .replace(/\bMAIN's\s+direction\b/g, 'the camera');
  }
  return x.slice(0, 160);
}

/** Pure: merge the pass's answer into the spec. Only shots that were asked, only cast ids, MAIN never named in a shot
 *  without MAIN, at most 4 events of ≤160 chars. A person not yet listed in that shot is added only if in the cast.
 *  Returns { spec, changed: [{start,id,events}] }. */
function mergeReactions(spec, answer, askedIdx) {
  const out = JSON.parse(JSON.stringify(spec));
  const castIds = new Set((out.cast || []).map((c) => c && c.id).filter(Boolean));
  const rows = (answer && Array.isArray(answer.shots)) ? answer.shots : [];
  const changed = [], refused = [];
  for (const i of askedIdx) {
    const s = out.shots[i];
    if (!s) continue;
    const row = rows.find((r) => r && Math.abs(Number(r.start) - Number(s.start)) < 0.05);
    const people = row && (Array.isArray(row.people) ? row.people : Array.isArray(row.others) ? row.others : null);
    if (!people) continue;
    for (const o of people) {
      if (!o || !Array.isArray(o.events)) continue;
      if (!castIds.has(o.id)) { refused.push({ start: s.start, id: String(o.id || '').slice(0, 8), why: 'not in the cast', events: [] }); continue; }
      // 2.105.2: REPAIR rather than refuse (test run rj_mwltw0jnwro9: 8 shots asked, 1 rewritten — a stare toward
      // MAIN in a cutaway, or a "neutral" tacked on, threw away a look the frames plainly showed).
      const ev = o.events.map((e) => repairEvent(String(e || ''), s.main_visible === false)).filter(Boolean).slice(0, 4);
      if (!ev.length || !ev.some((e) => LOOK_WORDS.test(e))) { refused.push({ start: s.start, id: o.id, why: 'no look' + (Array.isArray(o.facing) ? ' (facing ' + o.facing.slice(0, 4).join(',') + ')' : ''), events: o.events.slice(0, 4).map((e) => String(e).slice(0, 160)) }); continue; }
      if (s.main_visible === false && ev.some((e) => /\bMAIN\b/.test(e))) { refused.push({ start: s.start, id: o.id, why: 'MAIN in a cutaway', events: ev }); continue; }
      if (!Array.isArray(s.others)) s.others = [];
      const have = s.others.find((x) => x && x.id === o.id);
      if (have) have.events = ev; else s.others.push({ id: o.id, events: ev });
      changed.push({ start: s.start, id: o.id, events: ev });
    }
  }
  return { spec: out, changed, refused };
}

/** Run the pass. deps: { callWriter, parseSpec, validateSpec, frameAt, ff, video, tmp, path } */
async function reactionsPass({ spec, duration, key, kieKey, deadline, deps }) {
  const idx = pickReactionShots(spec);
  if (!idx.length) return { spec, changed: [], asked: 0 };
  if (deadline && deadline - Date.now() < 130000) return { spec, changed: [], asked: idx.length, error: 'no time left' };
  const { callWriter, parseSpec, validateSpec, frameAt, ff, video, tmp, path } = deps;
  const shots = spec.shots;
  let images = 0;
  const content = [{ type: 'text', text: `CAST: ${JSON.stringify((spec.cast || []).map((c) => ({ id: c.id, label: c.label, look: c.look })))}\nOVERLAY TEXT: ${String(spec.overlay_text || '') || 'none'}` }];
  for (const i of idx) {
    const s = shots[i];
    const end = i + 1 < shots.length ? Number(shots[i + 1].start) : duration;
    const ts = reactionFrameTimes(Number(s.start), end);
    content.push({ type: 'text', text: `SHOT start ${s.start} s (to ${Math.round(end * 100) / 100} s), MAIN ${s.main_visible === false ? 'NOT in this shot' : 'in this shot'}. People the first analyst listed here: ${(s.others || []).map((o) => o && o.id).filter(Boolean).join(', ') || 'none'} (others from the cast may be there too). Frames at ${ts.join(', ')} s:` });
    for (const t of ts) {
      if (deadline && deadline - Date.now() < 100000) return { spec, changed: [], asked: idx.length, error: 'no time left' };
      const b = await frameAt(ff, video, t, 640, path.join(tmp, `react-${i}-${t}.jpg`));
      if (b) images++;
      if (b) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } });
    }
  }
  content.push({ type: 'text', text: 'Return only JSON.' });
  // 60 s kept back for the outfit pick and the openings, like the second-opinion judge (reviewer 2026-11-18).
  const w = await callWriter({ system: REACTIONS_SYSTEM, content, key, kieKey, deadline: deadline ? deadline - 60000 : 0, maxTokens: 2500 });
  const raw = String(w.text || '').replace(/\s+/g, ' ').slice(0, 1500);
  const j = parseSpec(w.text);
  if (!j) return { spec, changed: [], asked: idx.length, images, raw, error: 'no JSON' };
  const m = mergeReactions(spec, j, idx);
  if (validateSpec(m.spec).length) return { spec, changed: [], asked: idx.length, error: 'merged spec invalid' };
  return { spec: m.spec, changed: m.changed, refused: m.refused, asked: idx.length, images, raw, usage: w.usage };
}

module.exports = { repairEvent, pickReactionShots, reactionFrameTimes, mergeReactions, reactionsPass, REACTIONS_SYSTEM, REACTION_OVERLAY };
