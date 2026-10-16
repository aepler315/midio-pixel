# Midio listening pipeline design

Version 0.1 proposal · September 30, 2026

## Intended outcome and status

The user wants to submit an audio recording and a description written after human listening, using a stable and useful vocabulary. The system should compare the two and accumulate enough explicit examples to recognize descriptions such as “bright and happy with a severe melancholy undertone getting severe and taking over.”

The proposed unit of knowledge is a versioned recording–annotation–analysis case. This design, the human guide, schema, and sample files are prepared for review. No importer, analyzer modification, emotion model, or automatic learning job has been implemented. No real song was supplied for comparison. The example is deliberately illustrative.

Assumptions: one primary listener initially; plain listening language with optional musical detail; original audio stored outside the source repository; annotation and evaluation first; rendering changes only after analysis evidence justifies them. These are proposed defaults, not additional requests attributed to the user.

## Approach selection

| Approach | Advantage | Limitation |
| --- | --- | --- |
| Free prose alone | Natural and expressive | Hard to compare consistently; vague timing and conflated terms |
| One valence/arousal curve | Compact and compatible with existing research | Cannot preserve all simultaneous emotional layers and their roles |
| Structured spans plus original prose | Retains nuance, timestamps, uncertainty, and multiple emotions | Requires a small controlled vocabulary and annotation review |

Choose structured spans plus original prose. Keep optional valence/arousal summaries as additional annotations. Do not discard the human's sentence after translation.

## Verified repository baseline

Source was freshly cloned from `aepler315/Midio-5`, default branch `main`, at commit `c7c22e850a92bdea6313653ab03903f587e03e28` on September 30, 2026. These are source-inspection findings, not playback observations or benchmark results.

| Existing component | Verified capability | Consequence for this design |
| --- | --- | --- |
| [`AudioAdapter.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/AudioAdapter.js) | Emits timeline, energy curves, whole-song brightness, tonal evidence, rhythm, structure, and a shared profile | Reuse the production audio path for comparisons |
| [`PitchTracker.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/PitchTracker.js) | Computes frame brightness and chroma; provides timed brightness helpers | A diagnostic export can retain time-resolved features currently summarized at the adapter boundary |
| [`SongProfile.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/SongProfile.js) | Profile version 2; shared features, sections, confidence, and provenance | Add a separately versioned emotion result only after it has a real predictor; do not relabel existing numbers |
| [`AnalysisBundle.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/AnalysisBundle.js) | Bundle version 4; portable analysis and profile snapshots; normalized curves are quantized | Reuse bundles where suitable; retain an unquantized diagnostic export for comparisons that need it |
| [`OpeningAnalysis.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/OpeningAnalysis.js) | A provisional 15-second opening can represent a longer recording before full analysis arrives | Corpus runs require full-recording coverage; a full duration field alone does not establish that coverage |
| [`VibeDirector.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/sim/VibeDirector.js) | Smoothed valence uses `0.72 * third + 0.28 * bright`; an additional epic channel uses energy/density/register | Preserve these as existing heuristics; do not treat one valence value as separate joy and melancholy predictions |
| [`BuildCharacter.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/BuildCharacter.js) | Defines `melancholic-tension`, `clean-drive`, `mixed`, and `calm` from weighted feature proxies | Useful experimental baseline; source search found no production calls to its exported classifier/attachment functions. Do not assume it already drives playback |
| [`StemSeparator.js`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/src/audio/StemSeparator.js) | Separates seven frequency bands with filters | Frequency bands are not isolated vocals, guitars, or emotional layers |
| [`analysis-evaluation.md`](https://github.com/aepler315/Midio-5/blob/c7c22e850a92bdea6313653ab03903f587e03e28/docs/analysis-evaluation.md) | Existing `bench:sections` protocol, held-out separation, and no checked-in revision-tagged held-out music result | Extend evaluation next to the current section benchmark; do not equate passing synthetic tests with emotion accuracy |

## Data contracts

### Human annotation

The authoring format is YAML that converts without interpretation into the JSON object constrained by `listening.schema.json`. `README.md` defines the vocabulary and scale anchors. The schema permits incomplete draft forms, while reviewed forms require identity fields and concrete times. Full semantic and audio-binding validation remains a separate step.

The smallest useful case has an audio file, original summary, and one observed time span with at least one sound or emotion judgment. More segments, trends, and foreground-change events make it more informative. Unknown fields stay absent or null. An unrated emotion is not a negative example. Multiple foreground emotions are allowed. Intensity and foreground role are independent targets.

Numeric ratings are ordinal. The initial evaluator may report absolute rating error as a transparent convenience, but must not claim equal perceptual distances between adjacent labels. No rating is a probability.

Canonical emotion names and field names are versioned. Preserve personal wording verbatim. Ambiguous aliases such as “heavy,” “dark,” “severe,” or “intense” require context; proposed mappings are reviewable. Adding a new label changes the vocabulary version; old files retain their original meaning.

### Case manifest

The ingest layer, not the human, supplies:

- Stable case ID, annotation revision and content hash, vocabulary/schema versions, review status, and annotator ID.
- Audio byte SHA-256, original filename, file size, decoded sample rate/channel count/frame count, and duration. A content fingerprint may assist matching but does not replace the exact file identity.
- Recording-group ID joining duplicate encodes, edits, remasters, stems, and excerpts when they share source material; explicit parent/offset metadata for excerpts. Never infer timestamp equivalence from a song title alone.
- Corpus split (`development`, `validation`, or `test`) and split-manifest revision. Missing grouping or split metadata blocks admission to a scored evaluation set.
- Local asset reference or another explicitly chosen storage reference. The original is preserved. Git metadata must not embed an audio file or expose a user's absolute local path.

The annotation's `audio_file` is a human convenience. The manifest binds it to the actual recording. A filename alone is insufficient.

### Machine run

Persist audio hash, analyzed interval, source commit, analyzer configuration hash, feature-export version, model/calibration version if any, bundle/profile versions, decoder/browser version, sample rate, run ID, and input/output hashes. Serialize predictions before comparison. Human labels and prose are not inputs to the predictor for this run.

Store three distinct layers:

1. **Acoustic evidence:** time-resolved energy, band power, onsets, pulse confidence, brightness, tonal evidence and confidence, and structure.
2. **Heuristic interpretations:** current valence/epic and experimental build-character results, including their source and scale.
3. **Calibrated semantic predictions:** separate emotion intensities, roles, and uncertainty, only when a predictor actually produces them. An absent predictor reports `unsupported`, not neutral, zero, or a fabricated confidence.

The initial pipeline can provide evidence and heuristic comparisons before a semantic predictor exists. It cannot yet quantitatively score the layered emotional sentence against a nonexistent output.

### Review and durable learning

Keep human annotation, machine run, and review in separate immutable revisions. A review points to differences and assigns a reason: supported disagreement, unsupported target, timing mismatch, recording mismatch, uncertain reference, or listener disagreement. Correcting a reference creates a new annotation revision and requires rescoring; it never silently edits an old benchmark.

Maintain the lexicon, reviewed case index, split manifest, and experiment records in ordinary project files. Every later session loads those artifacts explicitly. This is project persistence, not implicit model retraining or an update to Codex's general memory. Similar examples may be retrieved from development data; evaluation labels must remain inaccessible to the predictor, prompt construction, retrieval, and calibration.

## Processing flow

1. **Ingest:** receive the audio and annotation; preserve originals; hash and decode; validate the pair; assign recording group and split before tuning.
2. **Normalize:** parse YAML safely, rejecting duplicate keys and unsupported tags; convert quoted timestamps to integer milliseconds; preserve original text and nulls; do not execute any annotation content.
3. **Analyze:** call the existing browser audio path on the full recording with current configuration; disable cache reuse unless every relevant identity/version matches. Record actual coverage independently of the duration field.
4. **Export:** capture acoustic evidence plus the exact baseline heuristics under stable versioned names. Use raw timeline onsets where possible; `SongProfile.events.onsets` is capped at 1,500 and is not a complete long-track event source.
5. **Align:** aggregate predictions over annotated spans and intervals. Time boundaries in the human description need not match detected structural boundaries. An emotional change may happen within one musical section.
6. **Compare:** produce coverage, span comparisons, trend direction, foreground-change timing, and unsupported targets. Keep the original human summary visible next to the structured form.
7. **Review:** incorporate explicit human corrections; retain original observations and conflicting listeners. The assistant's explanation is a hypothesis unless supported by measured evidence.
8. **Improve:** record a specific candidate feature/rule/model/calibration change, evaluate against the frozen baseline, and promote only with declared evidence. UI and world behavior are a later consumer, tested separately.

No audio upload, cloud model call, model download, or scheduled job is implied by this design. The first integration can run locally and use the supplied audio directly.

## Time and uncertainty rules

- Times refer to the submitted file's start; trimming and silence removal require a recorded transform and realignment.
- Segments use half-open intervals `[start, end)` with the final endpoint permitted at decoded duration. They must be ordered and non-overlapping. Gaps are unannotated.
- A segment rating is a representative judgment over that span. Do not expand it into artificially precise frame-level ground truth or interpolate between neighboring segment ratings.
- Trends describe a whole interval. Proposed evaluation compares the first and last thirds of the predicted interval and treats a 0.5-point change on a calibrated 0–4 scale as rising/falling; smaller changes are stable. This is a predeclared starting convention to validate on development data, not a perceptual constant. Report the numeric delta too.
- Foreground events use a closed uncertainty interval `[earliest, latest]`. Event timing error is zero inside the interval and distance to its nearest edge outside it. A transition's `from` emotion recedes from the foreground while `to` becomes or remains foreground; they must differ. Match same-direction transitions one-to-one by minimum timing distance, allowing at most 3 seconds outside the reference interval. Report precision/recall at that declared tolerance, matched timing errors, misses, extra events, and reference interval widths. The 3-second tolerance is a proposed convention, not a perceptual constant; freeze it before the held-out comparison.
- Human `confidence` is `high`, `medium`, `low`, or `unrated`. Report strata; do not convert these labels into probabilities or use them to erase difficult examples.
- Model uncertainty, detector confidence, and listener confidence remain distinct. Confidence claims require their own validation.

## Evaluation and improvement

Keep acoustic-descriptor accuracy, emotion intensity, foreground role, emotional-change timing, structural segmentation, and rendered visual quality as separate results. Do not manufacture a single “song understanding percentage.”

For supported targets, report coverage first: rated spans/seconds, supported predictions, missing predictions, exclusions and reasons, and number of independent recording groups. Then report per-dimension absolute rating error and within-one-category agreement; per-emotion role confusion/accuracy; trend-direction agreement with the predicted deltas; and event detection precision/recall with timing error. Compute song-level results before corpus averages so long tracks do not dominate. A missing prediction stays visible in coverage and blocks a claim of improvement based solely on easier remaining samples.

For the current heuristic-only baseline, show plots or tables next to human ratings and label them exploratory. Never compare the 0–1 `tension01` proxy directly with a 0–4 melancholy rating as if they were the same quantity. A separate calibrated mapping, versioned and fit only on development data, is required before such a metric is meaningful. Current “roughness” within BuildCharacter uses tonal-change/confidence proxies; it is not a calibrated acoustic roughness measurement.

Use whole recording groups for splits. Related songs from an artist should also be grouped when the corpus supports an artist-generalization claim. Fit transforms and normalizers on development data only. Use validation data for selection, and a held-out test set once for a declared comparison. If its results guide further tuning, that set is no longer untouched; retain it as regression data and reserve a new independent test set.

The first 12–20 cases refine annotation consistency and workflow. They do not establish general emotion-recognition accuracy. Include counterexamples that break easy shortcuts: bright sadness; dark joy; loud sadness; quiet joy; a foreground reversal with stable loudness/brightness; a song whose lyrics and delivery disagree; and uncertainty about meter or tonality. Additional listeners establish whether a result reflects one person's interpretation or wider agreement.

An improvement report must identify the baseline/candidate commits, corpus and split revisions, coverage changes, per-target changes, regressions, uncertainty from the small sample, and playback effects if applicable. The first release should make comparison reproducible even when it shows that semantic prediction remains unsupported.

## Integration boundaries

Repository locations, with runtime work to refine in the implementation plan:

- `docs/listening/`: vocabulary, listening guide, and example contract, included in this proposal.
- `test/fixtures/listening/`: clearly marked illustrative fixtures, never real evaluation data.
- `src/eval/listening/`: parsing/semantic validation, alignment, supported-target comparison, and report data.
- `tools/listening/`: ingest, production-analysis export, and local report entry points.
- Local corpus storage outside the application bundle: original audio, annotation revisions, manifests, runs, reviews, and split index.

Keep the annotation importer out of normal playback and do not modify `SongProfile`, `AnalysisBundle`, or visual outputs simply to store human reference labels. A later learned emotion profile can be a separately versioned optional sidecar. If it eventually enters playback/cache contracts, update compatibility and migration rules explicitly.

The analysis export must preserve production behavior and observe cancellation. Any new time-resolved features should be retained at the existing computation boundary rather than implemented by a second inconsistent extractor. `VibeDirector` has stateful smoothing; replay it sequentially from a known initial state and fixed step when measuring its baseline, rather than sampling isolated timestamps on reused state. Offline full-song and real-time/causal analysis must be identified separately.

## Required validation for the future implementation

- Accept valid reviewed annotations; reject duplicate YAML keys, malformed timestamps, unknown vocabulary keys, inconsistent absence/intensity, reversed/overlapping spans, and out-of-range values. Preserve unknowns and simultaneous foreground emotions.
- Refuse audio-hash mismatch, out-of-duration annotations, unaligned excerpts, provisional-only coverage, stale analysis versions, and illustrative examples entering a scored corpus.
- Prove reference labels never enter predictor inputs, retrieval, or calibration for held-out cases; group related recordings before splitting.
- Check alignment and missing-output coverage with fixtures representing partial annotations, absent labels, mixed emotions, uncertain takeover times, and missing predictions. Synthetic cases validate bookkeeping, not musical recognition.
- Run at least one real submitted recording through the browser production analyzer, inspect the actual exported values and comparison report, and retain a revision-tagged result. This requires a real song and human annotation; it has not happened in this design task.
- If a later change affects playback, inspect real playback/seek/export behavior and the existing relevant browser checks. An annotation metric does not prove a visual result is better.

## Review decision

Review the listening vocabulary and the distinction between intensity and foreground role first. The next repository phase is an implementation plan for the importer, full-song evidence export, and comparison report. A trained emotion model and automatic runtime behavior changes are subsequent steps justified by the collected evidence.
