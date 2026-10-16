# Browsers with no file chooser

Why "Browse files" opens the keyboard in Fermata, why no change to this
page can fix that, and what is offered instead.

## The symptom

Open supermaudio.com in Fermata's built-in browser, tap **Browse files**,
and the Android soft keyboard slides up. No file chooser appears. Nothing
is being typed. Tapping again does the same thing.

## The cause

A `WebView` has no file chooser of its own. When a page clicks an
`<input type="file">`, the WebView calls
`WebChromeClient.onShowFileChooser()` and the **host app** is expected to
launch a picker and hand back the chosen URIs. An app that never overrides
that method gets no chooser: the click returns, nothing opens, and the
(visually hidden) input is left as the focused element — so Android raises
the IME for it.

The keyboard is not the bug. It is the residue of a click that went
nowhere.

Fermata is such an app. In
[AndreyPavlenko/Fermata](https://github.com/AndreyPavlenko/Fermata), at
commit `7d2bd42`, `modules/web/.../FermataChromeClient.java` extends
`WebChromeClient` and overrides `onJsAlert`, `onJsConfirm`, `onJsPrompt`,
`onJsBeforeUnload`, `onShowCustomView`, `onHideCustomView`,
`onGeolocationPermissionsShowPrompt`, `onPermissionRequest` and
`onConsoleMessage`. `onShowFileChooser` is not among them, and the strings
`FileChooserParams` and `ValueCallback<Uri[]>` appear nowhere in that
repository.

## Why this is not fixable from the page

Every alternative route a page has to a local file is closed in a WebView:

| Route | Why it does not help |
| --- | --- |
| `<input type="file">` | Needs `onShowFileChooser`, which is absent. |
| `webkitdirectory` on an input | Still an `<input type="file">`; same missing chooser. |
| `showOpenFilePicker()` (File System Access) | Not implemented in Android WebView at all. |
| `fetch('file:///sdcard/...')` | An http(s) page cannot read `file://`. |
| Drag and drop | No drag gesture on a touch screen. |
| Paste a file from the clipboard | Fermata has no way to put a file on the clipboard, and the WebView clipboard does not carry audio blobs. |
| Web Share Target | Requires an installed PWA handled by Chrome; not available inside another app's WebView. |
| Reading Fermata's own media folders | They are internal Android app state. There is no API, and the WebView is not granted them. |

There is also no way to *feature-detect* the problem in advance.
`HTMLInputElement` exists, `type="file"` is supported, `.click()` resolves
without throwing, and no event fires on failure. From script, a WebView
with no chooser is indistinguishable from a player who opened a chooser and
is still looking through it.

## What the page does about it

Two things, in `src/ui/FileChooserProbe.js` and `src/net/UrlAudioSource.js`.

### 1. Detect the dead click, once, and stop repeating it

Since it cannot be feature-detected, it is detected by consequence. Opening
a real chooser is a separate activity: the page loses focus, or becomes
hidden, or gets a `change`/`cancel` event when the player is done. A
chooserless WebView produces none of those — it only focuses the input. So
the probe clicks, waits 1200ms, and then asks one question: **is our input
still the focused element?**

That last clause carries the weight. A slow chooser and a missing chooser
both produce silence; only the missing one leaves *our* input focused,
because a real chooser takes focus out of the document entirely. Without
it, every unhurried person would be told their browser is broken.

On a verdict of "absent" the input is blurred, which is what lowers the
Android IME (there is no API for the keyboard itself), and the verdict is
remembered in `localStorage`. From then on the button is not clicked at
all — which is the actual fix for "the button opens the keyboard".

The **negative** verdict expires after 30 days. It has to: the whole point
of the upstream bug report below is that Fermata may one day implement
`onShowFileChooser`, and on that day anyone carrying a cached `absent`
would be locked out of the now-working chooser forever, with no in-page
reset and no reason to suspect site data. A positive verdict never expires,
since a browser that has a chooser does not lose one.

**Every route to the picker must go through that probe**, and this is easy
to get wrong. The visible "Browse files" control was originally a `<label>`
wrapping the hidden input — the standard accessible pattern. But a label
*natively activates its nested input*, so tapping it clicked the input
directly and never entered `openFilePicker()` at all: the primary button
kept producing the dead click and the phantom keyboard on every tap, and no
verdict was ever recorded. It is a real `<button>` now, with the input as a
sibling carrying `tabindex="-1"`, so the button is the focusable control and
every activation is routed through JS. The `webkitdirectory` fallback had
the same trap and the same fix.

Worth knowing because the first version of the smoke test missed it
entirely: it clicked a coordinate on `#dropzone` rather than the button, so
it exercised the one path that was already correct. The test clicks
`#browseBtn` now.

### 2. Offer a URL instead

`loadAudioFiles()` in `main.js` needs objects with `name`, `size` and
`arrayBuffer()`. That is exactly a `File`, so a fetched blob wrapped as one
plays, analyses and caches identically to a dropped file and nothing
downstream of the picker changes.

Point the field at a song and it plays. Point it at a folder and the page
lists what is in it — a JSON listing or an ordinary HTML directory index,
with subfolders navigable. That is the part that answers "let me *see* my
files" rather than "let me type a path".

An HTML index admits a row when **either** its path or its visible label
carries an audio extension, so `<a href="download?id=1">Pretty Song.flac</a>`
— a common file-manager-share shape — is offered rather than dropped, and
the label becomes the track name since the URL has none to give.

Long listings arrive a batch at a time — folders first, then songs, 500
rows per **Show more**. Building thousands of buttons at once is seconds of
frozen UI on a head unit, and an artist root with thousands of subfolders
costs exactly as much as a flat album with thousands of tracks, so both are
paced the same way. Nothing is ever dropped, which matters for both kinds
for different reasons: a hidden song in a flat folder has no subfolder to
reach it through, and a hidden folder has nothing at all.

What counts as audio comes from `LibraryScanner`'s list rather than a
second copy here. The copy had already drifted — it was missing `.aif`,
`.aiff` and `.wma`, so a folder the normal library workflow showed in full
appeared with tracks silently absent when browsed by URL. (`.mid` is absent
from that list too, which is right for this path: everything here reaches
`decodeAudioData`, and the page has no MIDI ingest at all.)

`bootAudio()` makes every caller await the *same* attempt, and **the order
of its two guards is the whole fix**. `bootAudioOnce` assigns `audioEngine`
before awaiting `resume()`, so `audioEngine` is truthy for that entire
window — which means checking it first returns early against a context that
has not resumed, or one the first call is about to discard because resume
failed. The in-flight check must come first, or it is unreachable exactly
when it is needed. Only "truthy *and* nothing in flight" means booted.

This is worth spelling out because the first attempt at the fix added the
in-flight promise *after* the `audioEngine` check and therefore changed
nothing at all. `test/bootAudioOnce.test.js` pins the ordering; two of its
cases fail if the guards are swapped back.

`unlockAudio()` fires it from a gesture and drops the promise, and a
loopback download can finish before a slow resume does, so that window is
reachable rather than theoretical.

A URL fetch is abandoned the moment a different source is chosen. Without
that, a download started earlier could land afterwards, claim a newer load
generation and replace the file the player had just dropped.

Browsing deliberately does not touch history, so each listing renders an
**Up a folder** button derived from the current path. Without it the
browser's own Back would leave the page rather than return to the previous
folder, and one wrong tap into an album would mean retyping the address by
hand — the parent link in an HTML index is filtered out as a
non-descendant, and the JSON listing has no parent entry.

`.mid` and `.midi` are **not** offered, even though they are audio files.
Everything here reaches `audioEngine.decodeFile()`, which is
`decodeAudioData`, and this page has no MIDI ingest path at all
(`MidiAdapter` is reachable only from the tests). Listing a MIDI file would
advertise a song that fails to decode every time.

Two details about the address field are load-bearing and easy to undo.
It is `type="text"` with `inputmode="url"`, **not** `type="url"`: a url
input applies native constraint validation on submit, and a bare
`127.0.0.1:8088` is not a valid absolute URL, so the browser would block
the submit before the code that exists to prepend `http://` ever ran. And
the scheme check that decides whether to prepend looks for `://` rather
than `scheme:`, because `localhost:8088` otherwise parses as a URL whose
*scheme* is `localhost:` — which would then be rejected as an unsupported
scheme, for the single most likely thing anyone types.

One subtlety in the fetch layer: `fetch()` resolves when the response
*headers* arrive, not when the body does. A timeout that is cleared at that
point leaves the body read — `blob()`, `text()`, `json()` — with no
deadline and no abort wiring, so a server that sends headers and then
stalls hangs the UI exactly as if there were no timeout. So the body is
read inside the same helper, under the same `AbortController`, against a
deadline that is pushed back whenever bytes actually arrive: silence is
bounded, slowness is not punished. The size cap is enforced during that
read too, so a server that understates its `Content-Length` is cut off
rather than buffered in full. Listings are streamed for the same reason:
`res.json()` and `res.text()` read the whole body internally and never
report progress, which would silently turn the stall deadline back into a
total-duration one.

Directory links resolve against the response's *final* URL. A conventional
server redirects a typed `/music` to `/music/`, and resolving `song.mp3`
against the address that was typed rather than the one that answered yields
`/song.mp3` — a 404 on every row.

## Making it actually work on a phone

Two constraints decide the setup, and both are easy to trip over.

### Loopback, not the LAN

supermaudio.com is served over https, and an https page may not load
`http://` subresources. The one carve-out is **loopback**: `127.0.0.0/8`,
`localhost` and `[::1]` are "potentially trustworthy" origins and are not
treated as mixed content.

So `http://127.0.0.1:8088/` is readable from the https page, and
`http://192.168.1.50:8088/` is **blocked** — the request never leaves the
browser. `classifyUrl()` refuses a LAN address up front and says why,
rather than letting the fetch fail opaquely.

This is why the feature is useful on a phone rather than academic: Fermata
runs on the phone, the music is on the phone, so the server is on loopback.

### CORS, which most simple servers omit

A page can only read a cross-origin response if the server sends
`Access-Control-Allow-Origin`. `python3 -m http.server` does not. Neither
do most Android file managers' "share over HTTP" features. Their bytes
arrive and are then unreadable, and `fetch` reports that identically to a
refused connection — by design, so a page cannot probe the network. Since
a missing header is overwhelmingly the likeliest cause for a local server,
that is the cause the error message names first.

`tools/music-server.mjs` is a minimal server that sends the header, serves
a JSON listing, supports range requests, and is read-only and confined to
one directory. A file is judged by **the name the request asked for**, not
by its canonical target: `song.mp3 -> blob` is listed (the link's own name
says audio) and must therefore also serve, where checking the target's
extension gave a listing that advertised a song and then 404'd on the
click. The realpath still decides containment and supplies the bytes.

Symlinks whose targets stay inside the root are listed as
what they point at: a `readdir` entry for a symlink is neither
`isDirectory()` nor `isFile()`, so without resolving them a symlinked album
was reachable by direct URL yet invisible in the listing — and symlinks are
how shared storage is normally organised on Termux. One that escapes the
root is still refused, by the same realpath check that guards direct
requests. It allows a fixed **list** of origins rather than `*`:
binding to loopback keeps other machines out, but it does not keep other
*websites* out — the server exists precisely so a page can reach
`127.0.0.1`, and every other site open on the device can do the same. With
a wildcard, any of them could read the listing and download the music.
Add development origins with
`MUSIC_ALLOW_ORIGIN="http://127.0.0.1:8080,http://localhost:8080"`. It canonicalises its root directory at startup, which
matters here specifically: containment is checked against the `realpath` of
each request, so a root that is *itself* a symlink — how shared storage is
normally reached on Termux — would otherwise make every request, `/`
included, look like an escape attempt and return 403.

Under Termux (`pkg install nodejs`):

```
node tools/music-server.mjs ~/Music
# then load http://127.0.0.1:8088/ in the page
```

It binds loopback by default, so nothing is exposed to the network. It has
no authentication — do not bind it to a public interface.

### Or just use Chrome

Chrome on Android implements a chooser. Opening the page there instead
needs none of the above. On a head unit, where Fermata's browser is the
only one available, it is not an option — which is what the rest of this
document is for.

## The real fix is upstream

All of this is a workaround for about thirty lines missing from one file in
another project. `docs/fermata-upstream-issue.md` is a bug report ready to
file against Fermata; if it lands, `<input type="file">` starts working
there and the URL loader becomes a convenience rather than the only way in.

## Tests

- `test/fileChooserProbe.test.js` — the detection logic, including the
  slow-chooser case that must not be mistaken for a missing one.
- `test/urlAudioSource.test.js` — the loopback carve-out, what counts as
  audio, listing parsing, and the fetch error messages.
- `tools/url-load-smoke.mjs` — reproduces the chooserless WebView in real
  Chromium by patching `HTMLInputElement.prototype.click`, then checks that
  the real `#browseBtn` routes through the probe, the keyboard is
  dismissed, the dead button is never pressed twice, a subfolder can be
  left again, and a song reaches the decoder. Run it with `npm start` and a
  music server up:

  ```
  node tools/music-server.mjs <folder with audio> &
  npm run test:urlload -- http://127.0.0.1:8080 http://127.0.0.1:8088/
  ```
