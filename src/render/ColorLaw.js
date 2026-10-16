// The color law: exactly three hues in this game are protected. Never
// rotated by biome/key (see BiomeManager._rotated / KeyDirector's
// paletteRotation, both scoped to background/world elements only), never
// nudged by an edge's screen-space angle (removed from MeshDrawer's
// drawMeshEdges entirely), never blended toward anything else. Everywhere
// ELSE is free to drift with the music and the world -- these three are
// the fixed points a player can build trust around:
//
//  - MIDIO_IDENTITY_HUE: who he is. Previously drifted continuously
//    toward the song's detected key (KeyDirector.tonic); a character
//    whose own color depends on what key the song happens to be in isn't
//    an identity, it's a mood ring.
//  - HAZARD_HUE: what will hurt you. Previously borrowed the active
//    biome's own halo color (BiomeManager.currentHaloColor(), itself
//    already key-rotated) -- meaning "this is dangerous" changed hue
//    every time the biome or the song's key did.
//  - REWARD_HUE: what you did right. Already fairly consistent in
//    practice (three independent gold-ish magic numbers -- the old
//    milestone digit's GOLD hex, and two bare hue literals in Renderer.js -- that happened
//    to agree) but never actually the same named constant, so nothing
//    enforced they'd stay in agreement.
import { hexToRgb, rgbToHsl } from '../utils/color.js';

function hueOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b).h;
}

export const MIDIO_IDENTITY_HUE = 178; // cool aquamarine

export const HAZARD_HEX = '#ff4d4d'; // clear warm red -- reads as danger against every biome palette, none of which lean this red
export const HAZARD_HUE = hueOf(HAZARD_HEX);

export const REWARD_HEX = '#ffd75e'; // gold -- was the milestone digit's local, unshared GOLD constant
export const REWARD_HUE = hueOf(REWARD_HEX);
