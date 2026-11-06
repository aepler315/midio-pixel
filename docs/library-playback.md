# Continuous library playback

The title screen has two saved preferences beside Random song:

- **Continuous play** starts the next library song after the current finale and
  a five-second countdown. It starts off. The next song keeps Landscape or Trio
  and the selected display settings, without reopening the world chooser.
- **Shuffle** starts on. It draws each available library track before repeating
  a cycle and avoids an immediate repeat when another track is available. With
  Shuffle off, songs follow title order, using the library's path tiebreaker,
  then wrap to the beginning. A one-song library can repeat.

These preferences use the current local music library, including when the first
song came from a drop, sample or another source. A newly scanned track can join
the sequence. With no library, completion explains that songs must be added.
Files dropped together retain their existing meaning as stems of one song.

**Random song** on the Complete screen picks another library track immediately.
It preserves the current experience. The title-screen Random song keeps the
ordinary initial world chooser. Both buttons open folder selection when the
library is empty; automatic playback never opens a permission prompt.

**Cancel next song** stops the pending handoff while leaving Continuous play
saved for future runs. During the countdown it stays on Complete; during loading
it returns to Title so an unplayed replacement cannot inherit the previous
song's results. Title, Stop, another selection, replay, new-seed controls and
highlight inspection/export also cancel pending automatic work. Preparation is
owned by the same selection and render-ready audio gate as manual playback.

The countdown waits for recording finalization. Missing or undecodable files
are skipped with at most three distinct attempts; unavailable folder permission
or a world-start failure stops visibly. Folder permission must be restored with
an explicit library click.

## Pixel density shortcuts

`-` steps down and `=` steps up through Classic, Classic+, Medium, Medium+ and
Detailed. `+` and numpad equivalents also work. Both ends stop: there is no wrap
from Classic to Detailed or vice versa. The HUD buttons and keyboard share the
same saved setting and redraw a paused frame. Typing, modal choosers, browser
zoom modifiers and an in-progress snapshot keep their own input behavior.
