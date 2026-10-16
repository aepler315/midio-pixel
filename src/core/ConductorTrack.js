// The conductor cue schema: a cue is an authored instruction ("a new section
// starts here", "the drop hits now") rather than a note to play. Nothing
// external produces these anymore -- the only source today is the built-in
// demo song (DemoSong.js), which builds its cue sheet directly rather than
// decoding it from a MIDI track. BiomeManager folds the schedule cues
// (SECTION, BIOME) into its section plan at load; CueDirector dispatches the
// live ones as the song plays.
//
// Everything here is pure: no DOM, no audio, no engine imports.

export const CueKind = Object.freeze({
  // --- Schedule cues: read once at load, folded into the section plan ---
  SECTION: 'section',
  BIOME: 'biome',
  // --- Live cues: dispatched at their own tMs while the song plays ---
  KEY_CHANGE: 'keyChange',
  DROP: 'drop',
  APOTHEOSIS: 'apotheosis',
  FLOURISH: 'flourish',
  CALM: 'calm',
  METEORS: 'meteors',
  LIGHTNING: 'lightning',
  WEATHER: 'weather',
  SHAKE: 'shake',
  GROUND_PULSE: 'groundPulse',
  FEVER: 'fever',
});

/** Cues consumed at build time rather than dispatched during playback. */
export const SCHEDULE_KINDS = Object.freeze(new Set([CueKind.SECTION, CueKind.BIOME]));

/** Splits a cue list into the two consumption paths. */
export function splitCues(cues) {
  const schedule = [];
  const live = [];
  for (const c of cues || []) (SCHEDULE_KINDS.has(c.kind) ? schedule : live).push(c);
  return { schedule, live };
}

function nearestBarMs(barGrid, tMs) {
  if (!barGrid || barGrid.length === 0) return tMs;
  let best = barGrid[0].ms, bestDist = Math.abs(tMs - best);
  for (let i = 1; i < barGrid.length; i++) {
    const d = Math.abs(tMs - barGrid[i].ms);
    if (d < bestDist) { bestDist = d; best = barGrid[i].ms; }
  }
  return best;
}

const MIN_SECTION_MS = 700; // below this a "section" is a flicker, not a place

/**
 * Folds the schedule cues onto a section plan. SECTION cues cut a new
 * boundary (snapped to the bar grid, since a section that starts off-grid
 * reads as a mistake); BIOME cues override the profile of whichever section
 * contains them. Authored cues WIN over the detected plan -- that is the
 * whole point of a conductor track.
 *
 * `sections` is never mutated; an empty/absent cue list returns the exact
 * same array reference so callers can apply this unconditionally.
 */
export function applyConductorSchedule(sections, cues, barGrid, durationMs) {
  if (!cues || cues.length === 0) return sections;
  if (!sections || sections.length === 0) return sections;

  const sectionCues = cues.filter((c) => c.kind === CueKind.SECTION);
  const biomeCues = cues.filter((c) => c.kind === CueKind.BIOME);

  let out = sections.map((s) => ({ ...s }));

  if (sectionCues.length) {
    // Every authored boundary, snapped and de-duplicated, plus the song's
    // own start/end. Boundaries closer together than MIN_SECTION_MS collapse
    // into the earlier one rather than producing unreadable slivers.
    const bounds = [0];
    for (const c of sectionCues) {
      const snapped = Math.max(0, Math.min(durationMs, nearestBarMs(barGrid, c.tMs)));
      if (snapped - bounds[bounds.length - 1] >= MIN_SECTION_MS) bounds.push(snapped);
    }
    if (durationMs - bounds[bounds.length - 1] < MIN_SECTION_MS && bounds.length > 1) bounds.pop();
    bounds.push(durationMs);

    // Each new section inherits the detected plan's read of that moment
    // (profile, label, hue bias, lyric fields) so cueing a boundary never
    // costs the analysis everything else already knew about the music there.
    const rebuilt = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const startMs = bounds[i];
      const endMs = bounds[i + 1];
      const inherited = sectionContaining(out, startMs) || out[0];
      const cue = sectionCues.find(
        (c) => Math.abs(nearestBarMs(barGrid, c.tMs) - startMs) < 1,
      );
      rebuilt.push({
        ...inherited,
        startMs,
        endMs,
        // The first section has nothing to transition FROM; leave the
        // inherited style there so an opening cue can't shutter into frame.
        transition: i > 0 && cue ? cue.value : inherited.transition,
        cued: !!cue,
        // A player-authored boundary is not a read of the music at all --
        // it is instruction, and outranks whatever provenance the inherited
        // section carried (detected/inferred/decorative).
        provenance: cue ? 'authored' : inherited.provenance,
      });
    }
    out = rebuilt;
  }

  for (const c of biomeCues) {
    const sec = sectionContaining(out, c.tMs);
    if (sec) { sec.profile = c.value; sec.cuedBiome = true; }
  }

  return out;
}

function sectionContaining(sections, tMs) {
  for (const s of sections) if (tMs >= s.startMs && tMs < s.endMs) return s;
  return tMs >= (sections[sections.length - 1]?.endMs ?? 0)
    ? sections[sections.length - 1]
    : sections[0];
}
