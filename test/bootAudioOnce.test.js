// `bootAudio()` must make every caller wait for the SAME start-up attempt.
//
// The subtlety these tests exist for is the ORDER of its two guards.
// `bootAudioOnce` assigns `audioEngine` before it awaits `resume()`, so
// `audioEngine` is truthy for the whole of that window. Checking it first
// therefore returns early against a context that has not resumed -- which is
// precisely the bug the in-flight promise was added to close, so a version
// that checks `audioEngine` first has an unreachable fix and behaves exactly
// as it did before. That shipped once; hence this file.
//
// The window is reachable rather than theoretical: `unlockAudio()` starts a
// boot from a user gesture and discards the promise, and a small loopback
// download can finish long before a slow `resume()` does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Only the wrapper is under test; `bootAudioOnce` is stubbed so the real
// AudioContext never has to exist. Extracting by source range is the same
// technique test/audioLoadLifecycle.test.js uses on loadAudioFiles.
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const source = main.slice(
  main.indexOf('let bootAudioInFlight = null;'),
  main.indexOf('async function bootAudioOnce('),
);

/**
 * A harness whose `bootAudioOnce` mimics the real sequencing: it publishes
 * `audioEngine` immediately and only then awaits a resume the test controls.
 */
function harness() {
  let releaseResume;
  const resumed = new Promise((resolve, reject) => {
    releaseResume = { ok: () => resolve(true), fail: () => reject(new Error('Audio is blocked')) };
  });
  let starts = 0;

  const context = vm.createContext({
    audioEngine: null,
    async bootAudioOnce() {
      starts++;
      context.audioEngine = { name: 'engine' }; // assigned BEFORE the await
      try {
        await resumed;
      } catch (err) {
        context.audioEngine = null; // what the real one does on a failed resume
        throw err;
      }
    },
  });
  vm.runInContext(source, context);
  return { context, resume: () => releaseResume, get starts() { return starts; } };
}

/** Lets pending microtasks run, so "did it resolve early?" is answerable. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a second caller during a slow resume waits instead of returning early', async () => {
  const h = harness();
  let secondDone = false;

  h.context.bootAudio(); // the gesture's fire-and-forget unlock
  const second = h.context.bootAudio().then(() => { secondDone = true; });

  await settle();
  // audioEngine is already truthy here, which is the whole trap: a guard
  // order of `if (audioEngine) return` first lets this through.
  assert.ok(h.context.audioEngine, 'the engine is published before resume finishes');
  assert.equal(secondDone, false, 'the second caller must not resolve before resume does');

  h.resume().ok();
  await second;
  assert.equal(secondDone, true);
  assert.equal(h.starts, 1, 'one start-up attempt, shared');
});

test('a failed resume reaches the callers that arrived during it', async () => {
  const h = harness();
  const first = h.context.bootAudio().then(() => 'ok', (err) => err.message);
  const second = h.context.bootAudio().then(() => 'ok', (err) => err.message);

  await settle();
  h.resume().fail();

  // Both must learn it failed. Returning early would hand the second caller
  // a silent success and a null engine to decode against.
  assert.equal(await first, 'Audio is blocked');
  assert.equal(await second, 'Audio is blocked');
  assert.equal(h.context.audioEngine, null);
  assert.equal(h.starts, 1);
});

test('a later caller can retry after a failure', async () => {
  const h = harness();
  // Release the resume BEFORE awaiting: the whole point of the fix is that
  // the call does not settle until the attempt does, so awaiting first
  // would simply deadlock the test.
  const first = h.context.bootAudio().catch(() => {});
  h.resume().fail();
  await first;
  await settle();
  // The in-flight promise is cleared in a finally, so a fresh gesture is
  // able to start a new attempt rather than being wedged forever.
  await h.context.bootAudio().catch(() => {});
  assert.equal(h.starts, 2, 'a new attempt is allowed once the failed one settled');
});

test('once booted, with nothing in flight, the call is free', async () => {
  const h = harness();
  const first = h.context.bootAudio();
  h.resume().ok();
  await first;

  await h.context.bootAudio();
  // The `audioEngine` short-circuit is still correct -- it just has to come
  // second, since only "truthy AND nothing in flight" means fully booted.
  assert.equal(h.starts, 1, 'no second start-up once the engine is up');
});
