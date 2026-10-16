# Midio listening language and feedback pipeline

Version 0.1 proposal · September 30, 2026

This is a reusable way for a human listener to describe a recording, submit the description with its audio, and turn the differences between human perception and Midio's analysis into a growing evaluation corpus. The listening protocol can be used immediately. The repository importer, analysis exporter, comparison report, and calibration loop described here are proposed work, not implemented commands.

The central idea is **a timeline of simultaneous emotional layers**. A bright arrangement can express joy in the foreground while carrying a strong melancholy undertone. Melancholy can then grow and take over while the sound stays bright. We record those facts separately.

## Start with one song

1. Listen without looking at Midio's predictions. Write a sentence describing the whole emotional arc.
2. Mark a few spans where the character is reasonably consistent. Three to eight spans is a starting suggestion, not a rule. Mark only changes that matter; uncertain times are acceptable.
3. In each span, describe the sound and any emotions you hear. Give each emotion an intensity and a role. Leave uncertain fields blank.
4. Mark the moments or intervals where an emotional layer rises, recedes, or takes over. Add a short audible cue if you can identify one.
5. Submit the original audio and the completed `template.song.yaml` together. Ordinary prose and timestamps are also acceptable: the assistant can propose the structured version for you to correct.

Only the audio, your own words, and a few approximate timestamps are essential to begin. The assistant can fill technical metadata; it must not invent listening judgments, exact times, instruments, or harmony you did not report. Assistant-inferred additions stay in draft until you accept them. If you supply the structured judgments yourself, they do not need to be elicited again.

## The vocabulary

The musical terms below are established vocabulary. The particular combination of fields, numeric anchors, and syntax is a Midio convention, not an established scientific scale or a validated emotion detector. Time-varying valence and arousal have precedent in music emotion research; our additional emotional layers and foreground roles are design choices for this project. See the [DEAM benchmark paper](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0173392).

### Describe what sounds present

| Field | What to listen for | Scale endpoints |
| --- | --- | --- |
| `brightness` | Treble emphasis and the apparent brilliance of the timbre | 0 dark or muted; 4 very bright |
| `activity` | Audible movement and drive in the performance | 0 still; 4 very active |
| `loudness` | Perceived level relative to the rest of this recording | 0 very quiet; 4 among its loudest passages |
| `density` | How sparse or crowded the texture feels | 0 very sparse; 4 very dense |
| `roughness` | Audible grain, rasp, or abrasion | 0 smooth; 4 very abrasive |
| `pulse` | Whether a regular beat is apparent | `steady`, `free`, `unclear` |
| `groove` | How the rhythm sits against its beat | `straight`, `swung`, `syncopated`, `mixed`, `unclear` |

Numeric sound fields use integers 0–4. Values 1, 2, and 3 are intermediate descriptions. These are listener ratings, not measured decibels, spectral-centroid values, or probabilities. Only `loudness` explicitly uses the current recording as its reference; use the same vocabulary anchors across songs for the other fields.

“Bright” belongs here when it means the timbre. When it means cheerful, use `joy` under emotions. “Heavy” needs a note about what you mean: bass weight, loudness, dense texture, aggression, or emotional weight. Do not silently convert it into one field.

### Describe what the music expresses

Default `perspective: expressed` means “the emotion I hear the music expressing.” Use `perspective: felt` in a separate annotation if you mean your personal emotional response. A sad song can make you feel comforted; those are different observations.

These definitions keep our annotations consistent. They do not assert a unique acoustic signature for an emotion.

| Emotion | Working meaning |
| --- | --- |
| `joy` | Cheerfulness, pleasure, or delight |
| `melancholy` | Reflective, lingering sadness or wistfulness |
| `sadness` | Direct sorrow or a sense of loss |
| `longing` | A sense of wanting, reaching, or yearning |
| `nostalgia` | A sense of remembrance or the past |
| `tenderness` | Gentleness, affection, or emotional delicacy |
| `calm` | Ease, rest, or peacefulness |
| `unease` | Apprehension, anxiety, or a sense that something is wrong |
| `aggression` | Confrontation, hostility, or forceful attack as an emotional quality |
| `triumph` | Victory, achievement, or overcoming |
| `wonder` | Amazement or awe |
| `playfulness` | Mischief, lightness, or a sense of play |

Do not force every song into all twelve labels. Use the few that help. An unfamiliar emotion stays in `notes` until we decide whether to add a vocabulary entry. Preserve phrases such as “smiling through grief” in the summary even when we also assign structured labels.

For each named emotion, record two independent properties:

| Property | Allowed values | Meaning |
| --- | --- | --- |
| `intensity` | 0 absent; 1 faint; 2 clear; 3 strong; 4 overwhelming | How strongly that emotion is expressed |
| `role` | `foreground`, `undertone`, `absent`, `unclear` | Whether it leads the passage or lives beneath another reading |

An undertone may have intensity 3 or 4. Intensity does not determine foreground status. Two emotions may both be foreground. Intensities do not sum to a fixed total. “Bittersweet” can be represented by coexisting joy and melancholy, with the original word preserved in a note.

`intensity: 0` requires `role: absent`. A missing emotion is **unrated**, not absent. `null` means unknown. Zero never means unknown. For an explicit absence judgment, record the emotion with intensity 0. `confidence` is your certainty about the description, not another measure of emotional intensity.

Optional `affect` fields provide broad summaries: `valence` is negative (−2) through balanced/neutral (0) to positive (+2); `arousal` is emotional activation, 0–4; `tension` is a sense of suspense or strain, 0–4. These summaries supplement the named emotions. In particular, a middle valence rating must not erase mixed emotions. Arousal is distinct from measured audio energy.

### Optional musician and producer detail

Use ordinary musical language in `notes`: crescendo/diminuendo for a level rise/fall; accelerando/ritardando for an actual tempo change; legato/staccato for connected/detached articulation; ostinato for a repeating figure; syncopation for displaced rhythmic emphasis; consonance/dissonance for harmonic relationships; suspension/resolution for harmonic motion; sparse/dense texture; reverb, distortion, and stereo width for production.

Describe an instrument or chord only when you recognize it. “A held, unresolved sound beneath the melody” is useful even without a chord name. A minor-key estimate is evidence about tonality, not proof of sadness. More loudness does not prove more happiness.

## Syntax

The format is ordinary YAML with fixed field names. Quote timestamps as `"mm:ss"` or `"mm:ss.sss"`; minutes may exceed 59. All times are relative to the exact submitted audio file's start. Segments are ordered, non-overlapping intervals. Gaps are allowed and remain unannotated.

```yaml
format: midio-listening/0.1
status: draft
audio_file: "song.flac"
listener: "listener-01"
perspective: expressed
basis: sound
summary: "Cheerful on the surface, with a strong melancholy undertone."
segments:
  - span: ["00:00", "00:45"]
    label: "opening"
    sound: {brightness: 4, activity: 3}
    emotions:
      joy: {intensity: 3, role: foreground}
      melancholy: {intensity: 3, role: undertone}
    confidence: high
    notes: "The cheerful surface and melancholy are both present."
trends: []
events: []
```

`basis` is `sound`, `lyrics`, `sound+lyrics`, or `unspecified`. Here “sound” includes the voice's timbre and delivery, but excludes the meaning of words. If lyric meaning changes your interpretation, say so; a comparison using audio features alone cannot evaluate that part of the annotation.

A segment's numbers describe its representative character. They are not measurements at its first timestamp and do not imply linear interpolation. Subdivide a span if one rating hides a change you want the system to learn.

Use a trend for change across an interval:

```yaml
trends:
  - span: ["00:45", "01:30"]
    target: emotions.melancholy.intensity
    direction: rising
    confidence: high
```

Use an event for a change in foreground:

```yaml
events:
  - within: ["01:25", "01:35"]
    type: foreground_change
    from: joy
    to: melancholy
    confidence: medium
```

`within` is your earliest and latest plausible time for the change. Equal endpoints express an exact marker. A `foreground_change` records that `from` recedes from the foreground while `to` becomes or remains foreground; it can end a period where both were foreground. A growing intensity and a foreground change are separate facts. One can occur without the other. The attached full example uses invented timestamps and ratings solely to demonstrate the user's description; it is excluded from evaluation.

## What happens after submission

**Audio and human annotation → exact recording match → frozen analysis → comparison → reviewed corpus → tested improvement.**

1. **Bind the pair.** Record the file hash, decoded duration, and recording identity. Check timestamps against that duration and preserve the original audio. A different edit, remaster, or excerpt needs an explicit alignment.
2. **Freeze the machine reading.** Run the full recording through the specified Midio revision without supplying the human labels to the analyzer. Save its measurements, heuristic outputs, coverage, and configuration. An opening-only preview or a stale cache is insufficient.
3. **Compare like with like.** Compare supported measurements and predictions on the same time spans. Keep sound evidence, inferred emotion, and listener judgment in separate columns. A feature proxy is not an emotion measurement. Unsupported labels are shown as unsupported.
4. **Review the differences.** Return the correctly captured traits, missed emotional layers, wrong foreground changes, and uncertain interpretations with timestamps. Link each claim to available evidence. If audio was not decoded, say that no audio comparison occurred.
5. **Save the example.** Preserve the human annotation, machine run, and review separately, with versions. Later sessions explicitly load this corpus and vocabulary. The accumulated examples provide durable project knowledge.
6. **Improve and check.** Change an identifiable rule, calibration, feature, or model; rerun development examples; then evaluate on whole recordings excluded from tuning. Test visual interpretation separately after changing a renderer's inputs.

The assistant does not permanently retrain itself by receiving a file. The learning mechanisms are explicit: retrieving reviewed examples, improving analysis code or calibration, and eventually training a separate predictor if the corpus supports it. Every claimed improvement needs a before/after run with coverage and held-out evidence.

## The first collection

Begin with a varied pilot of roughly 12–20 recordings to refine the vocabulary and report format. This is a workflow target, not a claim that twenty songs are enough to train a reliable emotion model. Include bright melancholy, dark-sounding joy, energetic sadness, quiet joy, subtle transitions, abrupt reversals, instrumental music, and cases where lyrics change the reading.

Keep alternate versions and excerpts of the same recording in one evaluation group. Annotate before seeing predictions, retain disagreement between listeners, and reserve evaluation groups before tuning. Start a personal calibration from one listener if that is what we want; broader listener agreement requires additional independent annotations.

## Files in this directory

- [template.song.yaml](./template.song.yaml) — blank human listening form.
- [bright-melancholy.example.song.yaml](./bright-melancholy.example.song.yaml) — illustrative description of the requested emotional arc.
- [listening.schema.json](./listening.schema.json) — proposed structural contract for the YAML's JSON representation.
- [pipeline-design.md](./pipeline-design.md) — current repository findings, integration boundaries, storage, validation, and evaluation rules.

The template is intentionally a draft with blanks. Passing its structural schema does not make it a benchmark-ready example. Recording binding, time validation, review, and dataset partitioning are additional requirements described in the design.
