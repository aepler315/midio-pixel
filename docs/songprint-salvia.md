# What Salvia reports bring to Songprint 2D

## Reading the archive

Psychonaut Engine’s dedicated Salvia dataset contains 2,552 distinct Erowid experience IDs. We parsed each JSONL record, counted its topic tags, and reran the archive’s case-insensitive patterns against each report body, counting each report once per theme. The patterns matched language about pull or rotation in 1,225 reports, repetition or déjà vu in 864, and becoming an object or surface in 109. A single report can match all three. [Dataset and published counts](https://github.com/aepler315/Psychonaut-Engine/blob/41804a6178ffb139fb23fbdd3dd5e4efa588d72b/Substances/Salvia/salvia_dataset/salvia_simulation_distillate.md#24-phenomenology-taxonomy) · [Matching rules](https://github.com/aepler315/Psychonaut-Engine/blob/41804a6178ffb139fb23fbdd3dd5e4efa588d72b/Substances/Salvia/salvia_distill.py#L36-L56)

The reports were submitted voluntarily. Everyday uses of words such as “turning” and “repeated” count, too. The explicit *Entities / Beings* tag appears on 701 reports, while a pattern that includes “people” and “someone” matches 2,320. The same archive includes 530 *Difficult Experiences* and 254 *Glowing Experiences* tags. These overlapping counts describe the collection and leave room for very different accounts of the same motif. [Corpus profile](https://github.com/aepler315/Psychonaut-Engine/blob/41804a6178ffb139fb23fbdd3dd5e4efa588d72b/Substances/Salvia/salvia_dataset/salvia_simulation_distillate.md#21-corpus-profile)

## Three accounts that shaped the motion

- A bedroom separates into upright sheets that still depict the furniture. Friends pull the seams apart. The narrator recognizes themself as another zipper and later recognizes a friend as the room returns. [Trendal, experience 16151](https://www.erowid.org/experiences/exp.php?ID=16151)
- A listener feels ambient music push their body forward, then feels like the box carried on a conveyor. This account also describes alcohol and cannabis. [Easton, experience 27490](https://www.erowid.org/experiences/exp.php?ID=27490)
- A sideways wheel keeps turning while a companion’s familiar laugh gives the narrator a way back. [The Ferris Wheel of Consciousness, experience 3134](https://www.erowid.org/experiences/exp.php?ID=3134)

## Design reading

The reports suggested a small perceptual change worth trying. If a line slips sideways and leaves part of itself behind, the viewer can briefly lose track of which edge belongs to which surface. Songprint 2D uses that change in both impressions. The print supplies the shapes, and the recording determines when the layers pull apart or happen to line up.
