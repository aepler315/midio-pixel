// The way in for browsers with no file chooser. Start `npm start` first,
// and a music server for the browse half:
//
//   node tools/music-server.mjs <a folder with audio in it> &
//   node tools/url-load-smoke.mjs [page-url] [music-url]
//
// The interesting half of this harness is that it REPRODUCES the bug rather
// than mocking around it. A WebView with no `onShowFileChooser` turns
// `input.click()` into nothing but a focus change, and that focused input
// is why Android raises the soft keyboard -- so the patch below makes a
// real Chromium behave the same way, and the assertions are then about what
// a player actually experiences in Fermata: whether the keyboard is
// dismissed, whether the dead button is ever pressed twice, and whether
// there is a route to their music at the end of it.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const pageUrl = process.argv[2] || 'http://127.0.0.1:8080';
const musicUrl = process.argv[3] || process.env.MUSIC_URL || '';

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
let failures = 0;
const run = async (name, check) => {
  try { await check(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
};

try {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await context.route('**/soundfonts/', (route) => route.fulfill({ json: [] }));
  await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));

  // Turn every file input into a chooserless one, before any page script runs.
  await context.addInitScript(() => {
    const realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function patched() {
      if (this.type === 'file') {
        window.__deadClicks = (window.__deadClicks || 0) + 1;
        this.focus(); // all a chooserless WebView does, and the keyboard's cause
        return undefined;
      }
      return realClick.call(this);
    };
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pageUrl);
  await page.locator('#dropzone').waitFor();

  const deadClicks = () => page.evaluate(() => window.__deadClicks || 0);
  const focusedId = () => page.evaluate(() => document.activeElement?.id || null);

  await run('the URL panel stays out of the way until it is needed', async () => {
    assert.equal(await page.locator('#urlLoad').isHidden(), true);
  });

  await run('tapping the real Browse files button routes through the probe', async () => {
    // Click the BUTTON, not a coordinate on #dropzone. When this was a
    // <label> wrapping #fileInput, native label activation clicked the input
    // directly and bypassed openFilePicker(), so the primary control kept
    // producing the dead click forever -- and a dropzone-coordinate click
    // hid that completely.
    await page.locator('#browseBtn').click();
    assert.equal(await focusedId(), 'fileInput', 'the dead click should focus the input');
    assert.equal(await deadClicks(), 1);
  });

  await run('the phantom keyboard is dismissed once the probe decides', async () => {
    // Blurring the focused element is what lowers the Android IME; there is
    // no API for the keyboard itself.
    await page.waitForFunction(() => document.activeElement?.id !== 'fileInput', null, { timeout: 5000 });
    assert.notEqual(await focusedId(), 'fileInput');
    // And focus must not land in the URL field either: focusing a text
    // input raises the same keyboard, which would read as the same bug.
    assert.notEqual(await focusedId(), 'urlLoadInput',
      'the panel must not auto-focus its input when it appears unasked');
  });

  await run('the alternative is offered, with a reason', async () => {
    await page.locator('#urlLoad:not(.hidden)').waitFor({ timeout: 5000 });
    const why = await page.locator('#urlLoadWhy').textContent();
    assert.match(why, /no file chooser/i, 'the panel must say why it appeared');
  });

  await run('a second tap does not press the dead button again', async () => {
    // Clicking is what summons the keyboard, so not clicking is the fix.
    await page.locator('#browseBtn').click();
    await page.waitForTimeout(400);
    assert.equal(await deadClicks(), 1, 'the verdict is known; stop clicking');
  });

  await run('the dropzone itself routes through the probe too', async () => {
    await page.locator('#dropzone').click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(400);
    assert.equal(await deadClicks(), 1, 'still no click: the verdict is remembered');
  });

  await run('the verdict survives a reload, so the wait is paid once', async () => {
    await page.reload();
    await page.locator('#urlLoad:not(.hidden)').waitFor({ timeout: 5000 });
    assert.equal(await deadClicks(), 0, 'nothing was tapped on this load');
  });

  await run('a file:// URL is refused with the reason, not a generic error', async () => {
    await page.locator('#urlLoadInput').fill('file:///sdcard/Music/a.mp3');
    await page.locator('#urlLoadBtn').click();
    await page.waitForFunction(
      () => /cannot read file:\/\//.test(document.getElementById('urlLoadStatus')?.textContent || ''),
      null, { timeout: 5000 },
    );
  });

  await run('the mixed-content rule reads the page scheme, not the target', async () => {
    // This dev server is http, so a LAN http URL is legitimately allowed
    // here -- the rule only bites on an https page, which supermaudio.com
    // is. Exercise the real module rather than faking the page's origin.
    const verdicts = await page.evaluate(async () => {
      const m = await import('/src/net/UrlAudioSource.js');
      const https = 'https://supermaudio.com/';
      return {
        lan: m.classifyUrl('http://192.168.1.5:8088/a.mp3', https).code,
        loopback: m.classifyUrl('http://127.0.0.1:8088/a.mp3', https).code,
      };
    });
    assert.equal(verdicts.lan, 'mixed-content', 'a LAN http URL cannot be fetched from https');
    assert.equal(verdicts.loopback, 'ok', 'loopback is exempt -- the whole reason this works');
  });

  if (musicUrl) {
    await run('a folder can be browsed, and a song in it reaches the decoder', async () => {
      await page.locator('#urlLoadInput').fill(musicUrl);
      await page.locator('#urlLoadBtn').click();
      await page.locator('.urlLoadEntry').first().waitFor({ timeout: 10000 });
      const rows = await page.locator('.urlLoadEntry').count();
      assert.ok(rows > 0, 'the listing should have entries');
      // Going into a subfolder must leave a way back: browsing does not
      // touch history, so the browser's Back would leave the page.
      const folder = page.locator('.urlLoadEntry[data-kind="folder"]').first();
      if (await folder.count()) {
        await folder.click();
        await page.locator('#urlLoadCrumb .urlLoadUp').waitFor({ timeout: 10000 });
        await page.locator('#urlLoadCrumb .urlLoadUp').click();
        await page.locator('.urlLoadEntry[data-kind="folder"]').first().waitFor({ timeout: 10000 });
        // Back at the root, where there is nothing above to go up to.
        assert.equal(await page.locator('#urlLoadCrumb .urlLoadUp').count(), 0,
          'the server root should offer no Up button');
      }
      const song = page.locator('.urlLoadEntry[data-kind="file"]').first();
      if (await song.count()) {
        await song.click();
        // Either it plays or it fails to decode -- both prove the bytes got
        // from the URL all the way into the AudioContext, which is the
        // whole point. A stuck "Fetching..." would not.
        await page.waitForFunction(() => {
          const status = document.getElementById('urlLoadStatus')?.textContent || '';
          const banner = document.querySelector('.errorBanner')?.textContent || '';
          const progress = document.getElementById('progressText');
          return /decode|Reading|Analy/i.test(banner + (progress?.textContent || ''))
            || !/Fetching/.test(status);
        }, null, { timeout: 20000 });
      }
    });
    // Playing a song leaves the loader screen, and every check below needs
    // the URL field back. Reloading is how the app returns to a first-load
    // state; the stored verdict means the panel is there immediately, which
    // is what the reload check above already relies on. This sits outside
    // run() so a failing browse check still hands the rest a usable page
    // rather than three misleading "element is not visible" timeouts.
    await page.reload();
    await page.locator('#urlLoad:not(.hidden)').waitFor({ timeout: 5000 });
  } else {
    console.log('SKIP browse (pass a music-server URL as argv[3] to include it)');
  }

  await run('a listing bigger than the row cap still shows every folder', async () => {
    // Only file rows are capped. Slicing the combined list dropped folders
    // past the limit, and a dropped folder cannot be reached at all -- the
    // only advice rendered is "open a subfolder".
    await page.route(/bigdir/, (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        folders: Array.from({ length: 600 }, (_, i) => `/bigdir/f${i}/`),
        files: Array.from({ length: 900 }, (_, i) => ({ name: `s${i}.mp3`, url: `/bigdir/s${i}.mp3` })),
      }),
    }));
    await page.locator('#urlLoadInput').fill('http://127.0.0.1:9/bigdir/');
    await page.locator('#urlLoadBtn').click();
    // Wait for the Show-more button, which only an over-batch listing
    // produces -- waiting on a folder row would pass against the previous
    // listing and hide a regression.
    await page.locator('.urlLoadMore').waitFor({ timeout: 15000 });
    // ONE batched list: folders first, then songs, 500 rows at a time.
    // Folders are batched too -- an artist root with thousands of them
    // costs exactly as much to render as a flat album with thousands of
    // tracks -- but nothing is ever dropped.
    assert.equal(await page.locator('.urlLoadEntry').count(), 500, 'one batch to start');
    assert.equal(await page.locator('.urlLoadEntry[data-kind="folder"]').count(), 500,
      'folders come first');
    // Click until there is nothing left rather than a fixed number of
    // times: 1500 rows at 500 a batch is two clicks, and hard-coding three
    // just tests the harness's arithmetic.
    for (let guard = 0; guard < 20 && await page.locator('.urlLoadMore').count(); guard++) {
      await page.locator('.urlLoadMore').click();
    }
    assert.equal(await page.locator('.urlLoadEntry[data-kind="folder"]').count(), 600,
      'every folder must stay reachable');
    assert.equal(await page.locator('.urlLoadEntry[data-kind="file"]').count(), 900,
      'every song must stay reachable');
    assert.equal(await page.locator('.urlLoadMore').count(), 0,
      'nothing left to show, so no button');
    await page.unroute(/bigdir/);
  });

  await run('a flat folder past the batch size is still fully reachable', async () => {
    // The case the subfolder advice could never cover.
    await page.route(/flatdir/, (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        folders: [],
        files: Array.from({ length: 1200 }, (_, i) => ({ name: `s${i}.mp3`, url: `/flatdir/s${i}.mp3` })),
      }),
    }));
    await page.locator('#urlLoadList').evaluate((el) => { el.replaceChildren(); });
    await page.locator('#urlLoadInput').fill('http://127.0.0.1:9/flatdir/');
    await page.locator('#urlLoadBtn').click();
    await page.locator('.urlLoadMore').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.urlLoadEntry[data-kind="folder"]').count(), 0,
      'this listing has no folders at all');
    for (let guard = 0; guard < 20 && await page.locator('.urlLoadMore').count(); guard++) {
      await page.locator('.urlLoadMore').click();
    }
    assert.equal(await page.locator('.urlLoadEntry[data-kind="file"]').count(), 1200);
    await page.unroute(/flatdir/);
  });

  await run('a song link the browser would block is refused with the real reason', async () => {
    // A listing may contain absolute links; an HTML index usually does, and
    // a server started with MUSIC_HOST advertises its LAN address. Clicking
    // such a song used to fail as a CORS/connectivity error.
    const message = await page.evaluate(async () => {
      const m = await import('/src/net/UrlAudioSource.js');
      return m.classifyUrl('http://192.168.1.50:8088/a.mp3', 'https://supermaudio.com/').message;
    });
    assert.match(message, /mixed content/i);
  });

  if (musicUrl) {
    await run('a bare address submits, instead of being blocked by the browser', async () => {
      // The field was type="url", which applies native constraint validation
      // on submit -- so a bare `127.0.0.1:8099/` never reached classifyUrl(),
      // the very code that exists to prepend http:// for that shape.
      const bare = musicUrl.replace(/^https?:\/\//, '');
      await page.locator('#urlLoadList').evaluate((el) => { el.replaceChildren(); });
      await page.locator('#urlLoadInput').fill(bare);
      await page.locator('#urlLoadBtn').click();
      await page.locator('.urlLoadEntry').first().waitFor({ timeout: 10000 });
      const shown = await page.locator('#urlLoadInput').inputValue();
      assert.ok(shown.startsWith('http://'), `expected http:// to be added, got ${shown}`);
    });
  }

  await run('the picker button unlocks audio on keyboard activation too', async () => {
    // Enter/Space fires click with no pointerdown, so a pointerdown-only
    // unlock left the chooser opening un-unlocked.
    const unlocked = await page.evaluate(async () => {
      const btn = document.getElementById('browseBtn');
      let sawClick = false;
      btn.addEventListener('click', () => { sawClick = true; }, { once: true });
      btn.focus();
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      btn.click(); // what the browser synthesises for Enter on a button
      await new Promise((r) => setTimeout(r, 100));
      return sawClick;
    });
    assert.equal(unlocked, true, 'keyboard activation must reach the click handler');
  });

  // Needs a real music server, like the browse half above: it asks the server
  // for its listing and then asks for the files in it. Without one this used
  // to reach for a hard-coded 127.0.0.1:8099 and fail with "Failed to fetch"
  // wherever nothing happened to be listening there -- CI included.
  if (musicUrl) {
    await run('a listed song is always fetchable, symlink or not', async () => {
      // The listing judges a file by the name it advertises; the request path
      // must judge by the same name. A symlink `song.mp3 -> blob` was listed
      // (link name) and then 404'd (canonical target has no extension), so a
      // listing could advertise a song that never plays.
      const listing = await page.evaluate(async (base) => {
        const res = await fetch(base);
        return res.json();
      }, musicUrl);
      for (const file of (listing.files || []).slice(0, 5)) {
        const status = await page.evaluate(async (u) => (await fetch(u)).status,
          new URL(file.url, musicUrl).href);
        assert.equal(status, 200, `${file.name} is listed but not fetchable`);
      }
    });
  } else {
    console.log('SKIP a listed song is always fetchable (pass a music-server URL as argv[3] to include it)');
  }

  await run('no page errors', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
}
console.log(failures === 0 ? 'url-load smoke: OK' : `url-load smoke: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
