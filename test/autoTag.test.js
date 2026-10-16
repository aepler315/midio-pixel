// Auto-tagging writes into someone's library, so the interesting tests are
// the refusals: a query that would search for nothing, a high-scoring answer
// about a different song, a length that does not match. Writing a wrong
// artist over a right filename is the failure worth engineering against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeLucene, buildRecordingQuery, titleSimilarity, pickBest, lookupTags,
  createTagQueue, MIN_INTERVAL_MS,
} from '../src/library/AutoTag.js';

function recording(over = {}) {
  return {
    id: 'r', score: 100, title: 'Paranoid Android', length: 383000,
    'artist-credit': [{ name: 'Radiohead' }],
    releases: [{ title: 'OK Computer', date: '1997-05-21' }],
    ...over,
  };
}

function jsonFetch(body, { ok = true } = {}) {
  const calls = [];
  const fn = async (url) => { calls.push(url); return { ok, json: async () => body }; };
  fn.calls = calls;
  return fn;
}

function requestClock({ manual = false } = {}) {
  let time = 0;
  const waits = [];
  const pending = [];
  const advance = ms => {
    time += ms;
    for (const wait of pending.splice(0)) {
      if (wait.at <= time) wait.resolve();
      else pending.push(wait);
    }
  };
  return {
    now: () => time,
    sleep: ms => {
      waits.push(ms);
      if (!manual) { advance(ms); return Promise.resolve(); }
      return new Promise(resolve => pending.push({ at: time + ms, resolve }));
    },
    waits, advance,
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a title that is all Lucene syntax still makes a valid query', () => {
  assert.equal(escapeLucene('C++'), 'C\\+\\+');
  assert.equal(escapeLucene('Where?'), 'Where\\?');
  assert.equal(escapeLucene('AC/DC'), 'AC\\/DC');
  const q = buildRecordingQuery({ title: 'Where?', artist: 'AC/DC' });
  assert.equal(q, 'recording:"Where\\?" AND artist:"AC\\/DC"');
});

test('no title means no query at all', () => {
  // The alternative is searching for the empty string, which returns
  // whatever MusicBrainz considers popular -- the single worst thing to
  // write into a library.
  assert.equal(buildRecordingQuery({ title: '' }), null);
  assert.equal(buildRecordingQuery({ title: null, artist: 'Someone' }), null);
  assert.equal(buildRecordingQuery({}), null);
});

test('a known duration narrows the query to a window around it', () => {
  const q = buildRecordingQuery({ title: 'Song', durationSec: 200 });
  assert.match(q, /dur:\[192000 TO 208000\]/);
  // A short track must not produce a negative lower bound.
  assert.match(buildRecordingQuery({ title: 'Song', durationSec: 2 }), /dur:\[0 TO 10000\]/);
  assert.ok(!buildRecordingQuery({ title: 'Song' }).includes('dur:'));
});

test('a confident answer about a different song is refused', () => {
  const wrong = recording({ title: 'Karma Police', score: 100 });
  // MusicBrainz scores our QUERY against its index; this checks its ANSWER
  // against what we asked about.
  assert.equal(pickBest([wrong], { title: 'Paranoid Android' }), null);
  assert.equal(titleSimilarity('OK Computer', 'ok computer'), 1);
  // Half the words in common is not the same song.
  assert.ok(titleSimilarity('Paranoid Android', 'Paranoid') <= 0.5);
  // But a release qualifier is noise on one side, not a difference: this is
  // the comparison that a plain word-set measure gets backwards, scoring
  // the remaster BELOW the wrong song above.
  assert.equal(titleSimilarity('Song', 'Song (2011 Remaster)'), 1);
  assert.ok(pickBest([recording({ title: 'Paranoid Android (Live)' })], { title: 'Paranoid Android' }));
});

test('a low-scoring answer is refused however well the title matches', () => {
  assert.equal(pickBest([recording({ score: 40 })], { title: 'Paranoid Android' }), null);
  assert.ok(pickBest([recording({ score: 95 })], { title: 'Paranoid Android' }));
});

test('a candidate of the wrong length is refused when the length is known', () => {
  const rec = recording({ length: 120000 });
  assert.equal(pickBest([rec], { title: 'Paranoid Android', durationSec: 383 }), null);
  // Masters differ by a second or two; that must still match.
  assert.ok(pickBest([rec], { title: 'Paranoid Android', durationSec: 122 }));
  // An unknown length on either side cannot disqualify anything.
  assert.ok(pickBest([recording({ length: null })], { title: 'Paranoid Android', durationSec: 383 }));
  assert.ok(pickBest([rec], { title: 'Paranoid Android' }));
});

test('the earliest release wins, not whichever came back first', () => {
  const rec = recording({
    releases: [
      { title: 'Greatest Hits', date: '2008-01-01' },
      { title: 'OK Computer', date: '1997-05-21' },
      { title: 'Undated Comp' },
    ],
  });
  const tag = pickBest([rec], { title: 'Paranoid Android' });
  assert.equal(tag.album, 'OK Computer');
  assert.equal(tag.year, 1997);
  assert.equal(tag.tagSource, 'auto');
});

test('a studio track is not filed under whichever DJ mix listed it first', () => {
  // This is what the real endpoint returns: compilations outnumber the
  // original album AND are dated earlier than some reissues, so "earliest
  // release" on its own picks the mix CD.
  const rec = recording({
    'first-release-date': '1992-11-09',
    releases: [
      { title: 'At the Controls', date: '2006-03-27', 'release-group': { 'primary-type': 'Album', 'secondary-types': ['Compilation', 'DJ-mix'] } },
      { title: 'Selected Ambient Works 85-92', date: '2008-01-01', 'release-group': { 'primary-type': 'Album' } },
    ],
  });
  const tag = pickBest([rec], { title: 'Paranoid Android' });
  assert.equal(tag.album, 'Selected Ambient Works 85-92');
  // And the year is the recording's own first release, not the reissue we
  // happened to name as the album.
  assert.equal(tag.year, 1992);
});

test('when every release is a compilation, the earliest compilation is still an answer', () => {
  const comp = (title, date) => ({ title, date, 'release-group': { 'secondary-types': ['Compilation'] } });
  const tag = pickBest([recording({ 'first-release-date': null, releases: [comp('Later Mix', '2010-01-01'), comp('Earlier Mix', '2006-01-01')] })], { title: 'Paranoid Android' });
  assert.equal(tag.album, 'Earlier Mix');
  assert.equal(tag.year, 2006);
  // No releases at all is a null album, not a crash.
  assert.equal(pickBest([recording({ releases: [] })], { title: 'Paranoid Android' }).album, null);
});

test('a credited artist keeps the join phrase the release prints', () => {
  const rec = recording({
    'artist-credit': [{ name: 'Run The Jewels', joinphrase: ' feat. ' }, { name: 'Zack de la Rocha' }],
  });
  assert.equal(pickBest([rec], { title: 'Paranoid Android' }).artist, 'Run The Jewels feat. Zack de la Rocha');
  // No credit at all is a null artist, not an empty string pretending to be one.
  assert.equal(pickBest([recording({ 'artist-credit': [] })], { title: 'Paranoid Android' }).artist, null);
});

test('a filename that split the artist and title wrongly gets a second chance', async () => {
  let call = 0;
  const fetchFn = async (url) => {
    call++;
    // The first attempt constrains the artist and finds nothing; the second
    // drops it. A bad "Artist - Title" split is the common way a filename
    // lies, and this is the cheapest way to survive it.
    const body = call === 1 ? { recordings: [] } : { recordings: [recording()] };
    return { ok: true, json: async () => body, url };
  };
  const tag = await lookupTags({ artist: 'Track 04', title: 'Paranoid Android' }, fetchFn, requestClock());
  assert.equal(call, 2);
  assert.equal(tag.artist, 'Radiohead');
});

test('with no artist to drop there is only ever one request', async () => {
  const fetchFn = jsonFetch({ recordings: [] });
  assert.equal(await lookupTags({ title: 'Paranoid Android' }, fetchFn, requestClock()), null);
  assert.equal(fetchFn.calls.length, 1);
});

test('every network failure is a null tag, never a throw', async () => {
  const boom = async () => { throw new Error('offline'); };
  const clock = requestClock();
  assert.equal(await lookupTags({ title: 'Song' }, boom, clock), null);
  assert.equal(await lookupTags({ title: 'Song' }, jsonFetch(null, { ok: false }), clock), null);
  assert.equal(await lookupTags({ title: 'Song' }, async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }), clock), null);
  assert.equal(await lookupTags({ title: 'Song' }, null), null);
  assert.equal(await lookupTags({ title: null }, jsonFetch({})), null);
});

test('the actual queue spaces every artist fallback and the next track attempt', async (t) => {
  const clock = requestClock();
  const starts = [];
  const results = [];
  const queue = createTagQueue({
    ...clock,
    fetchFn: async url => {
      starts.push(clock.now());
      clock.advance(50);
      const query = new URL(url).searchParams.get('query');
      return { ok: true, json: async () => ({ recordings: query.includes('artist:') ? [] : [recording()] }) };
    },
  });
  const tagged = await queue.run([
    { artist: 'Wrong artist', title: 'Paranoid Android' },
    { artist: 'Another wrong artist', title: 'Paranoid Android' },
  ], { onResult: (track, patch) => results.push(patch) });
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= MIN_INTERVAL_MS, `gap ${i}: ${starts[i] - starts[i - 1]}`);
  }
  assert.equal(tagged, 2);
  assert.deepEqual(results.map(row => row.artist), ['Radiohead', 'Radiohead']);
  t.diagnostic(JSON.stringify({ attempts: starts, floor: MIN_INTERVAL_MS }));
});

test('an actual slow fetch pays the interval for fallback and the next track', async (t) => {
  const clock = requestClock();
  const starts = [];
  const queue = createTagQueue({
    ...clock,
    fetchFn: async () => {
      starts.push(clock.now());
      clock.advance(MIN_INTERVAL_MS * 3);
      return { ok: true, json: async () => ({ recordings: [] }) };
    },
  });
  await queue.run([{ artist: 'Wrong', title: 'Song' }, { title: 'Another Song' }]);
  assert.deepEqual(clock.waits, []);
  assert.deepEqual(starts, [0, MIN_INTERVAL_MS * 3, MIN_INTERVAL_MS * 6]);
  t.diagnostic(JSON.stringify({ attempts: starts, waits: clock.waits }));
});

test('independent queues and direct lookups share the MusicBrainz attempt floor', async (t) => {
  const clock = requestClock();
  const attempts = [];
  const fetchFn = async url => {
    attempts.push({ at: clock.now(), query: new URL(url).searchParams.get('query') });
    return { ok: true, json: async () => ({ recordings: [] }) };
  };
  const first = createTagQueue({ ...clock, fetchFn });
  const second = createTagQueue({ ...clock, fetchFn: async (...args) => fetchFn(...args) });
  await Promise.all([
    first.run([{ artist: 'Wrong', title: 'First song' }, { title: 'Third song' }]),
    second.run([{ artist: 'Wrong', title: 'Second song' }]),
    lookupTags({ title: 'Direct song' }, fetchFn, clock),
  ]);
  assert.equal(attempts.length, 6);
  for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i].at - attempts[i - 1].at >= MIN_INTERVAL_MS,
    `shared attempts ${i - 1}/${i}: ${JSON.stringify(attempts)}`);
  t.diagnostic(JSON.stringify({ attempts, floor: MIN_INTERVAL_MS }));
});

test('HTTP-error fallback attempts use the same request floor', async (t) => {
  const clock = requestClock();
  const attempts = [];
  const fetchFn = async () => {
    attempts.push(clock.now());
    if (attempts.length === 1) throw new Error('synthetic offline');
    return { ok: true, json: async () => ({ recordings: [recording()] }) };
  };
  const patch = await lookupTags({ title: 'Paranoid Android', artist: 'Wrong' }, fetchFn, clock);
  assert.equal(patch.artist, 'Radiohead');
  assert.deepEqual(attempts, [0, MIN_INTERVAL_MS]);
  t.diagnostic(JSON.stringify({ attempts }));
});

test('aborting a waiting fallback releases its reservation without a stale request or extra slot', async (t) => {
  const clock = requestClock({ manual: true });
  const attempts = [];
  const fetchFn = async url => {
    attempts.push({ at: clock.now(), query: new URL(url).searchParams.get('query') });
    return { ok: true, json: async () => ({ recordings: [] }) };
  };
  const controller = new AbortController();
  const results = [];
  const first = createTagQueue({ ...clock, fetchFn }).run([
    { artist: 'Wrong', title: 'Canceled song' },
  ], { signal: controller.signal, onResult: (track, patch) => results.push(patch) });
  await settle();
  assert.equal(attempts.length, 1, 'the fallback must be waiting, not already sent');
  const next = createTagQueue({ ...clock, fetchFn }).run([{ title: 'Next song' }]);
  controller.abort();
  assert.equal(await first, 0, 'cancellation should resolve without advancing the clock');
  await settle();
  clock.advance(MIN_INTERVAL_MS);
  await next;
  await settle();
  assert.deepEqual(results, [], 'an aborted lookup must not publish stale results');
  assert.deepEqual(attempts.map(item => item.at), [0, MIN_INTERVAL_MS]);
  assert.match(attempts[1].query, /Next song/);
  t.diagnostic(JSON.stringify({ attempts, canceledFallback: true }));
});

test('an already aborted direct lookup makes no HTTP attempt', async () => {
  const controller = new AbortController(); controller.abort();
  const fetchFn = jsonFetch({ recordings: [recording()] });
  assert.equal(await lookupTags({ title: 'Paranoid Android' }, fetchFn, { ...requestClock(), signal: controller.signal }), null);
  assert.equal(fetchFn.calls.length, 0);
});

test('canceling an active fetch aborts its request signal and suppresses its result', async () => {
  const controller = new AbortController();
  const clock = requestClock();
  let requestSignal, rejectFetch;
  const results = [];
  const queue = createTagQueue({ ...clock, fetchFn: async (url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve, reject) => {
      rejectFetch = reject;
      options.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
    });
  } });
  const run = queue.run([{ title: 'Paranoid Android' }], {
    signal: controller.signal, onResult: (track, patch) => results.push(patch),
  });
  await settle();
  controller.abort();
  try {
    assert.equal(requestSignal.aborted, true);
    assert.equal(await run, 0);
    assert.deepEqual(results, []);
  } finally { rejectFetch?.(new Error('fixture cleanup')); await run; }
});

test('aborting stops the queue rather than draining it quietly', async () => {
  const signal = { aborted: false };
  let seen = 0;
  const queue = createTagQueue({
    now: () => 0,
    sleep: async () => {},
    lookup: async () => { seen++; if (seen === 2) signal.aborted = true; return null; },
  });
  const tagged = await queue.run([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], { signal });
  assert.equal(seen, 2);
  assert.equal(tagged, 0);
});

test('results are reported one at a time, as they land', async () => {
  const results = [];
  const progress = [];
  const queue = createTagQueue({
    now: () => 0,
    sleep: async () => {},
    lookup: async ({ title }) => (title === 'b' ? null : { title: title.toUpperCase(), tagSource: 'auto' }),
  });
  const tagged = await queue.run([{ name: 'a' }, { name: 'b' }], {
    onResult: (track, patch) => results.push([track.name, patch?.title ?? null]),
    onProgress: (done, total, ok) => progress.push([done, total, ok]),
  });
  assert.equal(tagged, 1);
  assert.deepEqual(results, [['a', 'A'], ['b', null]]);
  assert.deepEqual(progress, [[1, 2, 1], [2, 2, 1]]);
});
