// SoundFont 2 (SF2) parser. Parses RIFF/sfbk structure, extracts sample data
// and preset/zone definitions with global-zone folding and preset×instrument
// range intersection. Converts timecent/centibel envelope generators to
// seconds/linear for direct use by the synth.
//
// parseSf2(buffer, fallbackName) → {
//   name: string,
//   samples: [{ name, start, end, loopStart, loopEnd, sampleRate, rootKey, fineTune, link, type }],
//   sampleData: Int16Array,            // raw PCM from sdta/smpl
//   presets: Map(bank*128+prog → { name, bank, program, zones: [
//     { loKey, hiKey, loVel, hiVel, sampleIndex,
//       attack, hold, decay, sustain, release,  // seconds / linear
//       loopMode, pan, fineTune, coarseTune, attenuation },
//   ]}),
// }

const RIFF = 'RIFF';
const SFBK = 'sfbk';
const LIST = 'LIST';
const INFO = 'INFO';
const SDTA = 'sdta';
const PDTA = 'pdta';

// Generator opcodes (SF2 spec §8.1.3)
const GEN = {
  PAN: 17,
  DELAY_VOL: 33,       // timecents — delay before envelope starts
  ATTACK_VOL: 34,      // timecents
  HOLD_VOL: 35,        // timecents
  DECAY_VOL: 36,       // timecents
  SUSTAIN_VOL: 37,     // centibels (sustain LEVEL below peak)
  RELEASE_VOL: 38,     // timecents
  KEY_TO_VOL_HOLD: 39,
  KEY_TO_VOL_DECAY: 40,
  INSTRUMENT: 41,      // preset zones → instrument index
  KEY_RANGE: 43,       // lo/hi byte pair
  VEL_RANGE: 44,       // lo/hi byte pair
  INITIAL_ATTENUATION: 48, // 0.1 dB units
  COARSE_TUNE: 51,     // semitones
  FINE_TUNE: 52,       // cents
  SAMPLE_ID: 53,       // instrument zones → sample header index
  SAMPLE_MODES: 54,    // 0=none, 1=loop
};

// --- timecent / centibel conversions ---
function tcToSec(tc) {
  if (tc <= -32768) return 0;
  return Math.pow(2, tc / 1200);
}
function cbToLinear(cb) {
  // centibels below peak → linear gain (0 cb = full, -100 cb = -10 dB ≈ 0.316)
  if (cb <= -32768) return 0;
  return Math.pow(10, cb / 200); // cb/10 = dB → 10^(-dB/20) = 10^(-cb/200)
}

// --- RIFF utilities ---
function fourcc(dv, off) {
  return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
}
function u16(dv, off) { return dv.getUint16(off, true); }
function u32(dv, off) { return dv.getUint32(off, true); }
function i16(dv, off) { return dv.getInt16(off, true); }
function i32(dv, off) { return dv.getInt32(off, true); }

function readName(u8, off, len) {
  // Null-terminated ASCII, padded to field length
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = u8[off + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} [fallbackName]
 * @returns {{name:string, samples:Array, sampleData:Int16Array, presets:Map}}
 */
export function parseSf2(buffer, fallbackName = 'Unknown SoundFont') {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  if (fourcc(dv, 0) !== RIFF || fourcc(dv, 8) !== SFBK) {
    throw new Error('sf2: not a valid SF2 RIFF file');
  }

  // Walk top-level LIST chunks starting at offset 12
  let off = 12;
  let fontName = fallbackName;
  let sampleData = null;
  let pdta = null;

  while (off + 8 <= buffer.byteLength) {
    const tag = fourcc(dv, off);
    const size = u32(dv, off + 4);
    if (tag === LIST && off + 12 <= buffer.byteLength) {
      const listType = fourcc(dv, off + 8);
      const dataStart = off + 12;

      if (listType === INFO) {
        const n = parseInfoList(dv, u8, dataStart, size - 4);
        if (n) fontName = n;
      } else if (listType === SDTA) {
        sampleData = parseSdtaList(dv, dataStart, size - 4);
      } else if (listType === PDTA) {
        pdta = parsePdtaList(dv, u8, dataStart, size - 4);
      }
    }
    off += 8 + size + (size & 1); // word-aligned
  }

  if (!sampleData) throw new Error('sf2: no sample data (sdta/smpl) found');
  if (!pdta) throw new Error('sf2: no preset data (pdta) found');

  const presets = buildPresets(pdta, fontName);

  return {
    name: fontName,
    samples: pdta.shdr,
    sampleData,
    presets,
  };
}

// --- INFO list: find INAM (font name) ---
function parseInfoList(dv, u8, start, size) {
  const end = start + size;
  let off = start;
  while (off + 8 <= end) {
    const tag = fourcc(dv, off);
    const csz = u32(dv, off + 4);
    if (tag === 'INAM') {
      return readName(u8, off + 8, csz);
    }
    off += 8 + csz + (csz & 1);
  }
  return null;
}

// --- sdta list: find smpl chunk (raw 16-bit PCM) ---
function parseSdtaList(dv, start, size) {
  const end = start + size;
  let off = start;
  while (off + 8 <= end) {
    const tag = fourcc(dv, off);
    const csz = u32(dv, off + 4);
    if (tag === 'smpl') {
      // 16-bit signed samples → Int16Array view over the chunk
      return new Int16Array(dv.buffer, off + 8, csz / 2);
    }
    off += 8 + csz + (csz & 1);
  }
  return null;
}

// --- pdta list: parse phdr, pbag, pgen, inst, ibag, igen, shdr ---
function parsePdtaList(dv, u8, start, size) {
  const end = start + size;
  let off = start;
  const chunks = {};
  while (off + 8 <= end) {
    const tag = fourcc(dv, off);
    const csz = u32(dv, off + 4);
    const dataOff = off + 8;
    chunks[tag] = { dataOff, size: csz };
    off += 8 + csz + (csz & 1);
  }

  return {
    phdr: parsePhdr(dv, u8, chunks.phdr),
    pbag: parsePbag(dv, chunks.pbag),
    pgen: parseGen(dv, chunks.pgen),
    inst: parseInst(dv, u8, chunks.inst),
    ibag: parsePbag(dv, chunks.ibag),
    igen: parseGen(dv, chunks.igen),
    shdr: parseShdr(dv, u8, chunks.shdr),
  };
}

// phdr: 38 bytes per preset
function parsePhdr(dv, u8, chunk) {
  if (!chunk) return [];
  const items = [];
  const n = Math.floor(chunk.size / 38);
  for (let i = 0; i < n; i++) {
    const o = chunk.dataOff + i * 38;
    items.push({
      name: readName(u8, o, 20),
      preset: u16(dv, o + 20),
      bank: u16(dv, o + 22),
      bagNdx: u16(dv, o + 24),
    });
  }
  return items;
}

// pbag/ibag: 4 bytes per entry (genNdx, modNdx)
function parsePbag(dv, chunk) {
  if (!chunk) return [];
  const items = [];
  const n = Math.floor(chunk.size / 4);
  for (let i = 0; i < n; i++) {
    const o = chunk.dataOff + i * 4;
    items.push({ genNdx: u16(dv, o), modNdx: u16(dv, o + 2) });
  }
  return items;
}

// pgen/igen: 4 bytes per entry (genOper: uint16, val: uint16)
function parseGen(dv, chunk) {
  if (!chunk) return [];
  const items = [];
  const n = Math.floor(chunk.size / 4);
  for (let i = 0; i < n; i++) {
    const o = chunk.dataOff + i * 4;
    items.push({ oper: u16(dv, o), val: u16(dv, o + 2), valS: i16(dv, o + 2) });
  }
  return items;
}

// inst: 22 bytes per instrument (name[20] + bagNdx: uint16)
function parseInst(dv, u8, chunk) {
  if (!chunk) return [];
  const items = [];
  const n = Math.floor(chunk.size / 22);
  for (let i = 0; i < n; i++) {
    const o = chunk.dataOff + i * 22;
    items.push({ name: readName(u8, o, 20), bagNdx: u16(dv, o + 20) });
  }
  return items;
}

// shdr: 46 bytes per sample header
function parseShdr(dv, u8, chunk) {
  if (!chunk) return [];
  const items = [];
  const n = Math.floor(chunk.size / 46);
  for (let i = 0; i < n; i++) {
    const o = chunk.dataOff + i * 46;
    items.push({
      name: readName(u8, o, 20),
      start: u32(dv, o + 20),
      end: u32(dv, o + 24),
      loopStart: u32(dv, o + 28),
      loopEnd: u32(dv, o + 32),
      sampleRate: u32(dv, o + 36),
      rootKey: u8[o + 40],
      fineTune: dv.getInt8(o + 41), // int8 correction (cents), NOT int16 — byte 42 is sampleLink
      link: u16(dv, o + 42),
      type: u16(dv, o + 44),
    });
  }
  return items;
}

// --- Generator helpers ---

// Collect generators for a bag range into a flat object.
function collectGens(gens, start, end) {
  const out = {};
  for (let i = start; i < end; i++) {
    const g = gens[i];
    if (!g) break;
    if (g.oper === GEN.KEY_RANGE) {
      out.loKey = g.val & 0xff;
      out.hiKey = (g.val >> 8) & 0xff;
    } else if (g.oper === GEN.VEL_RANGE) {
      out.loVel = g.val & 0xff;
      out.hiVel = (g.val >> 8) & 0xff;
    } else if (g.oper === GEN.INSTRUMENT) {
      out.instrument = g.val;
    } else if (g.oper === GEN.SAMPLE_ID) {
      out.sampleIndex = g.val;
    } else if (g.oper === GEN.PAN) {
      out.pan = g.valS / 500; // 0.1% → -1..1
    } else if (g.oper === GEN.DELAY_VOL) {
      out.delayTc = g.valS;
    } else if (g.oper === GEN.ATTACK_VOL) {
      out.attackTc = g.valS;
    } else if (g.oper === GEN.HOLD_VOL) {
      out.holdTc = g.valS;
    } else if (g.oper === GEN.DECAY_VOL) {
      out.decayTc = g.valS;
    } else if (g.oper === GEN.SUSTAIN_VOL) {
      out.sustainCb = g.valS;
    } else if (g.oper === GEN.RELEASE_VOL) {
      out.releaseTc = g.valS;
    } else if (g.oper === GEN.KEY_TO_VOL_HOLD) {
      out.keyToHold = g.valS;
    } else if (g.oper === GEN.KEY_TO_VOL_DECAY) {
      out.keyToDecay = g.valS;
    } else if (g.oper === GEN.SAMPLE_MODES) {
      out.loopMode = g.val & 1;
    } else if (g.oper === GEN.FINE_TUNE) {
      out.fineTune = g.valS;
    } else if (g.oper === GEN.COARSE_TUNE) {
      out.coarseTune = g.valS;
    } else if (g.oper === GEN.INITIAL_ATTENUATION) {
      out.attenuationCb = g.valS; // 0.1 dB units → divide by 10 for dB
    }
  }
  return out;
}

// Build preset→zone map with global-zone folding + instrument range intersection.
function buildPresets(pdta, fontName) {
  const { phdr, pbag, pgen, inst, ibag, igen, shdr } = pdta;
  const presets = new Map();

  for (let p = 0; p < phdr.length - 1; p++) {
    // Last phdr entry is a sentinel; iterate to phdr.length - 1
    const ph = phdr[p];
    const bagStart = ph.bagNdx;
    const bagEnd = phdr[p + 1] ? phdr[p + 1].bagNdx : pbag.length;
    const key = ph.bank * 128 + ph.preset;

    // Walk preset bags: collect global gens, then per-zone gens
    let presetGlobal = null;
    const presetZones = [];

    for (let b = bagStart; b < bagEnd; b++) {
      const bag = pbag[b];
      const gStart = bag.genNdx;
      const gEnd = (pbag[b + 1] && pbag[b + 1].genNdx !== undefined)
        ? pbag[b + 1].genNdx
        : pgen.length;
      const gens = collectGens(pgen, gStart, gEnd);

      if (gens.instrument === undefined) {
        // Global zone — fold into presetGlobal
        if (!presetGlobal) presetGlobal = {};
        Object.assign(presetGlobal, gens);
      } else {
        // Specific zone — merge global + local
        const merged = { ...(presetGlobal || {}), ...gens };
        // Defaults
        if (merged.loKey === undefined) merged.loKey = 0;
        if (merged.hiKey === undefined) merged.hiKey = 127;
        if (merged.loVel === undefined) merged.loVel = 0;
        if (merged.hiVel === undefined) merged.hiVel = 127;
        presetZones.push(merged);
      }
    }

    // For each preset zone, expand into instrument zones
    const zones = [];
    for (const pz of presetZones) {
      const instIdx = pz.instrument;
      const instrument = inst[instIdx];
      if (!instrument) continue;

      const iBagStart = instrument.bagNdx;
      const iBagEnd = (inst[instIdx + 1] && inst[instIdx + 1].bagNdx !== undefined)
        ? inst[instIdx + 1].bagNdx
        : ibag.length;

      // Walk instrument bags. Two passes: first collect every zone's raw
      // generators (and which sample indices they reference), THEN build
      // the final zone list — the second pass needs to know the full set of
      // referenced samples up front to decide whether a stereo-linked
      // sample (see below) already has its partner hand-authored as its own
      // zone, or needs to be synthesized.
      let instGlobal = null;
      const rawZones = [];

      for (let b = iBagStart; b < iBagEnd; b++) {
        const bag = ibag[b];
        const gStart = bag.genNdx;
        const gEnd = (ibag[b + 1] && ibag[b + 1].genNdx !== undefined)
          ? ibag[b + 1].genNdx
          : igen.length;
        const gens = collectGens(igen, gStart, gEnd);

        if (gens.sampleIndex === undefined) {
          // Global zone for this instrument
          if (!instGlobal) instGlobal = {};
          Object.assign(instGlobal, gens);
        } else {
          // Merge: instrument global → instrument zone → preset zone
          // (preset zone values override for ranges; instrument zone for sample/envelope)
          const merged = { ...(instGlobal || {}), ...gens };

          // Range intersection
          const loKey = Math.max(pz.loKey, merged.loKey ?? 0);
          const hiKey = Math.min(pz.hiKey, merged.hiKey ?? 127);
          const loVel = Math.max(pz.loVel, merged.loVel ?? 0);
          const hiVel = Math.min(pz.hiVel, merged.hiVel ?? 127);

          if (loKey > hiKey || loVel > hiVel) continue; // no overlap

          rawZones.push({ merged, loKey, hiKey, loVel, hiVel });
        }
      }

      const referencedSamples = new Set(rawZones.map((z) => z.merged.sampleIndex));

      for (const { merged, loKey, hiKey, loVel, hiVel } of rawZones) {
        const hasExplicitPan = merged.pan !== undefined;
        let pan = merged.pan ?? 0;

        // Stereo sample-link pair (SF2 spec §7.10 sampleType: 2=rightSample,
        // 4=leftSample, ROM equivalents +0x8000). Some fonts encode a stereo
        // instrument as ONE explicit zone per side with each sample's own
        // `sampleLink` pointing at its partner, relying on the player to
        // locate and also play the linked sample — as opposed to the (also
        // common, already-handled-by-the-code-above) pattern of two
        // explicit zones each with its own PAN generator. Detect the
        // link-only pattern and synthesize the missing zone so these fonts
        // aren't silently reduced to a single channel.
        const sample = shdr[merged.sampleIndex];
        const baseType = sample ? (sample.type & 0x7fff) : 0; // strip the ROM bit
        const isStereoHalf = baseType === 2 || baseType === 4; // right | left
        if (isStereoHalf && !hasExplicitPan) pan = baseType === 4 ? -1 : 1;

        // Build zone with envelope in seconds/linear
        zones.push({
          loKey,
          hiKey,
          loVel,
          hiVel,
          sampleIndex: merged.sampleIndex,
          attack: tcToSec(merged.attackTc ?? -12000),
          hold: tcToSec(merged.holdTc ?? -12000),
          decay: tcToSec(merged.decayTc ?? -12000),
          sustain: cbToLinear(merged.sustainCb ?? 0),
          release: tcToSec(merged.releaseTc ?? -12000),
          loopMode: merged.loopMode ?? 0,
          pan,
          fineTune: merged.fineTune ?? 0,
          coarseTune: merged.coarseTune ?? 0,
          attenuation: merged.attenuationCb != null
            ? Math.pow(10, -merged.attenuationCb / 200) // 0.1 dB units → linear
            : 1,
        });

        if (isStereoHalf && sample.link !== undefined && shdr[sample.link] && !referencedSamples.has(sample.link)) {
          referencedSamples.add(sample.link); // don't pair it again within this instrument
          zones.push({
            loKey,
            hiKey,
            loVel,
            hiVel,
            sampleIndex: sample.link,
            attack: tcToSec(merged.attackTc ?? -12000),
            hold: tcToSec(merged.holdTc ?? -12000),
            decay: tcToSec(merged.decayTc ?? -12000),
            sustain: cbToLinear(merged.sustainCb ?? 0),
            release: tcToSec(merged.releaseTc ?? -12000),
            loopMode: merged.loopMode ?? 0,
            pan: baseType === 4 ? 1 : -1, // the linked partner sits on the opposite side
            fineTune: merged.fineTune ?? 0,
            coarseTune: merged.coarseTune ?? 0,
            attenuation: merged.attenuationCb != null
              ? Math.pow(10, -merged.attenuationCb / 200)
              : 1,
          });
        }
      }
    }

    presets.set(key, { name: ph.name, bank: ph.bank, program: ph.preset, zones });
  }

  return presets;
}