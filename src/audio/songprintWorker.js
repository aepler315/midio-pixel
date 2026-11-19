import { analyzeSongprintPCM } from './Songprint.js';
import { SongprintReducer } from './SongprintReducer.js';

// The worker asks for each successive block (and, for a phase-cancelled
// recording, for one more pass through just the strongest channel).
let reducer;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      reducer = new SongprintReducer(data.rate, data.frames, data.channels);
    } else {
      reducer.push(data.planes);
    }
    if (reducer.finished) {
      self.postMessage({ type: 'done', songprint: analyzeSongprintPCM(reducer.output) });
    } else {
      self.postMessage({ type: 'read', start: reducer.framesRead, channel: reducer.singleChannel });
    }
  } catch { self.postMessage({ type: 'failed' }); }
};
