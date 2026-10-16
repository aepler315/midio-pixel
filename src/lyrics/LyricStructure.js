// Turns raw lyric lines (synced or plain) into labeled structural blocks --
// verse/chorus/bridge/instrumental/intro/outro -- plus a per-block
// valence/intensity read from a small bundled emotion lexicon. Pure,
// deterministic, no LLM: repetition is detected with Jaccard similarity
// over normalized lines, syllables are counted with the classic
// vowel-group heuristic, emotion is a lexicon average. Every function here
// is DOM-free and unit-tested directly.
import { clamp01 } from '../utils/math.js';

/** Lowercase, strip punctuation (keep in-word apostrophes), collapse
 *  whitespace. The shared normal form used for both repetition matching
 *  and lexicon lookup. */
export function normalizeLine(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VOWEL_GROUP_RE = /[aeiouy]+/g;

/** Classic vowel-group syllable estimate for one word: count runs of
 *  vowels, drop a silent trailing "e" (but not "le" after a consonant,
 *  e.g. "little"), floor of 1. Good enough for pacing/emphasis, not
 *  meant to be phonetically exact. */
function wordSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  let groups = (w.match(VOWEL_GROUP_RE) || []).length;
  if (w.length > 2 && w.endsWith('e') && !/le$/.test(w)) groups -= 1;
  else if (/[^aeiouy]le$/.test(w)) groups += 0; // "le" after a consonant already counted as its own group
  return Math.max(1, groups);
}

/** Syllable count for a whole line (sum over its words). Pure string math. */
export function syllableCount(text) {
  const words = normalizeLine(text).split(' ').filter(Boolean);
  let total = 0;
  for (const w of words) total += wordSyllables(w);
  return total;
}

// A gap this long between consecutive synced lines starts a new block --
// either a phrase-per-phrase quick block (the fixed floor) or, on a slower
// song, a multiple of its own typical line gap. MUL was 4, which (at a
// typical ~3s median line gap) demanded a ~12s silence to ever split a
// block -- real verses/choruses essentially never pause that long
// mid-section, so a whole song routinely collapsed into one or two blocks.
const BLOCK_GAP_FLOOR_MS = 2500;
const BLOCK_GAP_MEDIAN_MUL = 2;
const INSTRUMENTAL_GAP_MS = 12000;
const EDGE_SILENCE_MS = 8000; // an intro/outro must be at least this long to earn its own label
// A block spanning longer than this is a whole song-section's worth of
// lyrics glued together (e.g. one long verse-into-chorus run with no gap
// wide enough to trip the threshold above) -- split it at its own largest
// internal gap, recursively, rather than let one block swallow a third of
// the song.
const MAX_BLOCK_DURATION_MS = 40000;
// Longest duration credited to a block's final line. The estimate comes from
// the surrounding line pacing, which on a sparse or irregular block can be
// wildly high (three lines at 0s/2s/30s have a 15s median gap) -- and a sung
// line does not last fifteen seconds. Past this it is silence, and silence is
// labelBlocks' job to name, not this block's to absorb.
const LAST_LINE_MAX_MS = 8000;

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A block's span for capping purposes is onset-to-onset PLUS the final
 *  line's own estimated duration (its own median internal gap, capped at
 *  `LAST_LINE_MAX_MS`) -- otherwise a block whose last line starts right at
 *  the nominal cap still runs an extra several seconds past it once that
 *  line's sung duration is counted, exactly the "42 seconds despite a
 *  40-second cap" failure the cap exists to prevent. */
function estimatedSpan(lines) {
  if (lines.length <= 1) return 0;
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].tMs - lines[i - 1].tMs);
  const tail = Math.min(median(gaps.filter((g) => g > 0)) || 0, LAST_LINE_MAX_MS);
  return lines[lines.length - 1].tMs - lines[0].tMs + tail;
}

/** Recursively splits a run of synced lines at its own largest internal gap
 *  until every resulting piece spans no more than `capMs` (or can't be
 *  split further -- a single line always spans 0). Pure.
 *
 *  When several gaps tie for largest -- the common case for machine-timed
 *  or otherwise uniformly-paced lyrics -- the split closest to the middle
 *  wins, so a run of N equally-spaced lines bisects into two balanced
 *  halves instead of always cutting off the first line: repeatedly taking
 *  the first tied gap turned 20 evenly-spaced lines into six single-line
 *  blocks followed by one oversized 14-line block. */
function splitOversizedBlock(lines, capMs) {
  if (lines.length <= 1) return [lines];
  if (estimatedSpan(lines) <= capMs) return [lines];
  const mid = lines.length / 2;
  let bestIdx = 1, bestGap = -1;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].tMs - lines[i - 1].tMs;
    if (gap > bestGap + 1e-9
      || (Math.abs(gap - bestGap) <= 1e-9 && Math.abs(i - mid) < Math.abs(bestIdx - mid))) {
      bestGap = gap; bestIdx = i;
    }
  }
  const left = lines.slice(0, bestIdx);
  const right = lines.slice(bestIdx);
  return [...splitOversizedBlock(left, capMs), ...splitOversizedBlock(right, capMs)];
}

/** Groups lyric lines into blocks (paragraphs). `lines` is either a synced
 *  array [{tMs,text}] or a plain array of strings (blank strings act as
 *  paragraph breaks, matching how LRCLIB's plainLyrics blank-separates
 *  verses). Synced blocks carry {startMs,endMs}; plain blocks don't. */
export function toBlocks(lines, { synced = false } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return [];

  if (synced) {
    // Alternate producers (including cached records) need the same admission
    // policy as LRC. Keep distinct simultaneous voices, dedup exact pairs.
    const seen = new Set();
    const sorted = lines.filter((line) => {
      if (!Number.isFinite(line?.tMs) || line.tMs < 0) return false;
      const key = JSON.stringify([line.tMs, line.text]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.tMs - b.tMs);
    if (!sorted.length) return [];
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].tMs - sorted[i - 1].tMs);
    const threshold = Math.max(BLOCK_GAP_FLOOR_MS, BLOCK_GAP_MEDIAN_MUL * median(gaps.filter((g) => g > 0)));
    const blocks = [];
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].tMs - sorted[i - 1].tMs;
      if (gap > threshold) {
        blocks.push(current);
        current = [];
      }
      current.push(sorted[i]);
    }
    if (current.length) blocks.push(current);
    const capped = blocks.flatMap((b) => splitOversizedBlock(b, MAX_BLOCK_DURATION_MS));
    // A line's timestamp is when it STARTS being sung, so a block that ends
    // at its last line's timestamp ends where that line begins -- the line
    // itself gets no duration at all. For a multi-line block that only
    // clipped the tail; for a SINGLE-line block (a one-line hook, a spoken
    // intro, a final line -- all common) it made startMs === endMs, and
    // SectionFusion's sectionAt matches on `t >= startMs && t < endMs`, so
    // such a block could never match anything. Its kind, intensity and
    // valence were computed and then silently unreachable.
    //
    // So give the last line a duration: the block's own median line gap
    // (how long its other lines each lasted), or the song's median when the
    // block has only one line. Capped by the real gap to whatever comes
    // next, so a block can never swallow the instrumental silence after it
    // -- labelBlocks still sees that gap and still fills it.
    const songMedianGap = median(gaps.filter((g) => g > 0)) || BLOCK_GAP_FLOOR_MS;
    return capped.map((lns) => {
      const startMs = lns[0].tMs;
      const lastMs = lns[lns.length - 1].tMs;
      const inner = [];
      for (let i = 1; i < lns.length; i++) inner.push(lns[i].tMs - lns[i - 1].tMs);
      const own = median(inner.filter((g) => g > 0)) || songMedianGap;
      const nextLine = sorted.find((l) => l.tMs > lastMs);
      const room = nextLine ? nextLine.tMs - lastMs : own;
      return {
        lines: lns.map((l) => l.text),
        startMs,
        endMs: lastMs + Math.max(1, Math.min(own, room, LAST_LINE_MAX_MS)),
      };
    });
  }

  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line || !line.trim()) {
      if (current.length) { blocks.push({ lines: current }); current = []; }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push({ lines: current });
  return blocks;
}

function jaccardLines(aLines, bLines) {
  const setA = new Set(aLines.map(normalizeLine).filter(Boolean));
  const setB = new Set(bLines.map(normalizeLine).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const l of setA) if (setB.has(l)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

const REPEAT_SIMILARITY_THRESHOLD = 0.7;
const BRIDGE_SPAN = [0.55, 0.90];

// A leading "[Chorus]", "(Verse 2):" etc. is a reliable explicit label when
// a lyric source provides one -- far better evidence of function than
// recurrence or position alone, and the only way a repeated block can be
// correctly kept as e.g. a repeated VERSE instead of being forced to CHORUS
// by the recurrence heuristic below.
const EXPLICIT_TAG_RE = /^\s*[[(]\s*(verse|chorus|bridge|intro|outro|instrumental)\s*\d*\s*[\])]\s*:?\s*/i;

function explicitTag(lines) {
  if (!lines || !lines.length) return null;
  const m = EXPLICIT_TAG_RE.exec(lines[0]);
  return m ? m[1].toLowerCase() : null;
}

/** Strips a leading explicit tag off a block's first line (if present) so it
 *  never leaks into repetition matching, emotion lexicon lookup, or the
 *  displayed text. */
function stripTag(lines) {
  if (!lines || !lines.length) return lines;
  const m = EXPLICIT_TAG_RE.exec(lines[0]);
  if (!m) return lines;
  const rest = lines[0].slice(m[0].length);
  return rest ? [rest, ...lines.slice(1)] : lines.slice(1);
}

// Confidence in the FUNCTION label (kind), separate from `confidence`, which
// is about boundary/alignment timing. An explicit tag is direct evidence; a
// recurrence-based chorus call or a position-based bridge call is only a
// hypothesis, and callers that turn a kind into a dramatic effect (forced
// hue swings, epic-bias escalation) should scale that effect by this number
// rather than treating every kind label as equally certain.
const KIND_CONFIDENCE = {
  explicit: 0.9, repeatChorus: 0.55, positionBridge: 0.35, defaultVerse: 0.5,
};

/** Normalize timed spans without inventing a recording duration. Clip only
 *  spans intersecting the song, omit nonnumeric/empty/backward/late spans,
 *  sort starts, keep the first duplicate start, and end overlapping spans
 *  at the next onset. Valid input keeps its array and object identities. */
export function normalizeTimedSections(sections, durationMs = null) {
  if (!Array.isArray(sections)) return [];
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) return [];
  const limit = durationMs ?? Infinity;
  const sorted = sections.filter((s) => Number.isFinite(s?.startMs) && Number.isFinite(s.endMs)
    && s.startMs < s.endMs && s.endMs > 0 && s.startMs < limit)
    .map((s) => {
      const startMs = Math.max(0, s.startMs), endMs = Math.min(limit, s.endMs);
      return startMs === s.startMs && endMs === s.endMs ? s : { ...s, startMs, endMs };
    }).sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const section of sorted) {
    const previous = out.at(-1);
    if (previous?.startMs === section.startMs) continue;
    if (previous && previous.endMs > section.startMs) {
      out[out.length - 1] = { ...previous, endMs: section.startMs };
    }
    out.push(section);
  }
  return out.length === sections.length && out.every((s, i) => s === sections[i]) ? sections : out;
}

/** Clusters blocks into repetition families (Jaccard >= threshold joins the
 *  first matching family; kept as `familyId`/`occurrenceIndex`, separate
 *  from the structural kind below) and assigns a structural kind: an
 *  explicit tag wins outright; otherwise a family that recurs (>=2 members)
 *  is a CHORUS hypothesis, a one-off block sitting in the back 55-90% of the
 *  song is a BRIDGE hypothesis, and everything else is a VERSE. Synced
 *  blocks additionally get INSTRUMENTAL entries inserted into gaps >=12s
 *  and INTRO/OUTRO entries for long lead-in/lead-out silence (needs
 *  `durationMs` for the outro check; omit it to skip outro detection).
 *  Returns lyricSections: [{startMs?,endMs?,kind,kindConfidence,familyId,
 *  occurrenceIndex,intensity,valence,confidence,text}]. */
export function labelBlocks(blocks, { durationMs = null } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const synced = blocks.some((b) => b?.startMs !== undefined || b?.endMs !== undefined);
  if (synced) blocks = normalizeTimedSections(blocks, durationMs);
  if (blocks.length === 0) return [];

  const tags = blocks.map((b) => explicitTag(b.lines));
  const cleanLines = blocks.map((b, i) => (tags[i] ? stripTag(b.lines) : b.lines));

  // Repetition clustering, on tag-stripped text so a shared tag alone never
  // counts as shared content.
  const families = []; // [{ repLines, indices: [] }]
  const familyOf = new Array(blocks.length).fill(-1);
  blocks.forEach((b, i) => {
    let joined = -1;
    for (let f = 0; f < families.length; f++) {
      if (jaccardLines(cleanLines[i], families[f].repLines) >= REPEAT_SIMILARITY_THRESHOLD) { joined = f; break; }
    }
    if (joined === -1) { families.push({ repLines: cleanLines[i], indices: [i] }); familyOf[i] = families.length - 1; }
    else { families[joined].indices.push(i); familyOf[i] = joined; }
  });

  const sections = blocks.map((b, i) => {
    const fam = families[familyOf[i]];
    const isRepeat = fam.indices.length >= 2;
    const posFrac = synced && durationMs
      ? clamp01(((b.startMs + b.endMs) / 2) / durationMs)
      : (blocks.length > 1 ? i / (blocks.length - 1) : 0.5);

    let kind, kindConfidence;
    if (tags[i]) { kind = tags[i]; kindConfidence = KIND_CONFIDENCE.explicit; }
    else if (isRepeat) { kind = 'chorus'; kindConfidence = KIND_CONFIDENCE.repeatChorus; }
    else if (posFrac >= BRIDGE_SPAN[0] && posFrac <= BRIDGE_SPAN[1]) { kind = 'bridge'; kindConfidence = KIND_CONFIDENCE.positionBridge; }
    else { kind = 'verse'; kindConfidence = KIND_CONFIDENCE.defaultVerse; }

    const text = cleanLines[i].join('\n');
    const emo = sectionEmotion(text);
    return {
      startMs: synced ? b.startMs : undefined,
      endMs: synced ? b.endMs : undefined,
      kind,
      kindConfidence,
      familyId: familyOf[i],
      occurrenceIndex: fam.indices.indexOf(i),
      intensity: emo.intensity,
      valence: emo.valence,
      confidence: synced ? 0.8 : 0.4,
      text,
    };
  });

  if (!synced) return sections;

  // Instrumental gaps + intro/outro, synced only. These are directly
  // detected from silence, not inferred from ambiguous evidence, so their
  // kindConfidence matches their timing confidence.
  const out = [];
  if (sections[0].startMs >= EDGE_SILENCE_MS) {
    out.push({
      startMs: 0, endMs: sections[0].startMs, kind: 'intro', kindConfidence: 0.6,
      familyId: null, occurrenceIndex: null, intensity: 0.3, valence: 0, confidence: 0.6, text: '',
    });
  }
  for (let i = 0; i < sections.length; i++) {
    out.push(sections[i]);
    if (i < sections.length - 1) {
      const gap = sections[i + 1].startMs - sections[i].endMs;
      if (gap >= INSTRUMENTAL_GAP_MS) {
        out.push({
          startMs: sections[i].endMs, endMs: sections[i + 1].startMs, kind: 'instrumental', kindConfidence: 0.7,
          familyId: null, occurrenceIndex: null, intensity: 0.7, valence: 0, confidence: 0.7, text: '',
        });
      }
    }
  }
  if (durationMs && durationMs - sections[sections.length - 1].endMs >= EDGE_SILENCE_MS) {
    out.push({
      startMs: sections[sections.length - 1].endMs, endMs: durationMs, kind: 'outro', kindConfidence: 0.6,
      familyId: null, occurrenceIndex: null, intensity: 0.3, valence: 0, confidence: 0.6, text: '',
    });
  }
  return out;
}

// A compact valence/arousal lexicon -- not exhaustive, just enough
// vocabulary to swing an average toward "this text reads epic/dark/happy."
// {word: [valence -1..1, arousal 0..1]}
const LEXICON = {
  love: [0.8, 0.6], loved: [0.8, 0.6], loving: [0.8, 0.5], heart: [0.5, 0.5],
  joy: [0.9, 0.7], happy: [0.85, 0.6], smile: [0.7, 0.4], sunshine: [0.8, 0.4],
  hope: [0.7, 0.5], dream: [0.6, 0.4], dreams: [0.6, 0.4], free: [0.6, 0.5], freedom: [0.7, 0.6],
  dance: [0.6, 0.7], sing: [0.5, 0.5], shine: [0.6, 0.5], bright: [0.6, 0.4], beautiful: [0.7, 0.4],
  friend: [0.6, 0.3], together: [0.6, 0.4], home: [0.5, 0.3], peace: [0.6, 0.2], calm: [0.4, 0.15],
  hate: [-0.8, 0.7], pain: [-0.7, 0.6], cry: [-0.6, 0.5], crying: [-0.6, 0.5], tears: [-0.6, 0.4],
  broken: [-0.7, 0.6], alone: [-0.6, 0.4], lonely: [-0.7, 0.4], lost: [-0.5, 0.5], die: [-0.8, 0.7],
  death: [-0.8, 0.6], dead: [-0.7, 0.5], kill: [-0.8, 0.85], scream: [-0.5, 0.9], screaming: [-0.5, 0.9],
  fear: [-0.6, 0.7], afraid: [-0.6, 0.6], darkness: [-0.5, 0.5], dark: [-0.4, 0.4], shadow: [-0.3, 0.4],
  fire: [-0.1, 0.8], burn: [-0.2, 0.8], burning: [-0.2, 0.8], blood: [-0.4, 0.7], rage: [-0.5, 0.9],
  anger: [-0.6, 0.75], angry: [-0.6, 0.75], fight: [-0.3, 0.8], fighting: [-0.3, 0.8], war: [-0.6, 0.8],
  battle: [-0.2, 0.85], destroy: [-0.5, 0.8], destruction: [-0.5, 0.8], power: [0.1, 0.8], powerful: [0.3, 0.8],
  storm: [-0.2, 0.75], thunder: [0, 0.8], lightning: [0.1, 0.85], sky: [0.3, 0.3], stars: [0.5, 0.35],
  rise: [0.4, 0.7], rising: [0.4, 0.7], fall: [-0.3, 0.5], falling: [-0.3, 0.5], falling_apart: [-0.6, 0.6],
  never: [-0.1, 0.3], forever: [0.3, 0.4], always: [0.2, 0.3], again: [0, 0.2], again_and_again: [0, 0.4],
  glory: [0.6, 0.8], legend: [0.5, 0.7], legendary: [0.5, 0.7], epic: [0.5, 0.85], victory: [0.7, 0.8],
  triumph: [0.7, 0.8], king: [0.3, 0.6], queen: [0.3, 0.6], throne: [0.2, 0.6], crown: [0.3, 0.5],
  soul: [0.2, 0.4], spirit: [0.3, 0.4], eternal: [0.3, 0.5], infinite: [0.3, 0.55], endless: [0.1, 0.5],
  wild: [0.2, 0.75], run: [0.1, 0.7], running: [0.1, 0.7], fly: [0.5, 0.6], flying: [0.5, 0.6],
  scared: [-0.6, 0.65], nightmare: [-0.7, 0.7], monster: [-0.5, 0.7], demon: [-0.5, 0.7], hell: [-0.6, 0.65],
  heaven: [0.6, 0.4], angel: [0.6, 0.4], light: [0.5, 0.35], sun: [0.6, 0.35], moon: [0.3, 0.25],
  goodbye: [-0.4, 0.4], leave: [-0.3, 0.4], leaving: [-0.3, 0.4], gone: [-0.5, 0.35], return: [0.2, 0.4],
  strength: [0.4, 0.6], strong: [0.4, 0.55], weak: [-0.4, 0.3], weakness: [-0.4, 0.3], tired: [-0.3, 0.2],
};

function stem(word) {
  return word.replace(/(ing|ed|es|s)$/i, '');
}

/** Averages the bundled lexicon over a block's normalized words, returning
 *  {valence: -1..1, intensity: 0..1}. Unmatched words are simply ignored;
 *  a block with no lexicon hits reads as neutral (valence 0, a moderate
 *  default intensity so an unrecognized section doesn't read as dead
 *  silence). */
export function sectionEmotion(text) {
  const words = normalizeLine(text).split(' ').filter(Boolean);
  let vSum = 0, aSum = 0, hits = 0;
  for (const w of words) {
    const entry = LEXICON[w] || LEXICON[stem(w)];
    if (entry) { vSum += entry[0]; aSum += entry[1]; hits++; }
  }
  if (hits === 0) return { valence: 0, intensity: 0.4 };
  return { valence: clamp01((vSum / hits + 1) / 2) * 2 - 1, intensity: clamp01(aSum / hits) };
}
