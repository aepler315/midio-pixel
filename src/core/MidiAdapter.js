// Adapter: SMF ArrayBuffer -> unified NoteEvent[] timeline + bar grid (spec §1.1).
import { parseMidi, pairNotes, rescaleVelocities } from './MidiParser.js';
import { classifyTracks } from './TrackClassifier.js';
import { Role, makeNoteEvent, sortNoteEvents } from './NoteEvent.js';
import { assignPan, panAt, intertwinedPairs } from './PanAnalysis.js';
import { laneForTrack } from './Casting.js';

// Standard GM kick pitches on channel 10 (0-indexed channel 9).
const GM_KICK_PITCHES = new Set([35, 36]);

/** First Program Change value seen on `channel` anywhere in the track (-1 if none). */
function firstProgramOnChannel(rawEvents, channel) {
  for (const e of rawEvents) {
    if (e.type === 0xc0 && e.channel === channel) return e.d1;
  }
  return -1;
}

/** First Pan (CC#10) value seen on `channel`, mapped -1..1 (64 = center). 0 (center) if none. */
function firstPanOnChannel(rawEvents, channel) {
  for (const e of rawEvents) {
    if (e.type === 0xb0 && e.channel === channel && e.d1 === 10) {
      return Math.max(-1, Math.min(1, (e.d2 - 64) / 63));
    }
  }
  return 0;
}

export function midiToTimeline(arrayBuffer) {
  const parsed = parseMidi(arrayBuffer);
  const { tracks, tempoMap, timeSigEvents } = parsed;

  // Determine the song's last tick across all tracks (for force-closing notes).
  let lastTick = 0;
  for (const t of tracks) {
    for (const e of t.rawEvents) if (e.tick > lastTick) lastTick = e.tick;
  }
  const durationMs = tempoMap.toMs(lastTick);

  // Pair notes once per SMF track, then split by channel into "voices". A
  // track that multiplexes several channels (SMF Type 0 routes all 16
  // through a single MTrk; some Type 1 exports double up) becomes one voice
  // per channel so each instrument keeps its own program/pan/role instead of
  // blending together. The overwhelming majority of real-world tracks use
  // exactly one channel and pass through as a single unchanged voice.
  let nextIndex = 0;
  const trackData = [];
  for (const track of tracks) {
    const paired = pairNotes(track.rawEvents, lastTick);
    rescaleVelocities(paired);
    const channelsUsed = [...new Set(paired.map((n) => n.channel))].sort((a, b) => a - b);
    const split = channelsUsed.length > 1;
    const voiceChannels = channelsUsed.length ? channelsUsed : [track.channel];

    for (const channel of voiceChannels) {
      const program = split ? firstProgramOnChannel(track.rawEvents, channel) : track.program;
      const pan = firstPanOnChannel(track.rawEvents, channel);
      let name = track.name;
      if (split) {
        if (track.name) name = `${track.name} \u00b7 Ch ${channel + 1}`;
        else if (program >= 0) name = parsed.gmProgramName(program) || `Channel ${channel + 1}`;
        else name = `Channel ${channel + 1}`;
      }

      const notes = paired.filter((n) => n.channel === channel).map((n) => ({
        pitch: n.pitch,
        startMs: tempoMap.toMs(n.tick),
        durMs: Math.max(1, tempoMap.toMs(n.tick + n.durTicks) - tempoMap.toMs(n.tick)),
        vel: n.velNorm,
        channel: n.channel,
      }));
      const durationSec = notes.length ? durationMs / 1000 : 0;
      trackData.push({
        track: {
          index: nextIndex++, name, instrumentName: track.instrumentName, channel, program, pan,
        },
        notes,
        durationSec,
      });
    }
  }

  const roles = classifyTracks(trackData, parsed.gmProgramName);
  const panByChannel = assignPan(trackData);

  const timeline = [];
  const lanesByTrack = new Map();
  for (const { track, notes } of trackData) {
    const role = roles.get(track.index);
    const panEntry = panByChannel.get(track.channel);
    // Casting: the track's name/instrument/program decides which character
    // performs this line (clean melody -> Midasus, bass -> Broshi, other
    // leads -> Midio). Purely a choreography routing -- the role above
    // stays the contract for the chart, obstacles, and every director.
    const lane = laneForTrack({
      name: track.name, instrumentName: track.instrumentName,
      program: track.program, channel: track.channel, role,
    });
    lanesByTrack.set(track.index, lane);
    for (const n of notes) {
      const kick = role === Role.RHYTHM && (GM_KICK_PITCHES.has(n.pitch) || n.channel === 9 && n.pitch === 36);
      timeline.push(makeNoteEvent({
        tMs: n.startMs,
        durMs: n.durMs,
        pitch: n.pitch,
        vel: n.vel,
        role,
        kick,
        src: 'midi',
        channel: n.channel,
        pan: panAt(panEntry, n.startMs, durationMs),
        program: track.program,
        lane,
      }));
    }
  }
  sortNoteEvents(timeline);

  const barGrid = buildBarGrid(timeSigEvents, tempoMap, durationMs, parsed.ppqn);

  return {
    timeline,
    barGrid,
    durationMs,
    // Uploaded/dropped files never carry an authored cue sheet -- only the
    // built-in demo song does (DemoSong.js builds its own `conductor` object
    // directly). Kept as a field, not removed, so BiomeManager/Simulation's
    // `timelineData.conductor` reads stay uniform across both sources.
    conductor: null,
    bpm: tempoMap.bpmAt ? (tempoMap.bpmAt(0) || 120) : 120,
    confidence: parsed.smpte ? 0 : 1,
    freeTime: !!parsed.smpte,
    firstBarMs: barGrid[0]?.ms ?? 0,
    localTempo: (tempoMap.seg || []).map(s => ({ tMs: s.ms, beatPeriodMs: s.us / 1000, confidence: 1 })),
    tracks: trackData.map(({ track, notes }) => ({
      index: track.index,
      name: track.name,
      role: roles.get(track.index),
      lane: lanesByTrack.get(track.index) ?? null,
      noteCount: notes.length,
      channel: track.channel,
      pan: panByChannel.get(track.channel)?.pan ?? track.pan ?? 0,
      intertwined: panByChannel.get(track.channel)?.dynamic ?? false,
    })),
    pairs: intertwinedPairs(panByChannel),
  };
}

/** Absolute-ms downbeat grid, derived from the time-signature map (spec §1.1.3). */
function buildBarGrid(timeSigEvents, tempoMap, totalMs, ppqn) {
  const grid = [];
  const sorted = [...timeSigEvents].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < sorted.length; i++) {
    const sig = sorted[i];
    const nextTick = i + 1 < sorted.length ? sorted[i + 1].tick : null;
    const ticksPerBar = ppqn ? (ppqn * 4 * sig.numerator) / sig.denominator : null;
    if (!ticksPerBar) break; // SMPTE-mode maps have no PPQN bar concept here
    let tick = sig.tick;
    const endTick = nextTick !== null ? nextTick : (tempoMap.toTick ? tempoMap.toTick(totalMs) : tick);
    while (tick <= endTick + 1e-6) {
      grid.push({ tick, ms: tempoMap.toMs(tick), numerator: sig.numerator, denominator: sig.denominator });
      tick += ticksPerBar;
    }
  }
  return grid;
}
