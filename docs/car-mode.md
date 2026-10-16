# Car mode: head-unit displays that blank mid-song

Running the show on a car receiver (a phone-projection dongle such as an
Auto Pro X driving a Pioneer DMH-W3000NEX, with Chrome fullscreen on the
dongle) hits two problems that do not exist on a desktop:

1. The display blanks after about a minute with no touch input.
2. The tap that brings it back also lands on the page, and the show drops
   out of fullscreen just to be woken up.

`src/ui/KeepAwake.js` plus the car-mode block in `src/main.js` address both.

## Why the page cannot simply fake a tap

The obvious fix — dispatch a synthetic tap every 30 seconds — cannot work,
in any browser, by design. A `PointerEvent` created in JavaScript is
*untrusted*: it is delivered to the page's own listeners and nowhere else.
It never reaches the browser's input pipeline, the Android input stack, or
the receiver's idle timer, so the thing counting idle seconds never sees
it. The same is true of `document.body.click()`, moving the cursor, or
touching the DOM on an interval. Nothing a page does to itself counts as
user activity to the operating system.

Two levers do exist, and both are used.

## 1. Screen Wake Lock, re-armed every 30 seconds

`navigator.wakeLock.request('screen')` is the sanctioned way to tell the OS
not to blank the display. Chrome on Android — what these dongles run —
supports it. `KeepAwake` holds the lock for as long as a song is running or
the page is fullscreen.

The lock has to be re-armed rather than acquired once: the platform releases
it whenever the page is hidden or backgrounded, and never gives it back on
its own. So:

* a heartbeat (`HEARTBEAT_MS`, 30s) driven from the render loop re-requests
  the lock whenever it is missing — this is the "every 30 seconds" the fake
  tap was reaching for, except invisible, silent, and actually effective;
* `visibilitychange` back to visible re-requests immediately;
* the sentinel's own `release` event clears the handle so the next
  heartbeat picks it up.

A request while the page is hidden is rejected by spec, so those are
skipped rather than burned.

## 2. Fallback for WebViews with no wake lock

Where `navigator.wakeLock` is missing (older Android WebViews), `KeepAwake`
falls back to a 2px, 1%-opacity, muted, looping `<video>` fed by a canvas
capture stream — no asset to ship. Some WebViews keep the display awake
while video plays. Best effort: where the heuristic does not apply this
costs one captured 2×2 frame per second and changes nothing else. It is torn
down as soon as a real wake lock is acquired.

## 3. The wake-up tap is spent on waking, not on the UI

If the display blanks anyway — a receiver-side timeout the dongle's OS knows
nothing about, a rejected lock, a browser without one — the reviving tap is
absorbed:

* a capture-phase `pointerdown` listener on `document` runs before every
  other handler;
* it absorbs the tap only when *both* halves hold: the page stopped being
  drawn (a render-loop gap of `SLEEP_STALL_MS`, 10s — nothing else produces
  one during playback — or a `visibilitychange` to hidden), which is the
  evidence there was a blanked display at all; **and** the gap since the last
  real input is at least `WAKE_TAP_IDLE_MS` (20s), which is the evidence that
  *this* tap is the one that woke it. Either half alone has false positives
  that cost the player a real tap — a page backgrounded an hour ago, or a
  40-second analysis nobody touched the screen during. Then the event is
  default-prevented and stopped;
* the synthesized `click` some browsers still fire after a prevented
  touch `pointerdown` is swallowed too, for 700ms, so it cannot land on a
  button either;
* that tap instead re-arms the wake lock, wakes the HUD, and — if fullscreen
  was lost — asks for it back. The request is allowed precisely because a
  real user gesture is in hand at that moment.

This is the same "tap to unlock" beat the HUD auto-fade already uses one
level up, widened from the canvas to the whole page.

## 4. Fullscreen that the system dropped comes back

`fullscreenchange` distinguishes the two ways fullscreen can end by looking
at input recency (`FULLSCREEN_DROP_GRACE_MS`, 2s):

* within 2s of real input — the player pressed the fullscreen button or
  Escape. Their choice; nothing is restored.
* with no input for longer — the system dropped it (a display blank, a
  projection re-attach). Flagged, and restored on the next tap.

## Limits worth knowing

* If the *receiver* is what dims — a Pioneer display-off / dimmer setting,
  rather than the dongle's Android screen timeout — no page-side wake lock
  can reach it, because the receiver is a separate device. Check the
  receiver's own display-off setting first. Part 3 above still turns that
  case from "tap, lose fullscreen, tap again" into a single invisible tap.
* Wake locks require a visible, focused page. Backgrounding Chrome on the
  dongle drops it, by design.

## Testing

* `test/keepAwake.test.js` — lock acquire / re-arm / release / fallback and
  the timing predicates, against injected fakes.
* `npm run test:car` (`tools/car-mode-smoke.mjs`) — a real browser: a
  wake-up tap must not toggle pause, the next tap must, and a long idle gap
  with no display sleep must not eat a tap at all.

  It runs in CI alongside the other browser smokes. It did not, for a
  while, and it broke silently when the HUD fade landed: a faded HUD sits
  under the canvas on purpose, so a harness that reached straight for
  `#pauseBtn` got "canvas intercepts pointer events" on every click. The
  harness now performs the sequence a driver performs — wait for the fade,
  tap the stage to bring the HUD back, then tap the control — and waits for
  the fade first so it always has a full awake window rather than racing
  the tail of one.
