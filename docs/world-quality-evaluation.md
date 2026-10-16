# World quality evaluation

What “looks good” means, without a public score.

The chooser presents equal cards. Internal fit is a heuristic, not visual
quality, and must not set the viewing order. This protocol records that
heuristic privately, captures the same three moments in every world, and
asks a human to rate what they see.

```sh
npm run eval:worlds
npm run eval:worlds -- --split holdout
```

The default corpus is `test/fixtures/world-evaluation.json`. It stores
source references, feature snapshots, and optional passage annotations.
It does not store audio. SoundHelix demo URLs and the MIDI generator
(`tools/gen-test-midi.mjs`) are reproducible; feature-only slots are
replaced with a licensed recording at review time. The operator-supplied
slot is for a reported song if one is available. It is not required.

## Splits

- **Tune** — used while developing responses. Do not report acceptance from it.
- **Holdout** — reserved for the acceptance target. Do not retune against it.

The two id sets are disjoint. Keep them that way.

## Capture

Every world sees the same three clocks, the same seed, and the same quality
preset (`EVAL_QUALITY` in `src/eval/WorldQuality.js`):

| Passage | Meaning |
| --- | --- |
| Quiet | Lowest 1.2s energy stretch, matching the chooser’s quiet preview |
| Transition | Strongest measured section step, else the steepest energy rise |
| Peak | Highest 1.2s energy stretch, matching the chooser’s peak preview |

Annotated `passages` on a track win over derivation. A missing energy curve
falls back to proportional positions. Never invent a beat from BPM.

Stills use the same world instance playback will use. The gallery contains the eight surviving worlds.

## Private heuristic

`scoreWorlds` is recorded on the sheet so a 70–80 result can be compared to
the recommended world after the fact. Hide those numbers while rating.
They are not a percentage of watchability.

Fit is evaluated **after** the world's response configuration. A dense mix
that already filters accents is not rejected for raw intensity. Ranking
uses the continuous `fit` value; the integer `score` is display-only for
the review sheet. Worlds within `TIE_EPS` (0.012) of the leader stay tied.
Choose-for-me still returns one pick and records `pickReason` as `unique`
or `near-tie`.

Diagnostics on each row split three things that used to be mixed together:

| Field | Meaning |
| --- | --- |
| `parts.styleAffinity` | Does this world's material language like the song? |
| `parts.analysisConfidence` | How much the tempo/key/structure read can be trusted |
| `parts.problems` | Predicted response issues (`strobe-risk`, `stillness`, `low-confidence`, `manual-only`) |

A scored channel must name a renderer `consumer` (`file#symbol`). A channel
with no consumer is not a measurement.

## Ratings

Rate each world independently, 1–5, on:

| Axis | 1 | 5 |
| --- | --- | --- |
| Appeal | Would not watch | Want to keep watching |
| Musical timing | Gestures miss the music | Gestures land with the music |
| Identity | Could be any world | Recognizable without the title |
| Quiet-section interest | Dead or noisy when the song is still | Calm and specific |
| Climax headroom | Peak is already clipped or timid | Peak has somewhere to go |
| Clutter | Unreadable | Dense but legible, or rightly sparse |

Low motion is not automatic failure. A sparse piano in Far Side that stays
still on purpose can score well on quiet interest.

Mark `blockingDefect` if the frame is broken (blank, unreadable type, wrong
renderer, leaked preview audio). A blocking defect fails the pair regardless
of the numbers.

## Diagnostics

Event density, channel saturation, contrast, and transition time are
diagnostics. Frame time, preview latency, and scene visibility stay `null`
until a capture dump fills them. None of these is a beauty score.

## Acceptance target

Recommended results have no blocking visual defects and receive at least 4/5
for both appeal and musical timing in at least 80% of held-out reviewed
cases.

This is a **target to validate**, not a claimed result. Only valid ratings
of the recommended world on **holdout** tracks count:

- Every present rating must be an integer from 1 to 5. A missing or `null`
  axis makes the review incomplete (not counted); any other value (0, 6,
  4.5, `NaN`, a string) makes it invalid. Invalid reviews are listed under
  `invalid` and keep `met: null`.
- A known `blockingDefect: true` on any recommended holdout case forces
  `met: false`, even when that review's ratings are incomplete. Blockers are
  listed under `blocking`.
- The 80% share is over reviewed holdout cases. `coverage` reports
  `{reviewed, total, complete}` beside it, so a partial review states how
  much of the holdout it covers rather than redefining the denominator.
- No valid holdout evidence reports `met: null` and `calibration:
  empty-holdout`; valid holdout ratings report `holdout-reviews`. Tune
  reviews are diagnostics only: `--split tune` reports `met: null` with
  `calibration: tune-reviews` (or `empty-tune`). Every summary sets
  `claimed: false`.

`npm run eval:worlds` generates review plans and summaries. It captures
nothing, and it never imports reviews implicitly. To summarize filled
ratings, edit the reviews in a book the command emitted and pass it back:

```sh
npm run eval:worlds -- --split holdout > .smoke/holdout-book.json
# fill reviews[].appeal ... clutter, blockingDefect, notes
npm run eval:worlds -- --split holdout --reviews .smoke/holdout-book.json
```

The book must use the current `protocol`, a valid `split`, and track, split
and world ids from the freshly generated sheets, each at most once. Only
review fields (`appeal`, `musicalTiming`, `identity`, `quietInterest`,
`climaxHeadroom`, `clutter`, `blockingDefect`, `notes`) are merged;
heuristics, viewing order and metadata in the book are ignored. An unknown
or duplicate id, or a malformed field, exits nonzero without a report.

Filled `blockingDefect` reviews are exported as `exclusions` (track/world
pairs). They are diagnostics: nothing wires them into Choose-for-me
automatically. Manual selection is always available for registered worlds.

Section-boundary metrics remain a separate concern: see
[analysis-evaluation.md](./analysis-evaluation.md) and `npm run bench:sections`.
