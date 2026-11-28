import { analyzeSongprintPCM } from './Songprint.js';
import { SongprintReducer } from './SongprintReducer.js';

// The worker asks for each successive block (and, for a phase-cancelled
// recording, for one more pass through just the strongest channel).
let reducer, phrases = false, fable = false;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      reducer = new SongprintReducer(data.rate, data.frames, data.channels);
      phrases = data.phrases === true;
      fable = data.fable !== false;
    } else {
      reducer.push(data.planes);
    }
    if (reducer.finished) {
      self.postMessage({ type: 'done', songprint: analyzeSongprintPCM(reducer.output, { phrases, fable }) });
    } else {
      self.postMessage({ type: 'read', start: reducer.framesRead, channel: reducer.singleChannel });
    }
  } catch { self.postMessage({ type: 'failed' }); }
};
