// Builds a minimal valid SF2 (SoundFont 2) file in memory for unit tests.
// Contains 1 preset (bank 0, program 0), 1 instrument, 1 sample (sine wave),
// with keyRange/velRange/envelope generators in the instrument zone.

const SAMPLE_COUNT = 97; // 194 bytes of int16 PCM
const SAMPLE_RATE = 44100;

// Byte-builder helpers
function u32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }
function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
function i16(v) { return u16(v < 0 ? v + 0x10000 : v); }
function i8v(v) { return [v & 0xff]; }
function fourcc(s) { return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]; }
function str(s, len) {
  const a = [];
  for (let i = 0; i < len; i++) a.push(i < s.length ? s.charCodeAt(i) : 0);
  return a;
}
function padEven(arr) { if (arr.length & 1) arr.push(0); return arr; }
function cat(...arrs) { return arrs.flat(); }

export function buildMinimalSf2(name = 'TestFont') {
  // --- Sample data: sine wave ---
  const smplData = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const v = Math.round(Math.sin((i / SAMPLE_COUNT) * Math.PI * 2) * 0.8 * 32767);
    smplData.push(...i16(v));
  }
  const smplChunk = cat(fourcc('smpl'), u32(smplData.length), smplData);

  // --- INFO/INAM ---
  const inamData = str(name, name.length + 1); // null-terminated
  const inamChunk = padEven(cat(fourcc('INAM'), u32(inamData.length), inamData).slice());
  // Actually padEven mutates in place, let me be explicit:
  const inamRaw = cat(fourcc('INAM'), u32(inamData.length), inamData);
  if (inamRaw.length & 1) inamRaw.push(0);
  const infoBody = cat(fourcc('INFO'), inamRaw);
  const infoList = cat(fourcc('LIST'), u32(infoBody.length), infoBody);

  // --- sdta LIST ---
  const sdtaBody = cat(fourcc('sdta'), smplChunk);
  const sdtaList = cat(fourcc('LIST'), u32(sdtaBody.length), sdtaBody);

  // --- pdta sub-chunks ---

  // phdr: 1 real preset + 1 sentinel = 2 entries × 38 bytes
  const phdrData = cat(
    str('TestPreset', 20), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0), // bank0/prog0, bag 0
    str('EOP', 20), u16(0), u16(0), u16(1), u32(0), u32(0), u32(0),          // sentinel, bag end=1
  );
  const phdrChunk = cat(fourcc('phdr'), u32(phdrData.length), phdrData);

  // pbag: 1 entry (genNdx=0, modNdx=0)
  const pbagData = cat(u16(0), u16(0));
  const pbagChunk = cat(fourcc('pbag'), u32(pbagData.length), pbagData);

  // pmod: 1 terminal entry (10 zeros)
  const pmodData = new Array(10).fill(0);
  const pmodChunk = cat(fourcc('pmod'), u32(pmodData.length), pmodData);

  // pgen: 1 entry (instrument=0)
  const pgenData = cat(u16(41), u16(0));
  const pgenChunk = cat(fourcc('pgen'), u32(pgenData.length), pgenData);

  // inst: 1 real + 1 sentinel = 2 entries × 22 bytes
  const instData = cat(
    str('TestInst', 20), u16(0), // instrument 0, bag 0
    str('EOI', 20), u16(1),     // sentinel, bag end=1
  );
  const instChunk = cat(fourcc('inst'), u32(instData.length), instData);

  // ibag: 1 entry (genNdx=0, modNdx=0)
  const ibagData = cat(u16(0), u16(0));
  const ibagChunk = cat(fourcc('ibag'), u32(ibagData.length), ibagData);

  // imod: 1 terminal entry
  const imodData = new Array(10).fill(0);
  const imodChunk = cat(fourcc('imod'), u32(imodData.length), imodData);

  // igen: 6 entries — keyRange, velRange, attack, decay, sustain, sampleID
  // Opcodes per SF2 spec §8.1.3: attackVolEnv=34, decayVolEnv=36, sustainVolEnv=37
  const igenData = cat(
    u16(43), u16(40 | (84 << 8)),  // keyRange: 40-84
    u16(44), u16(20 | (110 << 8)),  // velRange: 20-110
    u16(34), i16(-6000),            // attackVolEnv: -6000 timecents (~31ms)
    u16(36), i16(-4800),            // decayVolEnv: -4800 timecents (~63ms)
    u16(37), i16(-100),             // sustainVolEnv: -100 centibels (~31.6%)
    u16(53), u16(0),                // sampleID: 0 (terminal)
  );
  const igenChunk = cat(fourcc('igen'), u32(igenData.length), igenData);

  // shdr: 1 real + 1 sentinel = 2 entries × 46 bytes
  const shdrData = cat(
    str('TestSample', 20),
    u32(0), u32(SAMPLE_COUNT),           // start, end
    u32(16), u32(SAMPLE_COUNT - 16),     // loopStart, loopEnd
    u32(SAMPLE_RATE),                    // sampleRate
    i8v(60), i8v(0),                    // rootKey=60, fineTune=0 (int8)
    u16(0), u16(0),                      // link, type
    // sentinel
    str('EOS', 20),
    u32(0), u32(0), u32(0), u32(0),
    u32(44100),
    i8v(0), i8v(0), u16(0), u16(0),
  );
  const shdrChunk = cat(fourcc('shdr'), u32(shdrData.length), shdrData);

  // --- pdta LIST ---
  const pdtaBody = cat(fourcc('pdta'), phdrChunk, pbagChunk, pmodChunk, pgenChunk, instChunk, ibagChunk, imodChunk, igenChunk, shdrChunk);
  const pdtaList = cat(fourcc('LIST'), u32(pdtaBody.length), pdtaBody);

  // --- RIFF ---
  const riffBody = cat(fourcc('sfbk'), infoList, sdtaList, pdtaList);
  const riff = cat(fourcc('RIFF'), u32(riffBody.length), riffBody);

  const buf = new ArrayBuffer(riff.length);
  new Uint8Array(buf).set(riff);
  return buf;
}

/**
 * A font whose ONE preset -> ONE instrument has ONE explicit zone
 * referencing a "leftSample" (SF2 sampleType=4) whose `sampleLink` points at
 * an UNZONED "rightSample" (type=2) partner — the link-only stereo pattern
 * some fonts use instead of hand-authoring two panned zones. If
 * `explicitPan` is set, the zone also carries its own PAN generator, which
 * must win over the type-inferred default.
 */
export function buildStereoLinkSf2({ name = 'LinkFont', explicitPan = null } = {}) {
  const smplData = cat(sineSampleBytes(), sineSampleBytes());
  const smplChunk = cat(fourcc('smpl'), u32(smplData.length), smplData);

  let inamRaw = cat(fourcc('INAM'), u32(name.length + 1), str(name, name.length + 1));
  if (inamRaw.length & 1) inamRaw.push(0);
  const infoBody = cat(fourcc('INFO'), inamRaw);
  const infoList = cat(fourcc('LIST'), u32(infoBody.length), infoBody);

  const sdtaBody = cat(fourcc('sdta'), smplChunk);
  const sdtaList = cat(fourcc('LIST'), u32(sdtaBody.length), sdtaBody);

  const phdrData = cat(
    str('P', 20), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0),
    str('EOP', 20), u16(0), u16(0), u16(1), u32(0), u32(0), u32(0),
  );
  const phdrChunk = cat(fourcc('phdr'), u32(phdrData.length), phdrData);
  const pbagChunk = cat(fourcc('pbag'), u32(4), u16(0), u16(0));
  const pmodChunk = cat(fourcc('pmod'), u32(10), new Array(10).fill(0));
  const pgenChunk = cat(fourcc('pgen'), u32(4), u16(41), u16(0));
  const instData = cat(str('I', 20), u16(0), str('EOI', 20), u16(1));
  const instChunk = cat(fourcc('inst'), u32(instData.length), instData);
  const ibagChunk = cat(fourcc('ibag'), u32(4), u16(0), u16(0));
  const imodChunk = cat(fourcc('imod'), u32(10), new Array(10).fill(0));

  let igenData = cat(
    u16(43), u16(0 | (127 << 8)), // keyRange full
    u16(44), u16(0 | (127 << 8)), // velRange full
  );
  if (explicitPan !== null) igenData = igenData.concat(u16(17), i16(Math.round(explicitPan * 500)));
  igenData = igenData.concat(u16(53), u16(0)); // sampleID: 0 (the leftSample), must stay last
  const igenChunk = cat(fourcc('igen'), u32(igenData.length), igenData);

  const shdrData = cat(
    str('Left', 20), u32(0), u32(SAMPLE_COUNT), u32(16), u32(SAMPLE_COUNT - 16), u32(SAMPLE_RATE), i8v(60), i8v(0), u16(1), u16(4), // type=4 leftSample, link=1
    str('Right', 20), u32(SAMPLE_COUNT), u32(SAMPLE_COUNT * 2), u32(SAMPLE_COUNT + 16), u32(SAMPLE_COUNT * 2 - 16), u32(SAMPLE_RATE), i8v(60), i8v(0), u16(0), u16(2), // type=2 rightSample, link=0
    str('EOS', 20), u32(0), u32(0), u32(0), u32(0), u32(44100), i8v(0), i8v(0), u16(0), u16(0),
  );
  const shdrChunk = cat(fourcc('shdr'), u32(shdrData.length), shdrData);

  const pdtaBody = cat(fourcc('pdta'), phdrChunk, pbagChunk, pmodChunk, pgenChunk, instChunk, ibagChunk, imodChunk, igenChunk, shdrChunk);
  const pdtaList = cat(fourcc('LIST'), u32(pdtaBody.length), pdtaBody);
  const riffBody = cat(fourcc('sfbk'), infoList, sdtaList, pdtaList);
  const riff = cat(fourcc('RIFF'), u32(riffBody.length), riffBody);
  const buf = new ArrayBuffer(riff.length);
  new Uint8Array(buf).set(riff);
  return buf;
}

/**
 * A font whose ONE preset -> ONE instrument has TWO explicit zones, each
 * with its own PAN generator (-1 / +1) and its own untyped (type=0) sample —
 * the "already works" hand-authored stereo pattern, used to confirm the
 * link-expansion logic never double-pairs a font that doesn't need it.
 */
export function buildDualZoneStereoSf2(name = 'DualFont') {
  const smplData = cat(sineSampleBytes(), sineSampleBytes());
  const smplChunk = cat(fourcc('smpl'), u32(smplData.length), smplData);

  let inamRaw = cat(fourcc('INAM'), u32(name.length + 1), str(name, name.length + 1));
  if (inamRaw.length & 1) inamRaw.push(0);
  const infoBody = cat(fourcc('INFO'), inamRaw);
  const infoList = cat(fourcc('LIST'), u32(infoBody.length), infoBody);

  const sdtaBody = cat(fourcc('sdta'), smplChunk);
  const sdtaList = cat(fourcc('LIST'), u32(sdtaBody.length), sdtaBody);

  const phdrData = cat(
    str('P', 20), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0),
    str('EOP', 20), u16(0), u16(0), u16(1), u32(0), u32(0), u32(0),
  );
  const phdrChunk = cat(fourcc('phdr'), u32(phdrData.length), phdrData);
  const pbagChunk = cat(fourcc('pbag'), u32(4), u16(0), u16(0));
  const pmodChunk = cat(fourcc('pmod'), u32(10), new Array(10).fill(0));
  const pgenChunk = cat(fourcc('pgen'), u32(4), u16(41), u16(0));
  const instData = cat(str('I', 20), u16(0), str('EOI', 20), u16(2)); // 2 ibag zones
  const instChunk = cat(fourcc('inst'), u32(instData.length), instData);
  const ibagChunk = cat(fourcc('ibag'), u32(8), u16(0), u16(0), u16(4), u16(0)); // 2 entries, 4 gens each
  const imodChunk = cat(fourcc('imod'), u32(10), new Array(10).fill(0));
  const igenData = cat(
    u16(43), u16(0 | (127 << 8)), u16(44), u16(0 | (127 << 8)), u16(17), i16(-500), u16(53), u16(0), // zone 1: pan=-1, sample 0
    u16(43), u16(0 | (127 << 8)), u16(44), u16(0 | (127 << 8)), u16(17), i16(500), u16(53), u16(1),  // zone 2: pan=+1, sample 1
  );
  const igenChunk = cat(fourcc('igen'), u32(igenData.length), igenData);
  const shdrData = cat(
    str('A', 20), u32(0), u32(SAMPLE_COUNT), u32(16), u32(SAMPLE_COUNT - 16), u32(SAMPLE_RATE), i8v(60), i8v(0), u16(0), u16(0),
    str('B', 20), u32(SAMPLE_COUNT), u32(SAMPLE_COUNT * 2), u32(SAMPLE_COUNT + 16), u32(SAMPLE_COUNT * 2 - 16), u32(SAMPLE_RATE), i8v(60), i8v(0), u16(0), u16(0),
    str('EOS', 20), u32(0), u32(0), u32(0), u32(0), u32(44100), i8v(0), i8v(0), u16(0), u16(0),
  );
  const shdrChunk = cat(fourcc('shdr'), u32(shdrData.length), shdrData);
  const pdtaBody = cat(fourcc('pdta'), phdrChunk, pbagChunk, pmodChunk, pgenChunk, instChunk, ibagChunk, imodChunk, igenChunk, shdrChunk);
  const pdtaList = cat(fourcc('LIST'), u32(pdtaBody.length), pdtaBody);
  const riffBody = cat(fourcc('sfbk'), infoList, sdtaList, pdtaList);
  const riff = cat(fourcc('RIFF'), u32(riffBody.length), riffBody);
  const buf = new ArrayBuffer(riff.length);
  new Uint8Array(buf).set(riff);
  return buf;
}

function sineSampleBytes() {
  const d = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const v = Math.round(Math.sin((i / SAMPLE_COUNT) * Math.PI * 2) * 0.8 * 32767);
    d.push(...i16(v));
  }
  return d;
}

export function buildBadSf2() {
  // Not a valid SF2 — wrong magic
  const bytes = [0x00, 0x01, 0x02, 0x03];
  return new Uint8Array(bytes).buffer;
}

/**
 * Parameterized single-preset font for FontAudition tests: one preset
 * (bank/program) -> one instrument -> one full-range zone -> one sample.
 * The knobs express the real-world failure modes the recommender must
 * catch: `silent` (all-zero PCM), `rootKey` off by octaves (wrong-register
 * rumble), `loop:false` + tiny `seconds` (one-shot click = the
 * percussion-only signature), narrow key/vel ranges.
 *
 * `toneHz` is snapped to an integer sample period so the loop is click-free
 * and the rendered pitch is exact: played at `rootKey`, the note sounds at
 * ~sampleRate/period Hz.
 */
export function buildAuditionSf2({
  name = 'AuditionFont',
  bank = 0,
  program = 0,
  rootKey = 60,
  toneHz = 261.63,
  seconds = 0.6,
  sampleRate = 44100,
  loop = true,
  silent = false,
  amp = 0.8,
  keyRange = [0, 127],
  velRange = [0, 127],
} = {}) {
  const period = Math.max(2, Math.round(sampleRate / toneHz));
  const count = Math.max(period * 4, Math.round(sampleRate * seconds));
  const pcm = [];
  for (let i = 0; i < count; i++) {
    const v = silent ? 0 : Math.round(Math.sin((2 * Math.PI * i) / period) * amp * 32767);
    pcm.push(...i16(v));
  }
  const loopStart = period * 2;
  const loopEnd = period * Math.max(3, Math.floor((count - 2) / period));
  const smplChunk = cat(fourcc('smpl'), u32(pcm.length), pcm);

  let inamRaw = cat(fourcc('INAM'), u32(name.length + 1), str(name, name.length + 1));
  if (inamRaw.length & 1) inamRaw.push(0);
  const infoBody = cat(fourcc('INFO'), inamRaw);
  const infoList = cat(fourcc('LIST'), u32(infoBody.length), infoBody);
  const sdtaBody = cat(fourcc('sdta'), smplChunk);
  const sdtaList = cat(fourcc('LIST'), u32(sdtaBody.length), sdtaBody);

  const phdrData = cat(
    str('P', 20), u16(program), u16(bank), u16(0), u32(0), u32(0), u32(0),
    str('EOP', 20), u16(0), u16(0), u16(1), u32(0), u32(0), u32(0),
  );
  const phdrChunk = cat(fourcc('phdr'), u32(phdrData.length), phdrData);
  const pbagChunk = cat(fourcc('pbag'), u32(4), u16(0), u16(0));
  const pmodChunk = cat(fourcc('pmod'), u32(10), new Array(10).fill(0));
  const pgenChunk = cat(fourcc('pgen'), u32(4), u16(41), u16(0)); // instrument 0
  const instData = cat(str('I', 20), u16(0), str('EOI', 20), u16(1));
  const instChunk = cat(fourcc('inst'), u32(instData.length), instData);
  const ibagChunk = cat(fourcc('ibag'), u32(4), u16(0), u16(0));
  const imodChunk = cat(fourcc('imod'), u32(10), new Array(10).fill(0));
  const igenData = cat(
    u16(43), u16(keyRange[0] | (keyRange[1] << 8)), // keyRange
    u16(44), u16(velRange[0] | (velRange[1] << 8)), // velRange
    u16(54), u16(loop ? 1 : 0),                     // sampleModes
    u16(53), u16(0),                                // sampleID (must stay last)
  );
  const igenChunk = cat(fourcc('igen'), u32(igenData.length), igenData);
  const shdrData = cat(
    str('S', 20),
    u32(0), u32(count),
    u32(loopStart), u32(loopEnd),
    u32(sampleRate),
    i8v(rootKey), i8v(0),
    u16(0), u16(0),
    str('EOS', 20), u32(0), u32(0), u32(0), u32(0), u32(44100), i8v(0), i8v(0), u16(0), u16(0),
  );
  const shdrChunk = cat(fourcc('shdr'), u32(shdrData.length), shdrData);

  const pdtaBody = cat(fourcc('pdta'), phdrChunk, pbagChunk, pmodChunk, pgenChunk, instChunk, ibagChunk, imodChunk, igenChunk, shdrChunk);
  const pdtaList = cat(fourcc('LIST'), u32(pdtaBody.length), pdtaBody);
  const riffBody = cat(fourcc('sfbk'), infoList, sdtaList, pdtaList);
  const riff = cat(fourcc('RIFF'), u32(riffBody.length), riffBody);
  const buf = new ArrayBuffer(riff.length);
  new Uint8Array(buf).set(riff);
  return buf;
}