/**
 * Build the stable gallery shown after a song is analyzed. Each registered
 * world gets one equal card. A tailored instance (id `custom`) is that
 * card's play target, never a second competing card, and never a score.
 */
import { describeWorldResponse } from './WorldPreview.js';
import { identityFor } from '../world/WorldIdentity.js';

export function buildWorldChoices(worlds, customWorld = null, features = null, extras = {}) {
  return worlds.map((world) => {
    const identity = identityFor(world);
    return {
    worldId: world.id,
    playWorldId: customWorld?.baseId === world.id ? customWorld.id : world.id,
    name: world.name,
    tagline: world.tagline,
    kind: world.kind,
    experience: world.experience === 'trio' ? 'trio' : 'landscape',
    previewLabel: world.realBiomes ? 'Range illustration. Playback uses a 3D landscape.' : null,
    description: describeWorldResponse(world.kind, features || {}, { ...extras, experience: world.experience }),
    identity: {
      landmark: identity.landmark,
      signatureMotion: identity.signatureMotion,
      lightSource: identity.lightSource,
    },
    manualOnly: !!world.manualOnly,
    };
  });
}

/** Keyboard order for the gallery: left/right wrap, no ranking. */
export function moveChoiceIndex(index, delta, count) {
  if (!count) return 0;
  return ((index + delta) % count + count) % count;
}
