# Audio session identity and lyric evidence

`src/audio/AudioSessionIdentity.js` owns the interpretation and publication of an audio session's display identity and admitted lyric evidence. `loadAudioFiles` in `main.js` remains the lifecycle owner.

| Operation | Inputs and effect | Consumers |
| --- | --- | --- |
| `resolveAudioIdentity` | Reads the file's bytes; merges source metadata over tags and filename fallback; observes the load's abort signal after the read. Resolves independently of lyric lookup. | Loader and optional lyric lookup. |
| `sessionSongName` | Reads source title, resolved title, source filename, then explicit fallback. Returns a string without changing the session. | Prepared-song name, Complete, recording finalization. |
| `adoptAudioSessionLyrics` | Requires the owning load's `canUpdatePrepared` gate and receives its generation, current preference, active data and simulation. Publishes metadata, then records a frozen lyric admission and invokes the owning BiomeManager at the recorded heard time. | Live BiomeManager and the same timeline data reused for seek, replay and export. |
| `adoptAudioSessionAnalysis` | Applies full analysis to the existing data object while retaining source identity, filename and the exact lyric history/array references. | The existing full-analysis live handoff. |

Selection ownership is deliberately different from active-session ownership. A remains eligible while a newly selected B is downloading, including when B fails or is canceled. `main.js` supplies the existing gate that recognizes A's active data object. Actual handoff aborts A's load signal; stale results then fail the gate before publication. The same gate still protects cache writes in `main.js`.

The module owns no event listeners, network requests, timers, audio nodes, canvases or workers. It adds no teardown hook: the loader retains cancellation and discards its session references at retirement. The recorded admissions remain on timeline data for reconstruction. BiomeManager remains responsible for applying each generation/revision once and preventing expired hints from replaying.

Call order stays in `main.js`: local identity starts alongside analysis, lyric lookup follows that identity, the existing startup grace remains bounded, full-analysis music-history capture precedes the identity-preserving merge, and the existing live handoff follows it. Cache publication and promise settlement stay at their original sites. Disabled lyrics still allow metadata to publish.

Recording finalization snapshots `sessionSongName(recordingData, lastSongName)` before awaiting `recorder.stop()`. A subsequent selection therefore cannot rename the recording being saved. Complete continues its existing extension trimming; the export formatter retains its existing filename sanitization. The source filename stays on timeline data even if authoritative identity resolution fails.

This boundary changes no presentation policy, director consumers or actor visibility. It introduces one static module import whose dependencies were already loaded by `main.js`. Staging copies the source tree; runtime import and fetched-byte equivalence still require browser validation after integration.
