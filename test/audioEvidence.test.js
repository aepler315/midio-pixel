import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSongProfile } from '../src/audio/SongProfile.js';
import { buildSongDNA } from '../src/world/dna/SongDNA.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { extractRidgePortrait } from '../src/world/RidgePortrait.js';
import { estimateBassPitchAt, midiToHz } from '../src/audio/PitchTracker.js';
import { globalBandReferences, normalizeBands, extractPseudoLane, detectRhythmOnsets } from '../src/audio/OnsetDetector.js';
import { summarizeRhythmOnsets } from '../src/audio/RhythmProfile.js';
import { packBundle, unpackBundle, bytesToB64 } from '../src/audio/AnalysisBundle.js';
import { Role } from '../src/core/NoteEvent.js';

function curves(durationMs = 60000) {
  const c = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < c.n; i++) c.setFrame(i, Array(7).fill(i < c.n / 2 ? .1 : .8));
  return c;
}
test('analyzer starts-only section contract includes final and only sections', () => {
  for (const starts of [[0], [0, 30000]]) {
    const profile = buildSongProfile({ durationMs: 60000, energyCurves: curves(), structure: { boundariesMs: starts, labels: starts.map((_, i) => i), confidence: .9 } });
    assert.equal(profile.sections.length, starts.length);
    assert.equal(profile.sections.at(-1).endMs, 60000);
  }
});
test('recording chroma owns profile and DNA despite inferred and synthetic notes', () => {
  const data = { durationMs: 60000, analysis: { tonic: 9, mode: 'minor', tonalConfidence: .9 }, timeline: Array.from({ length: 12 }, (_, i) => ({ tMs: i * 1000, durMs: 900, pitch: [60,64,67][i % 3], vel: .5, role: i % 2 ? Role.MELODY : Role.PAD, src: 'audio', channel: 3, program: -1 })) };
  const profile = buildSongProfile(data);
  const dna = buildSongDNA({ ...data, profile });
  assert.equal(profile.tonal.source, 'audio-chroma');
  assert.equal(profile.tonal.tonic, 9);
  assert.equal(dna.tonicPc, 9);
  assert.equal(dna.isMajor, false);
  assert.equal(dna.keyConfidence, .9);
});
test('physical RMS power shares survive activity normalization and bundle restore', () => {
  const c = curves(60000), rms = [.8,.4,.3,.2,.1,.05,.02];
  c.rmsBands = rms.map(v => new Float32Array(c.n).fill(v));
  c.bands.forEach(b => b.fill(1));
  for (const candidate of [c, unpackBundle(packBundle({ durationMs: 60000, energyCurves: c, timeline: [], barGrid: [] })).energyCurves]) {
    const portrait = extractRidgePortrait(candidate, 60000);
    const power = rms.reduce((sum,v) => sum + v * v, 0);
    assert.ok(Math.abs(portrait.shares[0] - rms[0] ** 2 / power) < .001);
  }
});
test('bass semitone sweep avoids subharmonics for sine and harmonic-rich bass', () => {
  const sr = 44100;
  for (let midi = 28; midi <= 52; midi++) {
    for (const harmonics of [false, true]) {
      const hz = midiToHz(midi);
      const pcm = Float32Array.from({length: sr / 2}, (_, i) => .3 * Math.sin(2*Math.PI*hz*i/sr) + (harmonics ? .15*Math.sin(4*Math.PI*hz*i/sr) + .07*Math.sin(6*Math.PI*hz*i/sr) : 0));
      assert.equal(estimateBassPitchAt(pcm, sr, 0), midi, `pitch ${midi}, harmonics ${harmonics}`);
    }
  }
});
test('sparse and dense accents retain quiet/loud contrast in every lane', () => {
  for (const hold of [1, 8, 40]) {
    const raw = Array.from({length: 7}, () => new Float32Array(4000));
    for (let frame = 100; frame < 3900; frame += 100) for (const b of raw) for (let j=0;j<hold;j++) b[frame+j] = frame < 2000 ? .05 : 1;
    assert.ok(globalBandReferences(raw)[0] > .9);
    const normalized = normalizeBands(raw, 100);
    const lanes = [detectRhythmOnsets(normalized, raw, 100).onsets, extractPseudoLane(normalized, 100, {rawBands: raw, bandIndices:[2,3,4], pitchLo:60,pitchHi:96, role:Role.MELODY})];
    for (const lane of lanes) assert.ok(lane.find(e=>e.tMs < 20000).vel < lane.find(e=>e.tMs >= 20000).vel * .4);
  }
});
test('tiny tempo drift and harmonic kick spacing remain regular', () => {
  for (const period of [500,502,504,1004]) {
    const result = summarizeRhythmOnsets(Array.from({length:480}, (_,i)=>({tMs:i*period,kick:true})), 240000, {beatPeriodMs:500, confidence:.9});
    assert.ok(result.pulseRegularity > .85);
  }
});
test('silent free-time opening carries no tempo heat', () => {
  const profile = buildSongProfile({durationMs:15000,bpm:198.77,confidence:0,freeTime:true,energyCurves:new EnergyCurves(15000),analysis:{rhythm:{eventDensity:0,pulseRegularity:0,confidence:0},tonalConfidence:0}});
  assert.equal(profile.watch.tempoHeat, 0);
});
test('bundle rejects missing bands, dimensions and nonfinite or unsorted times', () => {
  const base = packBundle({durationMs:60000,energyCurves:curves(),timeline:[{tMs:1000,durMs:90,pitch:36,vel:.8,role:Role.RHYTHM,src:'audio'}],barGrid:[]});
  for (const mutate of [b=>b.curves.bands[0]='', b=>b.curves.bands.pop(), b=>b.curves.n++, b=>b.notes.count=0, b=>b.durationMs=NaN]) {
    const b=structuredClone(base); mutate(b); assert.equal(unpackBundle(b), null);
  }
});
test('authored MIDI key is the shared profile and DNA result; recording pitches need provenance', () => {
  const data={durationMs:60000, timeline:Array.from({length:12},(_,i)=>({src:'midi',pitch:[60,64,67][i%3],tMs:i*1000,durMs:900,vel:.5,role:Role.MELODY,channel:0})),analysis:{tonic:9,mode:'minor',tonalConfidence:.9}};
  const profile=buildSongProfile(data), dna=buildSongDNA({...data,profile});
  assert.equal(profile.tonal.source,'midi'); assert.equal(profile.tonal.tonic,0);
  assert.equal(dna.tonicPc,profile.tonal.tonic); assert.equal(dna.keyConfidence,profile.tonal.confidence);
});
test('bass confidence comes from periodic support and handles slides and distortion', () => {
  const sr=44100;
  for(const midi of [28,36,43,47,52]) {
    const hz=midiToHz(midi);
    for(const slide of [false,true]) {
      const pcm=Float32Array.from({length:sr/2},(_,i)=> {
        const phase=2*Math.PI*hz*i/sr * (slide ? 1+.015*i/sr : 1);
        return Math.tanh(3*Math.sin(phase))*.3;
      });
      const estimate=estimateBassPitchAt(pcm,sr,0,{returnEstimate:true});
      assert.ok(Math.abs(estimate.pitch-midi)<=1); assert.ok(estimate.confidence>.8);
    }
  }
  assert.equal(estimateBassPitchAt(new Float32Array(sr/2),sr,0,{returnEstimate:true}),null);
});
test('note pitch provenance and local pulse metadata round-trip with physical analysis',()=> {
  const timeline=['tracked','inferred','synthetic','unpitched'].map((p,i)=>({tMs:i*1000,durMs:90,pitch:60,vel:.5,role:Role.MELODY,src:'audio',pitchProvenance:p,pitchConfidence:i===0?.8:0}));
  const data={durationMs:60000,energyCurves:curves(),timeline,barGrid:[],firstBarMs:123,localTempo:[{tMs:0,beatPeriodMs:502,confidence:.9}]};
  const output=unpackBundle(packBundle(data));
  assert.equal(output.firstBarMs,123); assert.deepEqual(output.localTempo,data.localTempo);
  assert.deepEqual(output.timeline.map(e=>e.pitchProvenance),timeline.map(e=>e.pitchProvenance));
  assert.deepEqual(output.timeline.map(e=>e.pitchConfidence),timeline.map(e=>e.pitchConfidence));
});

test('bundle refuses mismatched structure labels and nonfinite or unsorted time columns', () => {
  const notes=[0,1000].map(tMs=>({tMs,durMs:90,pitch:60,vel:.5,src:'audio',role:Role.MELODY}));
  const base=packBundle({ durationMs:60000,energyCurves:curves(),timeline:notes,barGrid:[],structure:{boundariesMs:[0,30000],labels:['A','B'],confidence:.9} });
  assert.ok(unpackBundle(base));
  const encoded=values=>bytesToB64(new Uint8Array(Float32Array.from(values).buffer));
  for(const mutate of [ b=>b.notes.tMs=encoded([1000,0]), b=>b.notes.tMs=encoded([0,NaN]), b=>b.structure.labels.pop(), b=>b.structure.boundariesMs=encoded([0,Infinity]), b=>b.curves.rmsBands=Array(7).fill(encoded([NaN])) ]) {
    const bad=structuredClone(base); mutate(bad); assert.ok(unpackBundle(bad)===null);
  }
});

test('authored BPM remains authoritative while unknown recording tempo is gated', () => {
  const authored=buildSongProfile({durationMs:60000,bpm:160});
  const recording=buildSongProfile({durationMs:60000,bpm:160,analysis:{tonalConfidence:0}});
  assert.ok(authored.watch.tempoHeat>.9); assert.equal(authored.pulse.confidence,1);
  assert.equal(recording.watch.tempoHeat,0); assert.equal(recording.pulse.confidence,0);
});
test('malformed current-version profile and nested identity profile invalidate cached bundle',()=> {
  const base=packBundle({durationMs:60000,energyCurves:curves(),timeline:[],barGrid:[]});
  const cases=[b=>b.songProfile={version:base.songProfile.version},b=>b.songProfile.watch.drive=NaN,b=>b.songIdentity={seed:7,songProfile:{version:base.songProfile.version}},b=>b.songIdentity={seed:7,songProfile:{...structuredClone(base.songProfile),sections:[{startMs:0,endMs:Infinity}]}}];
  for(const mutate of cases) {const b=structuredClone(base);mutate(b);assert.ok(unpackBundle(b)===null);}
});
