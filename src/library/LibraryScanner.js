// Turning a chosen folder into a list of tracks.
//
// The scan is deliberately shallow work: names, sizes, and whatever tag sits
// in the first few kilobytes of each file. It never decodes audio. A folder
// of several thousand songs has to become a browsable library in seconds,
// and decoding even one of them costs more than reading the tags of all of
// them -- durations arrive later, one per song, as each is actually played.
//
// Everything here works against the *shape* of the File System Access API
// (`dirHandle.values()` yielding `{kind, name}`, files via `getFile()`)
// rather than the real thing, so the walk is testable against a plain object
// tree with no browser in sight.
import { resolveIdentity } from '../lyrics/SongIdentity.js';

/** What the decoder can actually open, matching the file picker's accept
 *  list. Anything else in the folder -- artwork, cue sheets, .nfo files,
 *  a stray video -- is not a track and must not appear as one. */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'aif'];

/** Folders that are never music: resource forks, artwork caches, and the
 *  per-OS metadata directories that would otherwise pad a scan with
 *  thousands of dead entries. */
const SKIP_DIRS = new Set(['.git', '.svn', '__macosx', '.ds_store', 'node_modules', '.trash', '$recycle.bin', 'system volume information']);

/** A depth cap, not a correctness rule: music libraries are Artist/Album
 *  deep, and anything past this is a symlink loop or a backup of a backup. */
const MAX_DEPTH = 10;

/** Enough of a file to hold an ID3v2 tag with embedded artwork. Past this,
 *  a tagger has put something unusual in the file and the filename
 *  heuristics are the better answer anyway. */
const TAG_HEAD_BYTES = 256 * 1024;

export function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function isAudioName(name) {
  return AUDIO_EXTENSIONS.includes(extensionOf(name));
}

/** The folder part of a relative path, '' at the root of the library. */
export function folderOf(path) {
  const i = String(path || '').lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Walk a directory handle, yielding `{entry, path}` for every audio file
 *  beneath it, depth-first and in whatever order the handle iterates.
 *
 *  Hidden files are skipped: a leading dot on macOS and Linux marks
 *  something the player did not put there, and `._Track.mp3` resource forks
 *  would otherwise double every count. */
export async function* walkAudioFiles(dirHandle, { path = '', depth = 0 } = {}) {
  if (!dirHandle || depth > MAX_DEPTH) return;
  let iterator;
  try {
    iterator = dirHandle.values();
  } catch {
    return; // permission revoked mid-walk, or not a directory after all
  }
  for await (const entry of iterator) {
    const name = entry?.name || '';
    if (!name || name.startsWith('.')) continue;
    const childPath = path ? `${path}/${name}` : name;
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      yield* walkAudioFiles(entry, { path: childPath, depth: depth + 1 });
    } else if (entry.kind === 'file' && isAudioName(name)) {
      yield { entry, path: childPath };
    }
  }
}

/** Read whatever tag the file carries, without reading the file.
 *
 *  ID3v2 lives at the head and ID3v1 in the last 128 bytes, so two slices
 *  cover both -- and a slice of a File is a promise of bytes, not the
 *  bytes: on a 40MB FLAC this reads a quarter megabyte. The tail is only
 *  read when the head came back empty, which for a modern library is
 *  almost never. */
export async function readTags(file) {
  const empty = { title: null, artist: null, album: null };
  if (!file) return empty;
  try {
    const head = await file.slice(0, TAG_HEAD_BYTES).arrayBuffer();
    const fromHead = resolveIdentity(file.name || '', head, null);
    if (fromHead.source === 'tags') return fromHead;
    if (file.size > 128) {
      const tail = await file.slice(file.size - 128).arrayBuffer();
      const fromTail = resolveIdentity(file.name || '', tail, null);
      if (fromTail.source === 'tags') return fromTail;
    }
    return fromHead; // filename heuristics, or nothing at all
  } catch {
    return { ...empty, source: 'none', confidence: 0 };
  }
}

/** Build the stored record for one file. Pure given its inputs, which is
 *  what lets the field set be asserted without a filesystem. */
export function trackRecord({ rootId, path, file, identity, nowMs = Date.now() }) {
  const name = file?.name || path.slice(path.lastIndexOf('/') + 1);
  return {
    key: `${rootId}\u0000${path}`,
    rootId,
    path,
    folder: folderOf(path),
    name,
    ext: extensionOf(name),
    size: file?.size ?? 0,
    lastModified: file?.lastModified ?? 0,
    addedMs: nowMs,
    title: identity?.title || null,
    artist: identity?.artist || null,
    album: identity?.album || null,
    year: null,
    // 'tags' and 'filename' come from the file itself; 'auto' is only ever
    // written later, by AutoTag, and is what tells a rescan not to throw a
    // fetched tag away.
    tagSource: identity?.source || 'none',
    durationSec: null,
    playCount: 0,
    lastPlayedMs: 0,
  };
}

/**
 * Scan a folder into track records.
 *
 * `onBatch(tracks)` is the reason this is not simply a function that
 * returns an array. A real music folder takes minutes to walk, and a
 * library that shows nothing until the last file is read is
 * indistinguishable, from the outside, from one that did not start. Tracks
 * are handed over in small batches as they are found so the view fills in
 * while the walk continues.
 *
 * Batches flush on whichever comes first, a count or an interval: the count
 * keeps a fast local disk from repainting per file, and the interval keeps
 * a slow network drive from looking frozen between them.
 *
 * `onProgress(count, path)` is the same running total for a status line.
 * `signal` aborts between files -- closing the panel over a ten-thousand
 * track drive should actually stop reading it.
 */
export async function scanDirectory(rootId, dirHandle, {
  onProgress = null, onBatch = null, signal = null, nowMs = Date.now(),
  batchSize = 40, batchMs = 250, now = () => Date.now(),
} = {}) {
  const tracks = [];
  let batch = [];
  let lastFlushMs = now();

  // Awaited, not fired and forgotten: the handler persists each batch, and
  // letting the walk lap it would race those writes against each other.
  const flush = async () => {
    if (!batch.length) return;
    const sending = batch;
    batch = [];
    lastFlushMs = now();
    await onBatch?.(sending);
  };

  for await (const { entry, path } of walkAudioFiles(dirHandle)) {
    if (signal?.aborted) break;
    let file;
    try {
      file = await entry.getFile();
    } catch {
      continue; // vanished or unreadable between listing and opening
    }
    const identity = await readTags(file);
    const track = trackRecord({ rootId, path, file, identity, nowMs });
    tracks.push(track);
    batch.push(track);
    onProgress?.(tracks.length, path);
    if (batch.length >= batchSize || now() - lastFlushMs >= batchMs) await flush();
  }
  // Whatever is left over, including everything when the walk was aborted
  // part way -- those tracks were still found and are still worth having.
  await flush();
  return tracks;
}

/** Does the page still have permission to read this folder?
 *
 *  A stored handle survives the reload; the grant behind it does not always,
 *  and re-requesting needs a user gesture. `interactive` is the caller
 *  saying it has one -- on load it does not, so the library shows what it
 *  remembers and asks before it reads. */
export async function ensureReadPermission(handle, { interactive = false } = {}) {
  if (!handle?.queryPermission) return true; // nothing to ask, nothing to refuse
  try {
    const opts = { mode: 'read' };
    if (await handle.queryPermission(opts) === 'granted') return true;
    if (!interactive || !handle.requestPermission) return false;
    return await handle.requestPermission(opts) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Walk back down from the root handle to one file.
 *
 * Handles are not stored per track on purpose: a ten-thousand-track library
 * would be ten thousand handles in IndexedDB to save a directory lookup per
 * play. The path in the record is enough to find the file again, and it is
 * found only when something is actually about to be played.
 *
 * Returns null when the file has been moved or deleted since the scan --
 * which the caller wants to know about, because the right response is to
 * offer a rescan, not to show a decode error.
 */
export async function resolveFile(rootHandle, path) {
  if (!rootHandle || !path) return null;
  const parts = String(path).split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return null;
  try {
    let dir = rootHandle;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(fileName);
    return await handle.getFile();
  } catch {
    return null;
  }
}

/**
 * Build track records from a `<input type="file" webkitdirectory>` drop.
 *
 * The fallback for browsers with no persistable directory handle. The files
 * are real and playable for this session; what cannot be saved is the way
 * back to them, so the library is remembered and the folder is re-picked
 * once per visit. That is a worse deal than the handle, and it is a much
 * better one than no library.
 */
export async function scanFileList(rootId, files, {
  onProgress = null, onBatch = null, signal = null, nowMs = Date.now(),
  batchSize = 40, batchMs = 250, now = () => Date.now(),
} = {}) {
  const tracks = [];
  const handles = new Map();
  let batch = [];
  let lastFlushMs = now();
  let batchFiles = new Map();
  const flush = async () => {
    if (!batch.length) return;
    const sending = batch;
    const sendingFiles = batchFiles;
    batch = [];
    batchFiles = new Map();
    lastFlushMs = now();
    // The Files come with their tracks. Held back until the end, every row
    // that appeared during the scan would report "pick the folder again"
    // when clicked, on the one path where the file is already in hand.
    await onBatch?.(sending, sendingFiles);
  };

  for (const file of [...(files || [])]) {
    if (signal?.aborted) break;
    if (!file || !isAudioName(file.name)) continue;
    // webkitRelativePath leads with the chosen folder's own name; the
    // library's paths are relative to that folder, exactly as the
    // directory-handle walk produces them.
    const full = file.webkitRelativePath || file.name;
    const path = full.includes('/') ? full.slice(full.indexOf('/') + 1) : full;
    if (path.split('/').some((part) => part.startsWith('.'))) continue;
    const identity = await readTags(file);
    const track = trackRecord({ rootId, path, file, identity, nowMs });
    tracks.push(track);
    batch.push(track);
    handles.set(path, file);
    batchFiles.set(path, file);
    onProgress?.(tracks.length, path);
    if (batch.length >= batchSize || now() - lastFlushMs >= batchMs) await flush();
  }
  await flush();
  return { tracks, handles };
}
