# DUBBOX

A tiny browser groovebox for dub techno and 90s techno. One screen, one 300-bar song, every sound shaped **per note**.

### ▶ [Open DUBBOX](https://ronikiienko.github.io/dubbox/)

Runs entirely in the browser (Chrome, Safari, Firefox on desktop). Nothing to install, no account. Your projects autosave in the browser.

https://github.com/user-attachments/assets/67a7d3b9-a274-40c2-8971-85e9f0ae70e3

https://github.com/user-attachments/assets/0cf6a14f-f53a-435a-91c5-f45d84d625f5

## Philosophy

DUBBOX came from feeling overwhelmed by everything a DAW like FL Studio puts in front of you.

FL Studio's automation is super flexible, but I wanted something more accessible. So here almost everything is **per note**: each note carries its own filter, decay, distortion, pan, sends and so on. Changing the sound over time is part of writing the notes, not a separate automation job.

The rest is simplified the same way. There's no piano roll, and I tried to add only what's necessary. With fewer options, you have to turn on your creativity instead of searching through features.

## What it is

- **7 tracks:** KICK, HAT, PERC, SNARE, BASS, CHORD, MELODY, plus a **GLOBAL** lane for tempo, scale, swing, delay and reverb.
- **One linear song** on a 16th-step grid. No patterns: you draw the whole track on one timeline.
- **No knobs, no automation lanes.** Click a track name to open its value rows, grouped as Note · Filter · Color · Mix · Sends, and set them per note.
- **Dub tools:** tape delay with hold-a-key throws, room/spring reverb, tape saturation, mute/solo for live arranging.
- **REC** records what you hear to WAV or MP3, or a **VIDEO** of the app with its sound (pick this tab when the browser asks).
- **EXPORT** renders the whole song to WAV or MP3 offline: nothing has to play, and it's faster than realtime.

## Basics

| Do | How |
|---|---|
| Play / stop | `Space` |
| Place / remove notes | click a step · drag from an empty step to paint · right-drag to erase |
| Move a note (with all its values) | drag it sideways · select first to move many |
| Pitch | drag a note up/down, or wheel over it |
| Held note / slide (synths) | `⌥`-drag right / `⌥`-click |
| Per-note values | click a track name, then drag in its rows |
| Ramp | drag in a value row to set the start, then hold `⇧` and move to the end |
| Select bars / loop them | drag on the ruler, then `L` |
| Zoom | `⌘`-wheel, pinch, or `−` / `=` |
| Copy / paste / duplicate | `⌘C` `⌘V` `⌘D` |
| Dice (random nudge) | `D` |
| Dub throw | hold `Q W E R T Y U` |
| Mute / solo | `1–7` / `⇧1–7` |

Press **?** in the app for the full list.

**Projects** live in the browser: click the song name in the header (or `⌘O`) to open, rename, duplicate or delete them. **COPY** puts a song on the clipboard to paste anywhere, and `⌘V` in Projects imports one. **FILE** and **EXPORT ALL** download one song or every song, for backups or moving to another browser. Clearing the browser's site data deletes your projects, so export now and then.

## Todo: current challenges

- **Balancing simplicity and flexibility,** especially with effects. Right now they're quite limited and premade, but a full mixer with effect chains would bring back the overwhelm this app is trying to avoid. The goal is to find the middle ground.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173/
```

`npm run build` makes a production build in `dist/`. Every push to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`.

Design notes and the full spec are in [DESIGN.md](DESIGN.md).
