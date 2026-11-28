import { analyzeSongprintPCM } from './Songprint.js';
import { SongprintReducer } from './SongprintReducer.js';

// The worker asks for each successive block (and, for a phase-cancelled
// recording, for one more pass through just the strongest channel).
let reducer, fableInput, readers, phrases = false, fable = false;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      reducer = new SongprintReducer(data.rate, data.frames, data.channels);
      phrases = data.phrases === true;
      fable = data.fable === true;
      // The geographic stream has a 5.5 kHz ceiling. Tap the original planes
      // here to retain Fable's full 8 kHz tone range and its stereo measurement.
      fableInput = fable ? new SongprintReducer(data.rate, data.frames, Math.min(2, data.channels), { fable: true }) : null;
    } else {
      // The two measurements can choose different recovery channels (e.g.
      // a cancelled front pair and a louder rear channel). Combine reads
      // only while both their sample cursors and source channels agree.
      for (const input of readers) input.push(input.fable ? data.planes.slice(0, 2) : data.planes);
      if (readers.includes(reducer) && fableInput?.finished && fableInput.singleChannel === null
        && reducer.powers.length > 2 && fableInput.powers.every(power => power === 0)) {
        const strongest = Math.max(...reducer.powers);
        if (strongest > 0) fableInput.reread(reducer.powers.indexOf(strongest));
      }
    }
    const pending = [reducer, fableInput].filter(input => input && !input.finished);
    if (!pending.length) {
      self.postMessage({ type: 'done', songprint: analyzeSongprintPCM(reducer.output, { phrases, fable, fableInput }) });
    } else {
      const { framesRead: start, singleChannel: channel } = pending[0];
      readers = pending.filter(input => input.framesRead === start && input.singleChannel === channel);
      self.postMessage({ type: 'read', start, channel });
    }
  } catch { self.postMessage({ type: 'failed' }); }
};
