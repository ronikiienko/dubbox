# DUBBOX: design spec

A tiny browser-based groovebox for dub techno and 90s techno.
One screen, one pattern, about 40 knobs total. You perform it, record it, done.

---

## 0. Minimalism rules (the constitution)

Every future feature must pass these rules. If it doesn't, it isn't added.

1. **Max 4 knobs per module.** Prefer 1–2. Use macros: one knob drives several internal params along hand-tuned curves.
2. **No menus, no dialogs, no hidden pages.** Everything is visible on one screen at all times.
3. **No editors.** No piano roll, no automation lanes, no curve drawing. You *perform* changes.
4. **Fixed structure.** 6 tracks, one 300-bar song, 16th-step grid. Not configurable.
5. **Character is baked in.** Analog drift, saturation, filtering and glue are always on and tuned by us, not exposed.
6. **Buttons beat knobs.** A toggle is cheaper than a knob.
7. **When in doubt, leave it out.**

---

## 1. Stack

- **Vite + TypeScript**, no UI framework, plain DOM + CSS.
- **One AudioWorklet** (`engine/worklet.ts`) contains the whole engine: clock, sequencer, voices, FX, tape.
  - Loaded via `import workletUrl from './engine/worklet.ts?worker&url'`.
- The main thread only does the UI and state, and talks to the worklet by `port.postMessage`.
- Mono voices → stereo only at delay/reverb/tape stage.
- Later (not v1): wrap in Tauri for desktop.

### File layout
```
index.html
src/
  main.ts          boot AudioContext, load worklet, wire UI <-> engine
  params.ts        THE parameter registry (single source of truth, shared by UI + engine)
  state.ts         project model, defaults, JSON text form
  store.ts         where projects live (IndexedDB; swap for a folder on desktop)
  library.ts       open project, autosave, import/export, EXPORT ALL
  projects.ts      the PROJECTS screen
  ui.ts            render screen, knob + step widgets, keyboard
  wav.ts           encode recorded float chunks to WAV or MP3
  video.ts         VIDEO recording: screen capture + engine audio → MP4/WebM
  style.css
  engine/
    worklet.ts     AudioWorkletProcessor: clock, sequencer, mixing, routing
    dsp.ts         small DSP building blocks (ladder, svf, onepole, delayline, tanh, noise, smoother)
    voices.ts      Kick, Hat, Perc, Synth (mono/chord)
    fx.ts          TapeDelay, Reverb (FDN), Phaser, Tape, Glue
```

---

## 2. The instrument

### Tracks (fixed, 7 + GLOBAL): KICK, HAT, PERC, SNARE, BASS, CHORD, MELODY

Every voice has **exactly the same** per-note values.

| Value | Meaning everywhere | KICK | HAT | PERC | BASS / CHORD / MELODY |
|---|---|---|---|---|---|
| *Pitch* (per step) | drums: ±12 st; synths: ±7 scale steps | sine pitch (base 50 Hz) | noise HP frequency (base 8 kHz) | ring + click frequency (base 1.4 kHz) | scale step from Root in the current Scale. BASS F1, CHORD = chord root (octave doesn't matter), MELODY F3 |
| **LP** | lowpass on the voice (brightness) | 4-pole ladder after drive | 2× one-pole LP | 4-pole ladder | ladder cutoff (+ envelope) |
| **Res** | resonance of the voice's filter | ladder res (boom) | HP resonance (ring) | BP Q (ringy ↔ noisy) | ladder res |
| **HP** | highpass, 12 dB. Position 0 = off (bypassed) | 30 Hz–1 kHz | 3–16 kHz | 200 Hz–8 kHz | bass 30 Hz–2 kHz, chord 60 Hz–4 kHz |
| **Decay** | length | ✓ | ✓ | ✓ | ✓ |
| **Dist** | saturation, loudness-matched | ✓ | ✓ | ✓ | ✓ |
| Phs · Lvl · **Pan** · Dly · Rev | mixer; Pan defaults to centre, equal-power, sends stay centred (pre-pan) | ✓ | ✓ | ✓ | ✓ |

**Ratchet** is the first row on every instrument: hits per step 1× (default), 2×, 3×, 4×, 6×, 8×, evenly spaced inside the step (same pitch and values; synths retrigger their envelope). Drawn as ticks along the bottom of the note. Row order is Ratchet, (unique rows), LP, Res, HP, Decay, Dist, Bitcrush, Phs, Lvl, Pan, Dly, Rev, identical on every track. **Bitcrush** (after Dist, before Phs): per position [bits, rate] = off, 12-bit 26 kHz (SP-1200), 12/22k, 10/16k, 8/12k, 8/8k, 6/6k, 5/4k, 4/2.5k; sample-and-hold without anti-aliasing + quantize. CHORD has one extra row on top: **Size**. SNARE has one: **Snap** (snare → clap: 0 = two tuned sine heads 185/330 Hz × pitch with a short pitch drop + a little HP-noise, a round dub snare; 4 = default, body + bright noise, 909-ish; 8 = clap: three band-passed noise bursts 11 ms apart then a tail, no body; three anchors loudness-matched within ~0.7 dB). Keys: 1–7 mute/solo, Q W E R T Y U throws. Files before v4 get an empty SNARE inserted at index 3 (later tracks and their mix ids move up one). HAT has one: **Metal** (crossfade from noise to the 808 cluster of six squares at 205/304/370/523/540/800 Hz × pitch, through the same HP/LP; default 0 = noise). KICK has two: **Punch** (pitch drop at the hit: depth and speed together, 0 = flat sub sine, 4 = default 4×→1× over 30 ms, 8 = hard knock from 13×) and **Click** (1–3 ms beater tick, noise + 2.5 kHz blip through the kick's LP; default 0).
Copying notes between tracks carries every value by its knob position.

### Effects (global)

| Module | Knobs | Notes |
|---|---|---|
| DELAY | **Time** (stepped), **Fbk**, **Tone** | tape echo, the main instrument |
| REVERB | **Size** | dark FDN, size and darkness linked |
| TAPE | **Age** | master: saturation + wow/flutter + hiss + HF loss |

### Global

**Tempo**, **Swing**, **Root** (note), **Volume**.

There are **no knobs**. Everything is per note, and the song-wide values are rows of the GLOBAL lane (3.5).

---

## 3. Sequencer: one linear song

- The whole track is one timeline: **300 bars × 16 steps = 4800 steps per track** (10 min at 120 bpm). It's fixed for now (`SONG_BARS` in `state.ts`).
- No patterns or per-track lengths. Playback runs from the start marker to the end, then loops to bar 1.
- **Loop region** (L or LOOP): loops the selection's steps, or the bar under the playhead when nothing is selected; the same again = off. Setting it moves the start marker to its start; if the playhead is already past it, playback jumps there. A playhead before the loop runs into it. Shown as an accent bracket on the ruler. Transport state only: not saved.
- Grid resolution is 16th steps only. Nothing can be placed off the grid; swing is the only timing offset.
- Steps are on/off (click toggles). No accents or velocity: emphasis comes from per-note values (Lvl, LP, Dist…).
- **Drag a note sideways = move it** along its lane, carrying everything: pitch, slide and every value. Notes it passes over stay; the one it's dropped on is replaced. One undo step.
- **Drag inside a selection = move it** sideways: every note and value in it, on all its tracks (whole bars when it spans every track, as a ruler selection does). The area it lands on is overwritten, like paste; where it was becomes empty. One undo step. A click inside a selection drops it and clicks the step as usual. The cursor shows a hand over a selection.
- **Drag sideways from an empty step** = paint notes across every step you pass. **Right-drag** = erase across the steps you pass (right-click = remove one; no context menu on the timeline).
- **Every step has a pitch**: drag a step vertically, or wheel over an active step Shown as a small number. **Synths (BASS, CHORD, MELODY): scale steps, −7..+7** (7 per octave, in the current Scale, from Root): wrong notes are impossible; chromatic colour comes from switching Scale. **Drums: semitones, −12..+12**, shifting the voice (KICK pitch, HAT/PERC tone). Paste clamps to the target's range. Files before v3 had synth semitones; they're moved to the nearest minor-scale step.
- **Slide = hold** (BASS, CHORD, MELODY). One rule covers 303 slides, long notes and pads: **a slid note doesn't end. Everything, pitch included, moves in a straight line to the next note on its track, wherever it is.** The glide takes as long as the gap you draw (one step for a 303 slide; a bar = a slow bend). Nothing fades and there's no pluck while it slides (its Decay doesn't apply), and the next note doesn't retrigger (its Attack doesn't apply). The last note of a chain isn't slid, so its Decay fades the sound out. In the rows, values a slide overrides are **grayed**: Decay on a note that slides on, Attack on a note slid into. For a quick pitch change after a long hold, put a point with the old pitch just before the new note. A slid note with no later note just decays. A held note is drawn as a band from the note to the next one, lit while it sounds.
  - **⌥-click** a step toggles slide. **⌥-drag right** draws a held note: the start becomes slid, and an end note (same pitch) appears where you let go, where the note fades with that end note's Decay. Notes the drag passes over become points inside the hold.
  - A note added **inside a band** (click or paint) is slid too, so it becomes a point of the hold instead of cutting it.
  - Long notes and pads are chains of notes: each point is a real note with its own values, which glide from point to point (see "Slide glides everything"). Four notes with LP 2 → 6 → 8 → 3 one bar apart make a slow 4-bar sweep.
  - **Length was removed** (v5). Old files convert on load: tie → slid; N steps → slid into a copy of the note N steps on (no ratchet), unless another note came first (that note still retriggers). Before v5 a slide only reached the very next step, so old slides over a gap (which did nothing) are cleared.
- **Swing** 50 / 54 / 58 / 62 / 66 / 75 %, delays every odd 16th by `(swing − 50) / 50` of a step.
- Clock lives in the worklet: `samplesPerStep = sr × 60 / bpm / 4`. Sample-accurate triggers.

### 3.1 Per-note values (locks)
- A track's sound is set **only per note**: its instrument values plus Lvl, Dly, Rev, Phs. There are no knobs at all: song-wide values live on the GLOBAL lane (3.5).
- **Click a track name** to expand it (one at a time). Under its lane, one row per value shows a **bar per note**, height = its value. There's no "set vs default" look: every note simply has a value, all bars are one tone. (GLOBAL keeps bright = set here, dim = held from earlier.)
- Rows come in **groups**, each with its name running vertically down the left and a thin divider (5 px gap) above: **Note** (Ratchet, the voice's own values, Decay) · **Filter** (Lowpass, Resonance, Highpass) · **Color** (Distortion, Bitcrush, Phaser) · **Mix** (Level, Pan) · **Sends** (Delay, Reverb). GLOBAL: **Song** (Scale, Root, Tempo, Swing) · **Delay** · **Reverb** · **Master** (Tape age, Volume). Defined in `rowGroups` (`params.ts`).
- Rows are **editable right where they are** (22 px). **Hold ⌥ over a row = lens**: it pops out 80 px tall *over* its neighbours (shadowed card, nothing below moves), printing each note's position as a number (0–8, or −4…+4 for Pan) for precise drawing. It stays on that row for as long as ⌥ is held, wherever the mouse goes (let go and hold again for another row). Let go of ⌥ = closed (after the drag ends). Row names show their description on hover.
- Drag a bar up/down = set that note's value. Drag across a row = draw values over every note you pass (bar height follows the mouse). Double-click a bar = back to the default.
- **⇧-drag in a row = ramp**: a straight line from where you press to the mouse (dashed guide while dragging); every note under it gets its point on the line, snapped to the positions. Moving back un-does the notes you leave. One undo step.
- **A new note copies the values of the previous note** on its track (or uses the defaults if it's the first). Painting a run carries the current sound forward.
- Old saves: track knob settings that differ from the default are baked into the notes that used them.
- A note whose values **differ from the defaults** gets a small dot on the main lane (shaped notes are visible with the track folded). Deleting a note deletes its values. Saved files store only non-default note values.
- Engine: tracks are mono, so a note's values hold for the track **until the next note**. No interpolation: values change exactly at the note (only the 20 ms anti-click smoothing).
- **Slide glides everything**: on a slid note, pitch *and* all strip values move linearly into the next note's values, over the whole distance to it. Values with fixed choices (Attack, chord Size, Ratchet) switch halfway.

### 3.2 Selection, copy/paste, undo (`edit.ts`)
- **Drag on the ruler** = select whole bars on all tracks (a plain ruler click still moves the start marker). **Shift-drag in the main lanes** = rectangle of steps × tracks. **Esc** or a plain click in the lanes clears it.
- **⌘C / ⌘X** copy / cut. **⌘V** pastes with its top-left at the step under the mouse; hold ⌘ to see a dashed outline of where it lands. Bar selections from the ruler always paste onto the same tracks. **Delete** clears the selection.
- **⌘D** duplicates the selection right after itself and moves the selection onto the copy, so repeated ⌘D keeps extending (4 → 8 → 12 bars…).
- Paste **overwrites** the target area (empty steps included). Notes carry pitch, slide and per-note values. Across tracks every value carries over by knob position (slide only between synth tracks).
- **D = dice**: every value of the selected notes (or the note under the mouse) moves by a random −1 / 0 / +1 position. With the mouse over a bar row, only that row is diced. Press again to keep wandering; each press is one undo step.
- **⌘Z / ⇧⌘Z** undo / redo (100 steps) for all note edits: clicks, paints, drags, bar edits, region edits. GLOBAL values are in it too. Mutes/solo are not.

### 3.3 Defaults in the middle
Values with a neutral "normal" default sit at the **middle position** (4 of 0–8), so every note can go either way: **Decay** (range centred on the default), **Lvl** (in dB: off, −18, −12, −6, **0**, +3, +6, +9, +12), **Pan** (centre), **LP on BASS/CHORD** (±3 octaves). Values whose natural default is "off" or "open" stay at the edge: HP, Dist, Phs, Dly, Rev, Res, drum LP (fully open).

### 3.7 Spring
GLOBAL **Spring** (0 = default) crossfades the shared reverb from the room (FDN) to a **spring tank** with an equal-power curve: per side a feedback delay (37 / 43 ms) whose loop runs through 16 first-order allpasses (a = 0.6) for the dispersive "boing" chirp, LP 4.2 kHz, HP 120 Hz, a soft clip for splash when hit hard, slight modulation. Reverb Size sets the spring's feedback too. Level-matched to the room (tank × 0.33).

### 3.5 GLOBAL lane
The last lane, **GLOBAL**, holds the song-wide values: **Scale, Root, Tempo, Swing, Vol, Delay Time / Fbk / Tone, Reverb Size, Spring, Tape Age**.
- **No notes to place.** Every step has a value. Expand GLOBAL (click its name) and draw in its rows like any value row: a value set on a step **holds until the next set value**; before the first one, the default. Held stretches are drawn dim, set steps bright (with their value when the row is hot).
- Double-click a set step = remove it (the previous value holds through). Dice only touches set values (or the hovered step).
- The GLOBAL lane draws **no note cells**: a thin line with an amber marker wherever a value is set, labelled with what changed (scale name, tempo in bpm, otherwise the value's name). Its open rows draw held values as one continuous fill, not per-step bars.
- No mute/solo/throw. Selection, copy/paste (only GLOBAL → GLOBAL, so ruler copies carry their section's tempo/scale), undo all work.
- Engine: a set value takes over at its step, before that step's notes trigger (so a scale change applies to the note on the same step). Seeking/looping re-resolves the values in force.
- Old saves: global knob settings that differ from the default become GLOBAL values on step 0; v3 CHORD Scale values move to GLOBAL.

### 3.4 Stepped knobs
Every knob snaps to fixed positions: **9** by default (0, ⅛ … 1; bipolar knobs have a centre). Exceptions: Root 12 notes, Delay Time 5, Swing 50/54/58/62/66/75 %, Tempo whole bpm. Locks are stored as position indices.

Song structure = what you place on the timeline, plus mutes and knob moves performed live.

---

## 4. Performance

### 4.1 Dub throws

- Hold **Q W E R T** (tracks 1–5): that track's delay send jumps to 100% while held, then returns. This is the core dub move.
- Keys **1–5** toggle mutes. **Space** = play/stop.

---

## 5. DSP spec

All internal params are smoothed (one-pole, ~20 ms) to avoid zipper noise.
Saturation everywhere is `tanh`. Use 2× oversampling only in the synth filter and tape saturation if aliasing is audible (start without).

### 5.1 Voices

**KICK**
- Sine oscillator. Pitch env: starts at `tune × 4`, exponential decay to `tune` with τ ≈ 30 ms.
- Amp env: exponential decay, `Decay` → 0.1–1.2 s.
- `tanh(x × 1.5)` drive → 4-pole ladder lowpass at `LP` (150 Hz–12 kHz), with `Res`.
- Base pitch fixed at 50 Hz; per-step pitch ±12 st → ~25–100 Hz.

**HAT**
- White noise → 2-pole highpass at 8 kHz × pitch, Q 0.7 + 8 × `Res` → 2× one-pole lowpass at `LP` (2–16 kHz).
- Decay 15–600 ms (low = closed, high = open).

**PERC**
- Noise → bandpass at 1.4 kHz × pitch, Q 1 + 12 × `Res`, plus a 2 ms sine click at half that → 4-pole ladder lowpass at `LP` (0.5–12 kHz).
- Decay 20–400 ms.

**SYNTH** (BASS = 1 note, CHORD = 4 notes)
- Oscillators: saw only (PolyBLEP). No waveform choice.
- **Analog drift (baked in):** each oscillator gets a slow random pitch wander of ±4 cents. CHORD voices are detuned ±6 cents from each other.
- **Scale** (GLOBAL row): the 7 modes on Root, dark → bright, each step changes one note: Loc, Phr, **Min** (default), Dor, Mix, Maj, Lyd. Together they reach all 12 notes. BASS, CHORD and MELODY pitches are all read in it. Borrowing = set Scale at that chord, set it back after.
- **Size** (CHORD row, per note): oct, 5th, tri, **7th** (default), 9th. Stacked thirds from the scale, starting on the note's step, so major/minor/diminished fall out of the scale. **5th is always a perfect fifth** (power chord); tri and up follow the scale strictly, so e.g. step 1 in minor is diminished. Always 4 oscillators: oct/5th/tri double tones an octave up; 9th drops the 5th.
- CHORD **voicing is automatic, around one fixed centre**: every chord tone lands in the window −1…+10 st around F2 (+ Root). So a chord always sounds the same wherever it's pasted, progressions move as few notes as possible, and nothing drifts. Pitch only picks the root step; ±7 gives the same voicing. Step 0 in Min with Size 7th = the old fixed m7 stab. No key compensation on CHORD (it stays in one register). Slide moves each oscillator to its new note.
- One **4-pole ladder filter** (tanh stages), `Cutoff` 40 Hz–12 kHz (exp), `Res` 0–0.95 (self-oscillation just short of max).
- One envelope (fast 2 ms attack, exp decay `Decay` 30 ms–2 s) drives both amp and filter.
  - Filter env amount is fixed at +3 octaves.
- Mono retrigger; pitch moves only via slide.
- Pitch loudness compensation (BASS, MELODY): −2 dB per octave of pitch above root (follows the glide).
- **Attack** (synths, per note, Note group): fade-in time 2 ms (default, the old snap) · 10 · 30 · 80 · 150 · 300 ms · 0.6 · 1.2 · 2.5 s. A retrigger rises from the current level. The filter envelope rises with it.
- Root: BASS base note = MIDI 29 + rootIndex (F1 by default), CHORD = +12.

### 5.2 Tape delay (the important one)
```
in ──► [+]──► delayline(time, wow) ──► out
        ▲                    │
        └── tanh ◄─ LP ◄─ HP ◄┘   × feedback
```
- **Time** steps: `1/16, 1/8, 3/16, 1/4, 3/8` (tempo-synced). Default 3/16.
- Delay time changes are **slewed (~300 ms)**, so the pitch smears like tape. Fractional read with cubic/linear interpolation.
- Small wow on the read position: 0.4 Hz sine, ±0.6 ms, plus a tiny random component.
- **Fbk** 0–1.1. Above 1 it's held in check by `tanh` → blooms instead of exploding.
- **Tone** (single knob, center = neutral):
  - left: LP 6 kHz → 800 Hz, HP fixed 120 Hz (dark, warm)
  - right: HP 120 Hz → 1.5 kHz, LP fixed 6 kHz (thin, telephone)
- Stereo: output L = tap, R = same tap at `time + 11 ms`.
- 25% of the delay output is also fed into the reverb (fixed).

### 5.3 Reverb
- 8-line FDN with a Householder matrix, prime-ish delay lengths (~30–110 ms), slow modulation on 2 lines.
- **Size** → RT60 1.5–14 s, damping LP 7 kHz → 2.5 kHz as size grows (bigger = darker).
- Fixed: predelay 20 ms, input HP 200 Hz, stereo out from decorrelated lines.

### 5.4 Dist (per track)
- Insert after the voice and highpass: voice → HP → **Dist** → phaser → fader → sends.
- `tanh(g·x + b) − tanh(b)`, g = 1 + 30·amount², b = 0.15·amount (slight asymmetry = even harmonics). 0 = bypassed.
- **Loudness stays the same.** Makeup is computed every block for the *current input level*: the RMS of a sine at that level before vs. after the curve. So it's right from a note's first sample, then a slow (300 ms) RMS correction trims the rest. The input level follower runs even when bypassed. Measured: within ±0.5 dB across all settings for quiet, loud and percussive signals.

### 5.5 Phaser (per track)
- One phaser per track, as an insert before the fader, so the sends get the phased sound too.
- 4-stage allpass (Small Stone style), mono, at full Amount summed with dry 50/50.
- **Phs** (per-track knob) → depth + feedback together; rate fixed slow at 0.12 Hz, mildly increasing with Amount (up to 0.4 Hz). 0 = bypassed.

### 5.6 Master chain
```
track: voice ─► hp ─► dist ─► phaser ─► fader ─┬─► sum ─► GLUE ─► TAPE(Age) ─► Volume ─► out
                                 ├─► delay send ─► delay ret ──► sum
                                 └─► reverb send ─► reverb ret ─► sum
```
- **GLUE** (no knob): RMS compressor, ratio 2:1, attack 10 ms, release 150 ms, threshold ≈ −12 dBFS, ~2 dB GR on a typical mix.
- **TAPE / Age** (one macro, 0..1): **0** clean (bypassed) · **0.3** warm (default) · **0.6** good cassette · **1** worn dub cassette.
  - Saturation: pre-emphasis (highs boosted ~3 kHz) → loudness-matched `Drive` (amount 0.55 × Age) → de-emphasis, so highs compress first (tape softness). Overall level stays within ~0.7 dB at any Age.
  - Head bump +0…4 dB at 90 Hz; low cut 10 → 50 Hz; top roll-off 20 → 5 kHz (12 dB), applied after the hiss so hiss is rolled off too.
  - Wow/flutter: random (smooth random targets, not sine LFOs). Wow is shared by both channels (one transport), flutter slightly different per channel. Measured pitch wander ±0.25 % at 0.6, ±0.94 % at 1.
  - Hiss: pink, −90 → −45 dB.
  - "Worn" artifacts start only above Age 0.4: stereo narrows toward mono (width 1 → 0.3), and random **dropouts** (20–120 ms dips in level and highs) become more frequent, up to ~1.5/s at max.
- Final soft clip safety limiter (`tanh` on |x| > 0.9).

---

## 6. Parameter registry (`params.ts`)

The single source of truth. The UI and engine both iterate it. Nothing is hardcoded twice.

```ts
type Curve = 'lin' | 'exp' | 'step';
interface ParamDef {
  id: string;          // 'kick.decay', 'bass.cutoff', 'delay.time', 'mix.3.dly', ...
  label: string;       // 'Decay'
  min: number; max: number; def: number;
  curve: Curve;
  steps?: string[];    // labels for 'step' params (delay time, root)
  unit?: string;       // 'Hz', 's', '%', 'bpm'
}
```
Knob UI value is always normalized 0..1. The engine maps it with the curve.

---

## 7. State & persistence (`state.ts`)

```ts
interface Project {
  version: 2;
  params: Record<string, number>;   // normalized 0..1 base values
  tracks: TrackState[];             // 5
}
interface TrackState {
  s: Uint8Array;                    // 4800 steps: 0 off / 1 on
  note: Int8Array;                  // semitone offset per step
  mute: boolean;
  solo: boolean;
}
```
- In memory: dense typed arrays. On disk: sparse, only hits as `[step, state, note]`.
- v1 files (16-step loops) still load: the loop is tiled across the whole song.
- **A library of projects in the browser**, with no file dialogs needed. The header shows the open project's name; click it (or ⌘O) for **PROJECTS**: every song, newest first, each with its tempo, length, last edit and a tiny overview of where the notes are (tracks × bars). Click a row to open it. In the row: rename (edit the name in place), **COPY** (to the clipboard), **FILE** (download `<name>.json`), **DUP**, **DEL** (with UNDO). At the top: **NEW** (an empty draft), **PASTE** / ⌘V (import copied text), **IMPORT FILE**, **EXPORT ALL** (one `dubbox-library-<date>.json` with every project, which IMPORT/PASTE read back). **NEW makes a draft** (autosaved like any project, marked "draft" in the list). Leaving a draft that has notes asks **Keep this draft?**: a name field, KEEP (Enter), DISCARD, CANCEL (Esc, stays). Renaming a draft keeps it, and kept projects never ask. Leaving an empty project (no notes) deletes it silently, and on start any empty ones left over go. So quick experiments don't pile up, and nothing is lost without a choice.
- **Autosave** into the open project, debounced 500 ms and written at once when the page hides. On start the last open project opens. Switching projects stops playback and clears undo, the selection and the loop; the clipboard carries over.
- **Storage is behind one interface** (`store.ts`: list / read / write / rename / remove). The browser backend is IndexedDB, with metadata and song text in separate stores so the list doesn't load every song, and it asks for persistent storage. A desktop build would swap in a folder of `.json` files. A stored project is the same JSON text a FILE export holds (export adds `name`), so moving between backends is copying text.
- **Migration:** on first run with an empty library, the old single autosave (`localStorage['dubbox.project']`) becomes "My song", and the old text is kept under `dubbox.project.backup`.

### Messages
Defined in `src/engine/bridge.ts`. Param values are **normalized 0..1**. The worklet imports `params.ts` and maps them itself.

main → worklet:
- `{t:'init', project}` full state when audio starts, and on switching projects
- `{t:'param', id, v}`
- `{t:'step', i, si, s, note}` one step changed
- `{t:'flags', i, mute, solo}`
- `{t:'throw', i, on}`
- `{t:'play', on, from}` from = song step
- `{t:'rec', on}`

worklet → main:
- `{t:'pos', phase}` ~30 Hz, song position in 16th steps. The UI extrapolates between reports.
- `{t:'audio', l, r}` 8192-frame chunks while recording
- `{t:'recEnd', sampleRate}` after the final chunk

---

## 8. Recording

- **REC** button: records the master output in realtime while you perform. The worklet streams chunks, and on stop it encodes a **24-bit WAV** or a **320 kbps MP3** (the WAV/MP3 toggle next to REC, remembered in localStorage; LAME via `@breezystack/lamejs`) and downloads it (`dubbox-<date>.wav` / `.mp3`). MP3 needs a 32/44.1/48 kHz context, otherwise it falls back to WAV.
- **VIDEO** (third REC format): REC asks the browser to share a screen/tab (Chrome offers the current tab first; pick it), then records that picture with the engine's own audio taken straight from the graph (a `MediaStreamAudioDestinationNode`, so it's clean, no mic) via `MediaRecorder`: MP4 (H.264 + AAC) where the browser can encode it, otherwise WebM; 60 fps, 8 Mbit/s video, 256 kbit/s audio. Stops with REC or the browser's own "Stop sharing". The format can't change mid-recording. Code: `video.ts`.
- **EXPORT** button: renders the whole song **offline**, without playing it and faster than realtime. A Web Worker runs the same engine code (`worklet.ts`, with the AudioWorklet globals shimmed, `offline/shim.ts`) at 48 kHz from bar 1 to one bar past the last note. It then stops the clock, so held and tied notes release, and keeps rendering until the delay and reverb tails fall below −60 dB for a second (at most 20 s). The file is MP3 when the REC format is MP3, otherwise WAV. Mute/solo apply as in playback, and loops and throws are ignored. The button shows progress, then ENCODING. Code: `offline/worker.ts`.
- No offline render. The performance *is* the arrangement.

---

## 9. UI layout (one screen, dark, monospace)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ DUBBOX  ▶ PLAY ● REC FOLLOW   Tempo Swing Root Vol                song name  │
├───────────────────────────────────────────────────────────────────────────────┤
│               │ 1               2               3        ◄ ruler  │           │
│ KICK  [M][S]  │ ■ □ □ □ ■ □ □ □ ■ □ □ □ ■ □ □ □ ■ □ □ □ ■ □ □ ...│ 
│ HAT   [M][S]  │ □ □ ■ □ □ □ ■ □ □ □ ■ □ □ □ ■ □ □ □ ■ □ □ □ ■ ...│ Tone Decay        │
│ PERC  [M][S]  │      ← one horizontal scroller, 300 bars →        │ Tone Decay        │
│ BASS  [M][S]  │ ■ □ □ ■ □ □ ■ □ □ □ ■ □ □ □ □ □ ■ □ □ ■ □ □ ■ ...│ Shp Cut Res Dec   │
│ CHORD [M][S]  │ □ □ □ ▣ □ □ □ □ □ □ ■ □ □ □ □ □ □ □ □ ▣ □ □ □ ...│ Shp Cut Res Dec   │
├───────────────────────────────────────────────────────────────────────────────┤
│ DELAY Time Fbk Tone │ REVERB Size │ TAPE Age                                  │
└───────────────────────────────────────────────────────────────────────────────┘
```
- The timeline is one canvas, virtualized (only visible steps are drawn).
- ■ on, bar lines + numbers on the ruler, playhead = vertical line.
- **Ruler click** = set the start marker (bar-quantized). Play starts there, and Stop returns there.
- **FOLLOW** (key `F`): while playing, the view scrolls smoothly with the playhead at 25% from the left. Any manual scroll turns it off.
- Vertical mouse wheel scrolls the timeline horizontally (except over an active synth step, where it changes the note).
- **Zoom** (horizontal only, smooth): ⌘/Ctrl-wheel or trackpad pinch zooms around the mouse; `−` / `=` around the mouse too (or the middle). While FOLLOW is on and playing, zoom pivots on the playhead instead and follow stays on. The step width glides continuously (eased, ~50 ms, even in log space) between 22 px and 1 px (fully out, the whole 300-bar song is 4800 px); a wheel notch or key press ≈ ×1.6, pinch follows the fingers. Cell edges snap to whole pixels so it stays crisp. Zoomed out, cells touch and the small print hides (note numbers and value labels below 16 px; slide, ratchet and value dots below 11 px; GLOBAL labels below 6 px), and the ruler numbers every 2, 4, 8… bars. Editing works the same at any zoom.
- Knobs: vertical drag (Shift = fine), value tooltip while dragging, double-click = reset.
- Knob visual: arc = base, dot = live value (shows throws).
- Colors: near-black background, off-white text, one accent color (amber) for active/playhead, red only for REC.

Keyboard: `Space` play · `1–6` mute · `Shift+1–6` solo · `Q W E R T Y` hold = dub throw · `F` follow.

---

## 10. New project

A new project (first launch and **NEW**) is **empty**: no steps on the 300-bar timeline, all knobs at their registry defaults. Pressing Play on it is silent apart from faint tape hiss.

---

## 11. Out of scope (v1). Do not build.

Plugins · audio import/samples · patterns/loops · piano roll · automation lanes · MIDI · per-track effects beyond the phaser · EQ · presets browser · themes · mobile layout.

Candidates for v2, only if missing after real use: MIDI clock out/in, zoom, drift knob, A/B scenes + morph, sampler/bit mode inside TAPE, Tauri desktop build.

---

## 12. Acceptance checklist

- [ ] `npm run dev` → page loads → empty project → enter a few steps → Play → sounds like dub techno.
- [ ] No clicks/zipper noise when turning any knob.
- [ ] Delay Fbk at max blooms and saturates, never blows up. Changing Time smears pitch.
- [ ] Holding Q–T throws a track into the delay.
- [ ] Paint 300 bars' worth of hits by dragging; FOLLOW keeps the playhead in view; ruler click sets the start.
- [ ] REC → perform → stop → valid WAV downloads.
- [ ] EXPORT → the whole song downloads, ending after the last note's tail.
- [ ] Reload page → everything restored.
- [ ] CPU < 15% of one core on a modern laptop at 48 kHz.
