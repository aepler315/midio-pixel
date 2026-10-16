// Schedules Midasus's sky voyage and Broshi's burrow off the music itself,
// and guarantees the stage never loses two of three performers at once.
// Both excursions reuse their own force-trigger hooks (Midasus.forceVoyage,
// Broshi.forceBurrow) as the actual trigger call -- this class only decides
// *when* to call them.
import { Role } from '../core/NoteEvent.js';

const START_GUARD_MS = 12000;   // no excursions in the song's first 12s
const END_GUARD_MS = 25000;     // none in the final 25s; forces anyone home
const GLOBAL_COOLDOWN_MS = 25000; // minimum gap between ANY two excursions

const EPIC_THRESHOLD = 0.62, EPIC_SUSTAIN_MS = 4000;
// Real VibeDirector output oscillates faster than a naive 6s/0.15 bar
// suggests -- a mellow procedural song's valence rarely holds a single
// sign for more than ~3-5s at a stretch (measured directly against the
// demo timeline). 4s/0.08 asks for genuine sustained positivity without
// requiring a rock-steady one most real songs will never produce.
const CALM_THRESHOLD = 0.6, VALENCE_THRESHOLD = 0.08, CALM_SUSTAIN_MS = 4000;
const MAX_VOYAGES = 2, VOYAGE_COOLDOWN_MS = 60000;

const BASS_THRESHOLD = 0.55, BASS_SUSTAIN_MS = 3000;
// Burrows are OFF. The excursion put Broshi underground in a generated
// cavern, and the cave -- stalactites, rock walls, the lot -- is a second
// visual world sitting under the first one, competing with the landscape
// rather than adding to it. Zero here rather than deleting Burrow.js: the
// class, its geometry and its tests are all still sound, and this is the one
// line that decides whether anything ever reaches them.
const MAX_BURROWS = 0, BURROW_COOLDOWN_MS = 40000;
const DROP_FRESH_MS = 400;   // how recent a drop must be to still count as "just happened"
const DROP_WINDOW_MS = 1500; // voyages don't launch into a drop

const KICK_SNAP_WINDOW_MS = 400;
const isKick = (e) => e.role === Role.RHYTHM && e.kick;

export class ExcursionDirector {
  constructor(durationMs = 0) {
    this.durationMs = durationMs;
    this._sustainEpicMs = 0;
    this._sustainCalmMs = 0;
    this._sustainBassMs = 0;
    this._voyageCount = 0;
    this._burrowCount = 0;
    this._globalCooldownUntilMs = 0;
    this._voyageCooldownUntilMs = 0;
    this._burrowCooldownUntilMs = 0;
    this._lastDropSeenAtMs = -Infinity;
    this._pendingVoyageLaunchMs = null;
    this._pendingBurrowLaunchMs = null;
  }

  update(nowMs, dtSec, { vibe, calm, hype, energyCurves, conductor, midasus, broshi, worldX, chorusText = null, lyricSymbol = null }) {
    const voyageActive = midasus.voyage.active;
    const burrowActive = broshi.burrow.active;
    const anyActive = voyageActive || burrowActive;

    if (this.durationMs > 0 && nowMs >= this.durationMs - END_GUARD_MS) {
      if (voyageActive) midasus.voyage.forceEnd(nowMs);
      if (burrowActive) broshi.burrow.forceEnd(nowMs);
      this._pendingVoyageLaunchMs = null;
      this._pendingBurrowLaunchMs = null;
      return;
    }

    if (!anyActive) {
      // Fire a scheduled, kick-snapped launch -- re-checking mutual
      // exclusion here (not just at scheduling time) so a force-triggered
      // excursion from elsewhere can't collide with one we queued earlier.
      if (this._pendingVoyageLaunchMs != null && nowMs >= this._pendingVoyageLaunchMs) {
        const ok = midasus.forceVoyage(nowMs, chorusText, lyricSymbol);
        this._pendingVoyageLaunchMs = null;
        if (ok) {
          this._voyageCount++;
          this._voyageCooldownUntilMs = nowMs + VOYAGE_COOLDOWN_MS;
          this._globalCooldownUntilMs = nowMs + GLOBAL_COOLDOWN_MS;
        }
        return;
      }
      if (this._pendingBurrowLaunchMs != null && nowMs >= this._pendingBurrowLaunchMs) {
        const ok = broshi.forceBurrow(nowMs, worldX);
        this._pendingBurrowLaunchMs = null;
        if (ok) {
          this._burrowCount++;
          this._burrowCooldownUntilMs = nowMs + BURROW_COOLDOWN_MS;
          this._globalCooldownUntilMs = nowMs + GLOBAL_COOLDOWN_MS;
        }
        return;
      }
    } else {
      this._pendingVoyageLaunchMs = null;
      this._pendingBurrowLaunchMs = null;
    }

    // Sustained-condition timers keep ticking regardless of whether we're
    // currently free to act on them.
    this._sustainEpicMs = vibe.epic > EPIC_THRESHOLD ? this._sustainEpicMs + dtSec * 1000 : 0;
    const stargazing = calm.level > CALM_THRESHOLD && vibe.valence > VALENCE_THRESHOLD;
    this._sustainCalmMs = stargazing ? this._sustainCalmMs + dtSec * 1000 : 0;
    const bassHeavy = energyCurves ? energyCurves.sample(1, nowMs) > BASS_THRESHOLD : false;
    this._sustainBassMs = bassHeavy ? this._sustainBassMs + dtSec * 1000 : 0;

    if (anyActive) return; // mutual exclusion: nothing new schedules while one's live
    if (nowMs < this._globalCooldownUntilMs) return;
    if (this.durationMs > 0 && nowMs < START_GUARD_MS) return;
    if (this._pendingVoyageLaunchMs != null || this._pendingBurrowLaunchMs != null) return;

    const freshDrop = !!hype && hype.dropAtMs > this._lastDropSeenAtMs && nowMs - hype.dropAtMs < DROP_FRESH_MS;
    if (freshDrop) this._lastDropSeenAtMs = hype.dropAtMs;
    const canBurrow = this._burrowCount < MAX_BURROWS && nowMs >= this._burrowCooldownUntilMs;
    if (freshDrop && canBurrow) { this._scheduleBurrow(nowMs, conductor); return; }
    if (this._sustainBassMs >= BASS_SUSTAIN_MS && canBurrow) { this._scheduleBurrow(nowMs, conductor); return; }

    const inDropWindow = !!hype && nowMs - hype.dropAtMs < DROP_WINDOW_MS;
    if (inDropWindow) return;

    const canVoyage = this._voyageCount < MAX_VOYAGES && nowMs >= this._voyageCooldownUntilMs;
    if (this._sustainEpicMs >= EPIC_SUSTAIN_MS && canVoyage) { this._scheduleVoyage(nowMs, conductor); return; }
    if (this._sustainCalmMs >= CALM_SUSTAIN_MS && canVoyage) this._scheduleVoyage(nowMs, conductor);
  }

  _scheduleVoyage(nowMs, conductor) {
    const kick = conductor ? conductor.nearestEventMs(isKick, nowMs, KICK_SNAP_WINDOW_MS) : null;
    this._pendingVoyageLaunchMs = kick ? Math.max(kick.tMs, nowMs) : nowMs;
  }

  _scheduleBurrow(nowMs, conductor) {
    const kick = conductor ? conductor.nearestEventMs(isKick, nowMs, KICK_SNAP_WINDOW_MS) : null;
    this._pendingBurrowLaunchMs = kick ? Math.max(kick.tMs, nowMs) : nowMs;
  }
}
