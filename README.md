# DUBBOX

A tiny browser groovebox for dub techno and 90s techno. One screen, one 300-bar song, every sound shaped **per note**.

### ▶ [Open DUBBOX](https://ronikiienko.github.io/dubbox/)

Runs entirely in the browser (Chrome, Safari, Firefox on desktop). Nothing to install, no account. Your project autosaves in the browser.

<!-- demo video goes here -->

## What it is

- **7 tracks:** KICK, HAT, PERC, SNARE, BASS, CHORD, MELODY, plus a **GLOBAL** lane for tempo, scale, swing, delay and reverb.
- **One linear song** on a 16th-step grid. No patterns: you draw the whole track on one timeline.
- **No knobs, no automation lanes.** Click a track name to open its value rows (filter, decay, distortion, sends…) and set them **per note**. Draw across notes, or ⇧-drag a straight ramp, to make things move.
- **Dub tools:** tape delay with hold-a-key throws, room/spring reverb, tape saturation, mute/solo for live arranging.
- **REC** records what you hear to WAV or MP3.

## Basics

| Do | How |
|---|---|
| Play / stop | `Space` |
| Place / remove notes | click a step, drag sideways to paint |
| Pitch | drag a note up/down, or wheel over it |
| Per-note values | click a track name, then drag in its rows |
| Magnify a row | hold `⌥` over it |
| Ramp | `⇧`-drag in a value row |
| Select bars / loop them | drag on the ruler, then `L` |
| Zoom | `⌘`-wheel, pinch, or `−` / `=` |
| Copy / paste / duplicate | `⌘C` `⌘V` `⌘D` |
| Dice (random nudge) | `D` |
| Dub throw | hold `Q W E R T Y U` |
| Mute / solo | `1–7` / `⇧1–7` |

Press **?** in the app for the full list.

**SAVE / LOAD** export and import the project as a JSON file. Use them to move a song between browsers or machines.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173/
```

`npm run build` makes a production build in `dist/`. Every push to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`.

Design notes and the full spec are in [DESIGN.md](DESIGN.md).
