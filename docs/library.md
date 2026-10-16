# The music library

Choosing a folder once and having it stay there, without any of it leaving
the device.

## What "upload" means here

Nothing is uploaded and nothing is copied. The File System Access API hands
the page a `FileSystemDirectoryHandle` — a durable, permission-bearing
reference to a folder that is already on disk. That handle is
structured-cloneable, so it can be kept in IndexedDB and used again after a
reload. A file is opened only at the moment something is about to play it.

This is also why `localStorage` was never an option: it is string-only, so
it cannot hold a handle at all. The size question never comes up.

## The scan is deliberately cheap

Choosing a folder has to turn several thousand songs into a browsable list
in seconds, so the scan reads as little as it can:

- **Nothing is decoded.** Decoding one track costs more than reading the
  tags of every track in the folder. Durations are the one thing this
  leaves unknown, and they are filled in one at a time as songs are played
  — which is why a fresh library shows `—` in the length column rather than
  `0:00`.
- **No whole file is read.** An ID3v2 tag sits at the head of a file and an
  ID3v1 tag in its last 128 bytes, so two slices cover both. On a 40MB FLAC
  that is a quarter megabyte, and the tail slice is only taken when the head
  came back empty.
- **Only audio counts.** Artwork, cue sheets, `.nfo` files and stray video
  are in every ripped folder and are not tracks. Hidden files, macOS
  `._` resource forks and the per-OS metadata directories are skipped too —
  without that, a drive written on a Mac reports twice as many songs as it
  has.

## The scan streams

A real music folder takes minutes to walk, and a library that shows nothing
until the last file is read is indistinguishable, from the outside, from one
that never started. So nothing waits for the end:

- the library **opens as soon as the folder is chosen**, before a single file
  has been read;
- tracks arrive in batches — whichever comes first, forty files or 250ms, so
  a fast local disk does not repaint per file and a slow network drive does
  not look frozen between batches;
- each batch is **written to storage as it arrives**, so a scan abandoned
  half way leaves a half-populated library rather than nothing;
- searching, sorting, the folder view and playing a track all work on what
  has arrived so far.

The deletion half of a rescan waits for the end, and has to: only a
*completed* walk knows the full set of paths, so pruning against a partial
one would delete most of the library and call it housekeeping.

## Sorting, filtering, folders

The view's whole mind is in `TrackIndex.js`, which has no DOM in it. Three
decisions there are worth knowing about:

- **An untagged track is named after its file**, never left blank. A row the
  eye cannot find is worse than a clumsy name.
- **A missing value sorts last in both directions.** "Sort by artist,
  descending" is a request to see Z first, not to see every untagged file
  first.
- **A folder's count is everything beneath it.** Most libraries are
  Artist/Album shaped, so a folder whose own files are one level down would
  otherwise report "0 tracks" about a folder full of music.

Search is AND across terms, so typing more words narrows. A term can be
scoped with `artist:`, `album:`, `title:`, `folder:` or `ext:`, and a quoted
phrase stays whole (`artist:"nine inch nails"`). Free terms also match the
path, because an untagged library is navigated by where its files are.
Searching inside a folder searches the whole library — the alternative is a
box that silently finds nothing because of where the player was standing.

## Auto-tagging

`AutoTag.js` asks [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API)
for the tracks that have nothing but a filename. It is free, keyless and
CORS-open — the same shape of dependency the lyrics path already takes on
LRCLIB.

The alternative worth naming is AcoustID, which identifies a recording from
its audio rather than its filename and would be strictly better. It also
needs a Chromaprint build and a full decode per track, which turns a
thousand-file folder from a minute of lookups into an afternoon of CPU.

MusicBrainz asks anonymous clients for one request per second. That is
enforced by construction rather than hoped for: the queue measures the gap
between request *starts*, so a lookup that itself took two seconds does not
then wait again. A folder of two hundred fills in over four minutes, writing
each result as it lands, because watching a list fill in is the only thing
that makes a four-minute job feel like progress.

Writing a wrong artist over a right filename is worse than leaving the
filename alone, so a candidate is refused unless it clears all of:

- MusicBrainz's own match score is at least 80;
- its title shares at least 60% of its words with ours, *after* release
  qualifiers are stripped from both sides (without that stripping, `Song`
  against `Song (2011 Remaster)` scores below `Paranoid Android` against
  `Paranoid`, which is exactly backwards);
- its length, when we know ours, is within 8 seconds.

A track with no title guess at all is never looked up: that query would
search for the empty string and return whatever MusicBrainz considers
popular. Auto-tagged rows carry a small dot — it is a good guess, not ground
truth.

For the album, the earliest release that is not a compilation or DJ mix wins
over the earliest release outright. Search results are dominated by
compilations, so "earliest" on its own files a studio track under whichever
mix CD happened to be listed first. The year comes from the recording's own
`first-release-date`, not from whichever reissue got named as the album.

## Rescanning is free

A rescan replaces every track under a root, because the question it answers
is "what is in this folder *now*" — a file deleted on disk has to leave the
library too. Everything the player earned is carried across explicitly
instead: play counts, last-played times, cached durations, and any auto-tag
that was fetched. A file whose size or mtime changed is re-tagged from
scratch, since whatever edited it also edited its tags.

## Browsers without a persistable handle

Firefox and Safari expose `webkitdirectory` on `<input>` but no handle that
survives a reload. Those browsers get the same library from the same scan,
and the same caveat stated plainly on the title screen: the listing is
remembered, and the folder has to be picked again once per visit before
anything can play from it. The page shows whichever control the browser can
actually honour, not both.

## Degrading

Every path degrades to "there is no library" rather than to an error. No
IndexedDB (Node, private browsing, old browsers) means the store no-ops, the
library stays empty, and dropping a file on the page works exactly as it
always did. That is the fallback the whole feature is built behind.
