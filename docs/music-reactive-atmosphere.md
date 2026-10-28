# Music-reactive atmosphere

The landscape should perform with the recording: clear accents, distinct instrumental roles, and a visible release into quiet passages. This follows the request to prioritize output quality over strict realism. The existing terrain treatment and geography remain the visual anchor.

The chosen approach is a shared, immutable score for the smooth sky and water. Increasing every effect's global brightness would flatten the dynamics; adding more independent ambient animations would still miss the music. Instead, low frequencies drive water and curtain motion, percussion catches selected highlights, melody directs celestial accents, and genuine increases in section energy open the display briefly.

Implementation:

1. Sample fast rhythmic and melodic envelopes alongside slower bass and energy from the existing canonical music history and causal timeline. Bound recent accent counts, reject future events, respect silence and calm, and reconstruct the same score after a seek.
2. Attach the score to the immutable Range frame and reuse it in the sky snapshot. Default presentation, the direct-terrain experiment, and delayed captures consume the same completed-frame values.
3. Animate selected star groups, aurora curtains, and localized daylight atmosphere without new render targets or frame history. Keep moon occlusion, camera anchoring, and quality shedding.
4. Add world-anchored musical water wave packets, reflective movement, and restrained crest highlights inside the existing material. Keep terrain geometry and shoreline masks intact.
5. Check behavior with focused tests, the full suite, lint, and an independent review. Attempt a bounded headless musical capture if Chromium is available; tests alone do not establish visual quality.

## The sun, the moon and the night sky play along (2026-10-28)

- **Sun and moon.** The sky's single score (`sampleSkyPerformance`, sampled once per sky draw) reaches the bodies. Only the slow `radiance` reaches the sun's wide glare: alpha rises by at most 15% and extent by at most 8%. The note `pulse`, scaled by the score's detail, lifts only the tight bloom over the disc, by up to 50%. The pulse also lifts the moon's night aureole by up to 50%, gated by night. The disc, the moon's face, every radius and the terrain light are unchanged. `open` and the kick never reach the glare, because that would be the global brightness pump this design rejects. The cinematic look halves both responses. The bodies seen through a storm deck do not respond to the score.
- **Night streaks.** A small fixed share of strong melody notes draws one meteor streak. While a section lifts, the share is wider and any note can streak. The streak is one hairline stroke that moves quickly, then slows, over 0.45 s. It stays 8 to 30 degrees up, inside the tour lens. It fades in with the night and is optional detail that is shed from q3. Its seed and age come from the note, so seeks and the water mirror agree.
- **Reduced quality keeps a sweep.** From q2 down to the manual low preset, one daylight sweep remains (at most six culled gradients); only the second arc is shed. Quality shedding never removes a musical signature.
- **Milky Way.** Crossing the q3 rung fades the Milky Way over 1.5 s of heard time instead of cutting it.

Review focus: silence and preview must not generate accents; malformed input must stay finite; dense percussion must remain bounded; pause/seek and capture must agree; missing scores must preserve existing rendering; water must stay within its original depth and shore coverage. Device performance and rendered appearance require actual visual review.
