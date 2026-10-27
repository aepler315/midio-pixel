# Music-reactive atmosphere

The landscape should perform with the recording: clear accents, distinct instrumental roles, and a visible release into quiet passages. This follows the request to prioritize output quality over strict realism. The existing terrain treatment and geography remain the visual anchor.

The chosen approach is a shared, immutable score for the smooth sky and water. Increasing every effect's global brightness would flatten the dynamics; adding more independent ambient animations would still miss the music. Instead, low frequencies drive water and curtain motion, percussion catches selected highlights, melody directs celestial accents, and genuine increases in section energy open the display briefly.

Implementation:

1. Sample fast rhythmic and melodic envelopes alongside slower bass and energy from the existing canonical music history and causal timeline. Bound recent accent counts, reject future events, respect silence and calm, and reconstruct the same score after a seek.
2. Attach the score to the immutable Range frame and reuse it in the sky snapshot. Default presentation, the direct-terrain experiment, and delayed captures consume the same completed-frame values.
3. Animate selected star groups, aurora curtains, and localized daylight atmosphere without new render targets or frame history. Keep moon occlusion, camera anchoring, and quality shedding.
4. Add world-anchored musical water wave packets, reflective movement, and restrained crest highlights inside the existing material. Keep terrain geometry and shoreline masks intact.
5. Check behavior with focused tests, the full suite, lint, and an independent review. Attempt a bounded headless musical capture if Chromium is available; tests alone do not establish visual quality.

Review focus: silence and preview must not generate accents; malformed input must stay finite; dense percussion must remain bounded; pause/seek and capture must agree; missing scores must preserve existing rendering; water must stay within its original depth and shore coverage. Device performance and rendered appearance require actual visual review.
