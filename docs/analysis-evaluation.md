# Audio-analysis evaluation

Run section metrics against a held-out set of human annotations:

```sh
npm run bench:sections -- path/to/corpus.json
```

The corpus is an array (or an object with a `tracks` array). Each track has an
identifier, duration, a reference segmentation, and the segmentation emitted
by the analysis pipeline:

```json
[
  {
    "id": "track-001",
    "durationMs": 218000,
    "reference": {
      "boundariesMs": [0, 32000, 76000, 128000, 218000],
      "labels": ["A", "B", "A", "C"]
    },
    "estimate": {
      "boundariesMs": [0, 31800, 75500, 129100, 218000],
      "labels": [0, 1, 0, 2]
    }
  }
]
```

The report includes boundary F-measure at 0.5 s and 3 s, median boundary
deviation, pairwise form-label F-measure, and over/under-segmentation NCE.
Keep final evaluation tracks separate from tuning tracks. Synthetic unit cases
protect algorithmic regressions, but they are not a substitute for a real,
annotated music corpus.

No revision-tagged held-out music result is checked into this tree. CI does
not run `bench:sections`. See [test-matrix.md](./test-matrix.md) for what
the Test workflow actually measures.

World *visual* quality is a separate protocol: see
[world-quality-evaluation.md](./world-quality-evaluation.md) and
`npm run eval:worlds`. Section metrics here do not measure watchability,
and world-quality ratings do not measure boundary F-measure.

## Human listening annotations

The proposed [Midio listening language](./listening/README.md) describes sound,
simultaneous emotions, and changes in their foreground roles over time. Start
with its [annotation template](./listening/template.song.yaml) and see the
[pipeline design](./listening/pipeline-design.md) for recording identity,
reference separation, comparison, and evaluation requirements.

The authoring format and schema are available for review. The importer,
full-recording evidence export, comparison runner, and calibrated emotion
predictor are not implemented by this proposal. Illustrative examples must
not be used as real evaluation data.
