# DUBBOX

A tiny browser groovebox for dub techno and 90s techno. One screen, one 300-bar song, every sound shaped **per note**.

### ▶ [Open DUBBOX](https://ronikiienko.github.io/dubbox/)

Runs entirely in the browser (Chrome, Safari, Firefox on desktop). Nothing to install, no account. Your project autosaves in the browser.

<!-- demo video goes here -->

## Philosophy

**Music that moves.** In most DAWs change is an afterthought: you write a loop, then fight automation lanes to make it evolve, and usually you don't bother. Here **every note carries its own sound**: filter, decay, distortion, pan, sends. Shaping the sound is the same act as writing the notes, so tracks come out alive by default.

**Gestures, not chores.** Setting the same value on twenty notes one by one is busywork. Draw across notes, ⇧-drag a ramp, dice a selection: one move changes many notes.

**Snap everything.** Values have a few fixed positions (mostly 9), the grid is 16ths only, there's no velocity. Fewer choices, each one audible. You decide faster and stop fiddling.

**One screen, one place per thing.** No menus, dialogs, plugin windows or mixer pages. Everything is visible, and every parameter lives in exactly one place.

**Fixed structure.** Seven tracks, one 300-bar song. The limits are the point: they push you to make something instead of configuring something.

**Character baked in, genre not.** Analog drift, tape, saturation and glue are always on and tuned, so it sounds good from the first note. But there are no presets and no ready-made patterns. The music is yours, not made for you.

**Perform it.** Throws, mutes, loops, then REC. Play the song like a dub engineer at the desk, record it, done.

**When in doubt, leave it out.**

## What it is

- **7 tracks:** KICK, HAT, PERC, SNARE, BASS, CHORD, MELODY, plus a **GLOBAL** lane for tempo, scale, swing, delay and reverb.
- **One linear song** on a 16th-step grid. No patterns: you draw the whole track on one timeline.
- **No knobs, no automation lanes.** Click a track name to open its value rows, grouped as Note · Filter · Color · Mix · Sends, and set them per note.
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
