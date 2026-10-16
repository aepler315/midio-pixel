// Maps lyric keywords to constellation glyph IDs. Each entry carries a
// priority (higher = rarer, more special — easter eggs outrank common
// symbols) and a list of trigger words. scanLine returns the highest-
// priority match found in a normalized lyric line, or null.
//
// The design constraint: subtlety. A false positive (drawing a pot leaf
// when the song says "high hopes") is worse than a missed true positive.
// Keywords are chosen conservatively — only words that unambiguously
// reference the concept in a song-lyric context.
//
// COMBOS (below ENTRIES) catch a line naming TWO related concepts at once
// — "a ship over waves," "a heart with a fracture" — and point at a single
// combined glyph (LyricGlyph.js's `ship_wave`/`heart_break`) instead of
// whichever single-concept glyph happened to win priority. A line that
// confirms two concepts together is more specific evidence than a line
// that only mentions one, so combos rank above every plain ENTRIES match,
// easter eggs included.

import { normalizeLine } from './LyricStructure.js';

const ENTRIES = [
  // --- Easter eggs (priority 3): culturally specific, unmistakable -------
  { id: 'leaf',      pri: 3, words: ['weed', 'blunt', 'kush', 'cannabis', 'marijuana', '420', 'chronic', 'dank', 'spliff', 'bong', 'ganja', 'reefer'] },
  { id: 'rocket',    pri: 3, words: ['rocket', 'liftoff', 'astronaut', 'spaceship'] },
  { id: 'alien',     pri: 3, words: ['alien', 'aliens', 'ufo', 'extraterrestrial', 'martian'] },
  { id: 'serpent',   pri: 3, words: ['serpent', 'cobra', 'viper', 'python', 'rattlesnake'] },
  { id: 'trident',   pri: 3, words: ['trident', 'poseidon', 'neptune'] },

  // --- Specific symbols (priority 2): clear concept, low ambiguity ------
  { id: 'crown',     pri: 2, words: ['crown', 'crowns', 'crowned', 'king', 'queen', 'royalty', 'throne', 'reign'] },
  { id: 'skull',     pri: 2, words: ['skull', 'skulls', 'skeleton', 'bones', 'grave', 'graveyard'] },
  { id: 'lightning', pri: 2, words: ['lightning', 'thunder', 'thunderbolt', 'bolt', 'voltage', 'electric'] },
  { id: 'flame',     pri: 2, words: ['fire', 'flame', 'flames', 'inferno', 'blaze', 'blazing', 'wildfire'] },
  { id: 'sword',     pri: 2, words: ['sword', 'swords', 'blade', 'dagger', 'warrior', 'samurai', 'knight'] },
  { id: 'diamond',   pri: 2, words: ['diamond', 'diamonds', 'jewel', 'jewels', 'crystal', 'crystals'] },
  { id: 'eye',       pri: 2, words: ['eye', 'eyes', 'third eye', 'all seeing', 'vision', 'visions'] },
  { id: 'ghost',     pri: 2, words: ['ghost', 'ghosts', 'phantom', 'haunt', 'haunted', 'haunting', 'specter'] },
  { id: 'wings',     pri: 2, words: ['wings', 'angel', 'angels', 'archangel', 'feathers', 'wingspan'] },
  { id: 'ship',      pri: 2, words: ['ship', 'ships', 'sail', 'sails', 'sailing', 'sailed', 'vessel', 'schooner'] },

  // --- Common symbols (priority 1): broad concepts, high chance of match -
  { id: 'heart',     pri: 1, words: ['heart', 'hearts', 'heartbeat', 'heartbreak', 'heartless'] },
  { id: 'star',      pri: 1, words: ['star', 'stars', 'starlight', 'starry', 'starshine', 'stardust'] },
  { id: 'moon',      pri: 1, words: ['moon', 'moonlight', 'moonshine', 'lunar', 'crescent'] },
  { id: 'wave',      pri: 1, words: ['ocean', 'waves', 'tide', 'tidal', 'tsunami', 'surf'] },
  { id: 'mountain',  pri: 1, words: ['mountain', 'mountains', 'summit', 'peak', 'peaks', 'everest'] },
  { id: 'infinity',  pri: 1, words: ['forever', 'infinite', 'infinity', 'eternal', 'eternity', 'endless', 'timeless'] },
  { id: 'cross',     pri: 1, words: ['cross', 'crucifix', 'crucified', 'holy', 'sacred', 'divine'] },

  // --- Symbolism (priority 1): what a line is ABOUT, not only what it names.
  // The entries above only fire on a literal noun, so most lines -- which
  // talk about love, time, freedom, loss -- drew nothing at all, and the
  // lyric feature read as occasional clip-art. These map a theme to its
  // conventional symbol (love -> heart, time -> hourglass, freedom -> bird,
  // grief -> tear, captivity -> chain). Still conservative in the file
  // header's sense: every word here carries its theme in nearly any lyric,
  // and deliberately generic words ('go', 'feel', 'know') are left out.
  { id: 'heart',     pri: 1, words: ['love', 'loved', 'lover', 'lovers', 'loving', 'darling', 'sweetheart'] },
  { id: 'hourglass', pri: 1, words: ['time', 'clock', 'clocks', 'hourglass', 'ticking', 'hours', 'minutes', 'yesterday', 'tomorrow'] },
  { id: 'bird',      pri: 1, words: ['bird', 'birds', 'sparrow', 'dove', 'doves', 'eagle', 'raven', 'crow', 'fly', 'flying', 'flew', 'free', 'freedom'] },
  { id: 'key',       pri: 1, words: ['key', 'keys', 'unlock', 'unlocked', 'secret', 'secrets'] },
  { id: 'rose',      pri: 1, words: ['rose', 'roses', 'flower', 'flowers', 'bloom', 'blooming', 'blossom', 'petal', 'petals', 'garden'] },
  { id: 'sun',       pri: 1, words: ['sun', 'sunshine', 'sunlight', 'sunrise', 'sunset', 'dawn', 'daylight'] },
  { id: 'tear',      pri: 1, words: ['tears', 'teardrop', 'teardrops', 'cry', 'crying', 'cried', 'weep', 'weeping', 'rain', 'raining'] },
  { id: 'tree',      pri: 1, words: ['tree', 'trees', 'roots', 'branches', 'forest', 'woods'] },
  { id: 'anchor',    pri: 1, words: ['anchor', 'anchored', 'harbor', 'harbour', 'steady', 'stay'] },
  { id: 'chain',     pri: 1, words: ['chain', 'chains', 'chained', 'cage', 'caged', 'prison', 'trapped', 'shackles', 'captive'] },
  { id: 'moon',      pri: 1, words: ['night', 'nights', 'midnight'] },
  { id: 'flame',     pri: 1, words: ['burn', 'burning', 'burned', 'burnt', 'desire'] },
  { id: 'skull',     pri: 1, words: ['death', 'dead', 'die', 'dying'] },
  { id: 'cross',     pri: 1, words: ['pray', 'prayer', 'prayers', 'heaven', 'god'] },
  { id: 'star',      pri: 1, words: ['shine', 'shining', 'wish', 'wishes'] },
  { id: 'wave',      pri: 1, words: ['sea', 'seas'] },
  { id: 'mountain',  pri: 1, words: ['climb', 'climbing'] },
];

// Pre-build a word → entry lookup for O(1) matching.
const WORD_INDEX = new Map();
for (const entry of ENTRIES) {
  for (const w of entry.words) {
    // Multi-word phrases go into a separate check.
    if (!w.includes(' ')) {
      const existing = WORD_INDEX.get(w);
      if (!existing || entry.pri > existing.pri) WORD_INDEX.set(w, entry);
    }
  }
}
const PHRASE_ENTRIES = ENTRIES.filter((e) => e.words.some((w) => w.includes(' ')));

// Two-image combos (see the file header). `words` are compound single-token
// triggers that already say both halves at once ("heartbreak" IS heart +
// break, no second word needed); `a`/`b` require one word from EACH side
// to appear anywhere in the line. Priority 4: above every plain ENTRIES
// match, easter eggs (3) included -- two confirmed concepts outrank one.
const COMBOS = [
  {
    id: 'heart_break', pri: 4,
    words: ['heartbreak', 'heartbroken'],
    a: ['heart', 'hearts'],
    b: ['break', 'breaks', 'breaking', 'broken', 'shatter', 'shattered', 'shattering', 'fracture', 'fractured', 'crack', 'cracked'],
  },
  {
    id: 'ship_wave', pri: 4,
    words: [],
    a: ['ship', 'ships', 'sail', 'sails', 'sailing', 'sailed', 'vessel', 'schooner'],
    b: ['ocean', 'wave', 'waves', 'tide', 'tidal', 'tsunami', 'surf', 'sea'],
  },
  {
    id: 'phoenix', pri: 4,
    words: ['phoenix'],
    a: ['wings', 'angel', 'angels', 'archangel', 'feathers', 'wingspan'],
    b: ['fire', 'flame', 'flames', 'inferno', 'blaze', 'blazing', 'wildfire'],
  },
  {
    id: 'moon_tide', pri: 4,
    words: [],
    a: ['moon', 'moonlight', 'moonshine', 'lunar', 'crescent'],
    b: ['ocean', 'waves', 'tide', 'tidal', 'tsunami', 'surf'],
  },
];

function comboMatch(words) {
  for (const combo of COMBOS) {
    if (combo.words.some((w) => words.includes(w))) return { glyphId: combo.id, priority: combo.pri };
    if (combo.a.some((w) => words.includes(w)) && combo.b.some((w) => words.includes(w))) {
      return { glyphId: combo.id, priority: combo.pri };
    }
  }
  return null;
}

/** Scan a raw lyric line and return the highest-priority glyph match,
 *  or null if nothing matched. Pure, no state. */
export function scanLine(rawText) {
  const norm = normalizeLine(rawText);
  if (!norm) return null;
  const words = norm.split(' ').filter(Boolean);

  let best = comboMatch(words);

  // Multi-word phrases (next highest specificity after a combo).
  for (const entry of PHRASE_ENTRIES) {
    for (const phrase of entry.words) {
      if (phrase.includes(' ') && norm.includes(phrase)) {
        if (!best || entry.pri > best.priority) best = { glyphId: entry.id, priority: entry.pri };
      }
    }
  }

  // Single-word lookup.
  for (const w of words) {
    const entry = WORD_INDEX.get(w);
    if (entry && (!best || entry.pri > best.priority)) {
      best = { glyphId: entry.id, priority: entry.pri };
    }
  }
  return best;
}

/** The symbol a whole passage keeps returning to: the glyph matched by the
 *  most lines, ties broken by priority and then by which came first. One
 *  passing mention loses to a motif, which is what makes it the passage's
 *  symbol rather than its clip-art. `lines` is an array of strings, or one
 *  string with newline-separated lines. Null when nothing matches. */
export function dominantSymbol(lines) {
  const list = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  const tally = new Map();
  list.forEach((line, order) => {
    const hit = scanLine(line);
    if (!hit) return;
    const t = tally.get(hit.glyphId) || { count: 0, priority: hit.priority, first: order };
    t.count++;
    tally.set(hit.glyphId, t);
  });
  let best = null;
  for (const [glyphId, t] of tally) {
    if (!best || t.count > best.count
      || (t.count === best.count && (t.priority > best.priority
        || (t.priority === best.priority && t.first < best.first)))) best = { glyphId, ...t };
  }
  return best ? best.glyphId : null;
}

/** Extract a short, punchy phrase from a chorus block's text for sky
 *  writing. Returns an uppercase string of at most ~20 characters, or
 *  null if nothing usable can be pulled. */
export function extractChorusPhrase(chorusText) {
  if (!chorusText) return null;
  const lines = chorusText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // Pick the shortest non-trivial line (the hook is usually the shortest
  // repeated line in a chorus). "Non-trivial" = at least 2 words.
  let pick = null;
  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    if (!pick || line.length < pick.length) pick = line;
  }
  // Fallback: take the first line regardless.
  if (!pick) pick = lines[0];

  // Truncate to ~20 visible characters, breaking at word boundary.
  let result = pick.toUpperCase();
  if (result.length > 22) {
    const words = result.split(/\s+/);
    result = '';
    for (const w of words) {
      const next = result ? result + ' ' + w : w;
      if (next.length > 20 && result.length > 0) break;
      result = next;
    }
  }
  // Strip trailing punctuation that looks weird sky-written.
  result = result.replace(/[,;:.!?]+$/, '').trim();
  return result.length >= 2 ? result : null;
}
