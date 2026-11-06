const OPENING_PROGRESS = .025;
const MIN_BEAT_CONFIDENCE = .2;

function beatAt(transport, timeMs) {
  const { beatIndex, phase01 } = transport.snapshotAt(timeMs);
  return beatIndex + phase01;
}

/** Compile growth milestones once and sample them from the heard song clock. */
export function createVoxelRangeScore({ sections = [], durationMs = 0, beatTransport = null } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { progressAt: () => OPENING_PROGRESS };

  const ordered = sections.filter(s => Number.isFinite(s?.startMs) && Number.isFinite(s?.endMs))
    .sort((a, b) => a.startMs - b.startMs);
  const spans = [];
  for (const section of ordered) {
    const prior = spans.at(-1);
    const startMs = Math.max(prior?.endMs ?? 0, section.startMs);
    const endMs = Math.min(durationMs, section.endMs);
    if (endMs <= startMs) continue;
    if (section.provenance === 'decorative' && prior?.endMs === startMs) prior.endMs = endMs;
    else spans.push({ startMs, endMs });
  }
  if (!spans.length) spans.push({ startMs: 0, endMs: durationMs });

  // Let the completed skyline hold before playback reaches the end.
  const last = spans.at(-1);
  if (last.endMs === durationMs) last.endMs -= Math.min(500, (last.endMs - last.startMs) * .1);

  const hasBeatClock = !beatTransport?.freeTime && beatTransport?.confidence >= MIN_BEAT_CONFIDENCE;
  if (hasBeatClock) {
    for (const span of spans) {
      span.startBeat = beatAt(beatTransport, span.startMs);
      span.beatCount = beatAt(beatTransport, span.endMs) - span.startBeat;
    }
  }
  const share = (1 - OPENING_PROGRESS) / spans.length;
  return {
    progressAt(heardTimeMs) {
      const timeMs = Number.isFinite(heardTimeMs) ? heardTimeMs : 0;
      for (const [index, span] of spans.entries()) {
        const before = OPENING_PROGRESS + index * share;
        if (timeMs <= span.startMs) return before;
        if (timeMs >= span.endMs) continue;
        const progress = span.beatCount > 0
          ? (beatAt(beatTransport, timeMs) - span.startBeat) / span.beatCount
          : (timeMs - span.startMs) / (span.endMs - span.startMs);
        return before + share * Math.max(0, Math.min(1, progress));
      }
      return 1;
    },
  };
}
