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
| *Pitch* (per step) | drums: ±12 st; synths: ±7 scale steps | sine pitch (base = Root, D1…C#2) | noise HP frequency (base 8 kHz) | ring + click frequency (base 1.4 kHz) | scale step from Root in the current Scale. BASS F1, CHORD = chord root (octave doesn't matter), MELODY F3 |
| **LP** | lowpass on the voice (brightness) | 4-pole ladder after drive | 2× one-pole LP | 4-pole ladder | ladder cutoff (+ envelope) |
| **Res** | resonance of the voice's filter | ladder res (boom) | HP resonance (ring) | BP Q (ringy ↔ noisy) | ladder res |
| **HP** | highpass, 12 dB. Position 0 = off (bypassed) | 60–420 Hz | 7–17.5 kHz | 1.3–10 kHz | bass 60 Hz–1 kHz, chord 130 Hz–1.4 kHz, mel 170 Hz–1.5 kHz |

**Filter tuning** (`LP_HZ`, `HP_HZ` in `params.ts`): every LP and HP position is a measured cutoff per instrument, not a min–max curve, so each of the 9 steps is an even, audible change. Measured by rendering one note per position through the engine (track at −20 dB so the master glue stays out of it): LP by A-weighted level (≈ brightness), HP by K-weighted loudness (counts losing the low end). Result: LP ≈ 2.5–3 dB per step from open down to about −23 dB (kick −15: below that it's only sub), HP ≈ 2.5–3 dB per step to about −24 dB. Between positions (slides, ramps) the cutoff is log-interpolated. Synth LP: the pluck opens the filter 3 octaves at each note, so above ~2 kHz nothing changes; their default (middle) sits where the steep part begins, so the upper half still brightens (~1 dB a step) and the lower half darkens fast. Hat HP and snare HP measure small (hats have little below 8 kHz; the snare HP takes the body off first, which you hear more than you measure). The defaults moved with the tables: CHORD 600 → 230 Hz, MELODY 1.5 kHz → 250 Hz (both were in the dead zone), BASS 220 → 250 Hz.
| **Decay** | length | ✓ | ✓ | ✓ | ✓ |
| **Dist** | saturation, loudness-matched | ✓ | ✓ | ✓ | ✓ |
| Phs · Lvl · **Pan** · Dly · Rev | mixer; Pan defaults to centre, equal-power, sends stay centred (pre-pan) | ✓ | ✓ | ✓ | ✓ |

**Ratchet** is the first row on every instrument: hits per step 1× (default), 2×, 3×, 4×, 6×, 8×, evenly spaced inside the step (same pitch and values; synths retrigger their envelope). Drawn as ticks along the bottom of the note. Row order is Ratchet, (unique rows), LP, Res, HP, Decay, Dist, Bitcrush, Phs, Lvl, Pan, Dly, Rev, identical on every track. **Bitcrush** (after Dist, before Phs): per position [bits, rate] = off, 12-bit 26 kHz (SP-1200), 12/22k, 10/16k, 8/12k, 8/8k, 6/6k, 5/4k, 4/2.5k; sample-and-hold without anti-aliasing + quantize. CHORD has one extra row on top: **Size**. SNARE has one: **Snap** (snare → clap: 0 = two tuned sine heads 185/330 Hz × pitch with a short pitch drop + a little HP-noise, a round dub snare; 4 = default, body + bright noise, 909-ish; 8 = clap: three band-passed noise bursts 11 ms apart then a tail, no body; three anchors loudness-matched within ~0.7 dB). Keys: 1–7 mute/solo, Q W E R T Y U throws. Files before v4 get an empty SNARE inserted at index 3 (later tracks and their mix ids move up one). HAT has one: **Metal** (crossfade from noise to the 808 cluster of six squares at 205/304/370/523/540/800 Hz × pitch, through the same HP/LP; default 0 = noise). KICK has two: **Punch** (pitch drop at the hit: depth and speed together, 0 = flat sub sine, 4 = default 4×→1× over 30 ms, 8 = hard knock from 13×) and **Click** (1–3 ms beater tick, noise + 2.5 kHz blip through the kick's LP; default 0).
Copying notes between tracks carries every value by its knob position.

### Effects (global)

| Module | Knobs | Notes |
|---|---|---|
| DELAY | per track, lanes (any step, held): **Time** (stepped), **Fbk**, **Tone**, **Wobble**, **Spread**, **→ Rev**; per-note send | tape echo, the main instrument |
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
- **Every step has a pitch**: drag a step vertically, or mouse-wheel over an active step. Shown as a small number. **Synths (BASS, CHORD, MELODY): scale steps, −7..+7** (7 per octave, in the current Scale, from Root): wrong notes are impossible; chromatic colour comes from switching Scale. **Drums: semitones, −12..+12**, shifting the voice (KICK pitch, HAT/PERC tone). Paste clamps to the target's range. Files before v3 had synth semitones; they're moved to the nearest minor-scale step.
- **Slide = hold** (BASS, CHORD, MELODY). One rule covers 303 slides, long notes and pads: **a slid note doesn't end. Everything, pitch included, moves in a straight line to the next note on its track, wherever it is.** The glide takes as long as the gap you draw (one step for a 303 slide; a bar = a slow bend). Nothing fades and there's no pluck while it slides (its Decay doesn't apply), and the next note doesn't retrigger (its Attack doesn't apply). The last note of a chain isn't slid, so its Decay fades the sound out. In the rows, values a slide overrides are **locked**: Decay on a note that slides on, Attack on a note slid into. Drawn as an empty outline; hovering shows "locked: slides on" / "locked: slid into" and a not-allowed cursor; pressing, drawing across, ramps, double-click and dice all skip them. The stored value is kept and comes back when the slide goes (⌥-click it off, or the next note is removed). For a quick pitch change after a long hold, put a point with the old pitch just before the new note. A slid note with no later note just decays. A held note is drawn as a band from the note to the next one, lit while it sounds.
  - **⌥-click** a step toggles slide. **⌥-drag right** draws a held note: the start becomes slid, and an end note (same pitch) appears where you let go, where the note fades with that end note's Decay. Notes the drag passes over become points inside the hold.
  - A note added **inside a band** (click or paint) is slid too, so it becomes a point of the hold instead of cutting it.
  - Long notes and pads are chains of notes: each point is a real note with its own values, which glide from point to point (see "Slide glides everything"). Four notes with LP 2 → 6 → 8 → 3 one bar apart make a slow 4-bar sweep.
  - **Length was removed** (v5). Old files convert on load: tie → slid; N steps → slid into a copy of the note N steps on (no ratchet), unless another note came first (that note still retriggers). Before v5 a slide only reached the very next step, so old slides over a gap (which did nothing) are cleared.
- **Swing** 50 / 54 / 58 / 62 / 66 / 75 %, delays every odd 16th by `(swing − 50) / 50` of a step.
- Clock lives in the worklet: `samplesPerStep = sr × 60 / bpm / 4`. Sample-accurate triggers.

### 3.1 Per-note values (locks)
- A track's sound is set **only per note**: its instrument values plus Lvl, Dly, Rev, Phs. There are no knobs at all: song-wide values live on the GLOBAL lane (3.5).
- **Click a track name** to expand it (one at a time). Under its lane, one row per value shows a **bar per note**, height = its value. There's no "set vs default" look: every note simply has a value, all bars are one tone. A bar whose value **differs from the previous note's** in that row (the first note: from the default) shows the **difference itself in amber**: the span between the previous value and this one (a rise: the top of the bar; a drop: an amber block above the bar, the part that went away). The bar itself stays gray. (Tried: an amber cap on top, then the whole bar amber.) Locked values get none. Every other row is shaded a little lighter so each row reads as its own band. (Tried: bright = changed / dim = repeated, and dots joined by a line instead of bars; bars read better.) GLOBAL and lanes the same: at a step where the value changes, the jump between old and new is amber; set here = brighter fill, held = dim. Amber always means "this much changed here".
- Rows come in **groups**, each with its name running vertically down the left and a thin divider (5 px gap) above: **Note** (Ratchet, the voice's own values, Decay) · **Filter** (Lowpass, Resonance, Highpass) · **Color** (Distortion, Bitcrush, Phaser) · **Mix** (Level, Pan) · **Sends** (Delay, Dly time, Dly fbk, Dly tone, Dly wobble, Dly spread, Dly → rev, Reverb; the Dly rows are lanes, see 5.2). GLOBAL: **Song** (Scale, Root, Tempo, Swing) · **Reverb** · **Master** (Tape age, Volume). Defined in `rowGroups` (`params.ts`).
- Rows are **22 px and all work happens right there**: no magnifier, nothing to hold; the precision comes from the slider below. **Pressing in a row pops a tall slider out of that note** (only that one; nothing moves): a rail up to 180 px (12 px per position, a tick each), the value as a bar, its number on a tag on top, floating over the rows with a shadow and kept inside the visible panel. It opens with the note's value right at the mouse, so nothing jumps. Drag up/down = that note's value. Drag sideways = draw: the slider follows the pen and each note gets the pen's height on it. Hold ⇧ during the drag = ramp: it rides the ramp's moving end. Let go = gone. When not dragging, the note under the mouse shows its value on a small dark tag at the top of its row: the position 0–8, −4…+4 for Pan, or the step's name ("80 ms", "9th"). Nothing else shows numbers. Each row's name shows its description on hover, and the row under the mouse lights its name.
- Drag a bar up/down = set that note's value. Drag across a row = draw values over every note you pass (bar height follows the mouse). Double-click a bar = back to the default.
- **Ramp: press in a row, set the start value on the slider, then hold ⇧ and move**: a straight line from the pressed note, at the value you set, to the mouse (dashed guide while dragging), the slider riding its end for the end value; every note under it gets its point on the line, snapped to the positions. Moving back un-does the notes you leave. One undo step.
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
- **Box vs section.** A box of notes (⇧-drag, or a single note) copies only the notes and their per-note values; held rows (GLOBAL, echo Time/Fbk lanes) are left untouched on copy, cut, paste and move. A **section** (ruler selection: whole bars, every track) carries held rows too, without disturbing the song around it: the pasted part starts with the values in force where it was copied from, and right after it the values that were in force there before carry on. Clearing a section keeps the value in force after it the same. Redundant points are dropped (only changes are stored).
- **D = dice**: every value of the selected notes (or the note under the mouse) moves by a random −1 / 0 / +1 position. With the mouse over a bar row, only that row is diced. Press again to keep wandering; each press is one undo step.
- **⌘Z / ⇧⌘Z** undo / redo (100 steps) for all note edits: clicks, paints, drags, bar edits, region edits. GLOBAL values are in it too. Mutes/solo are not.

### 3.3 Defaults in the middle
Values with a neutral "normal" default sit at the **middle position** (4 of 0–8), so every note can go either way: **Decay** (range centred on the default), **Lvl** (in dB: off, −18, −12, −6, **0**, +3, +6, +9, +12), **Pan** (centre), **LP on BASS/CHORD** (±3 octaves). Values whose natural default is "off" or "open" stay at the edge: HP, Dist, Phs, Dly, Rev, Res, drum LP (fully open).

### 3.7 Spring
GLOBAL **Spring** (0 = default) crossfades the shared reverb from the room (FDN) to a **spring tank** with an equal-power curve: per side a feedback delay (37 / 43 ms) whose loop runs through 16 first-order allpasses (a = 0.6) for the dispersive "boing" chirp, LP 4.2 kHz, HP 120 Hz, a soft clip for splash when hit hard, slight modulation. Reverb Size sets the spring's feedback too. Level-matched to the room (tank × 0.33).

### 3.5 GLOBAL lane
The last lane, **GLOBAL**, holds the song-wide values: **Scale, Root, Tempo, Swing, Vol, Reverb Size, Spring, Tape Age**. (The echo's settings are per track, see 5.2.)
- **No notes to place.** Every step has a value. Expand GLOBAL (click its name) and draw in its rows like any value row: a value set on a step **holds until the next set value**; before the first one, the default. Held stretches are drawn dim, set steps bright (with their value when the row is hot).
- Double-click a set step = remove it (the previous value holds through). Dice only touches set values (or the hovered step).
- The GLOBAL lane draws **no note cells**: a thin line with an amber marker wherever a value is set, labelled with what changed (scale name, tempo in bpm, otherwise the value's name). Its open rows draw held values as one continuous fill, not per-step bars.
- No mute/solo/throw. Selection, copy/paste (only GLOBAL → GLOBAL, so ruler copies carry their section's tempo/scale), undo all work.
- Engine: a set value takes over at its step, before that step's notes trigger (so a scale change applies to the note on the same step). Seeking/looping re-resolves the values in force.
- Old saves: global knob settings that differ from the default become GLOBAL values on step 0; v3 CHORD Scale values move to GLOBAL.

### 3.4 Stepped knobs
Every knob snaps to fixed positions: **9** by default (0, ⅛ … 1; bipolar knobs have a centre). Exceptions: Root 12 notes, Dly time 9, Dly tone 17, Swing 50/54/58/62/66/75 %, Tempo whole bpm. Locks are stored as position indices.

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
- `tanh(x × 1.5)` drive → 4-pole ladder lowpass at `LP` (70 Hz–12 kHz, see Filter tuning), with `Res`.
- **Base pitch = Root**, in D1…C#2 (37–69 Hz; default F → F1 43.7 Hz), so a long kick tail is in key with the bass. Per-step pitch ±12 st from there. (Until the Root fix it was a fixed 50 Hz, between G and G#.)

**HAT**
- White noise → 2-pole highpass at 8 kHz × pitch, Q 0.7 + 8 × `Res` → 2× one-pole lowpass at `LP` (1.9–16 kHz).
- Decay 15–600 ms (low = closed, high = open).

**PERC**
- Noise → bandpass at 1.4 kHz × pitch, Q 1 + 12 × `Res`, plus a 2 ms sine click at half that → 4-pole ladder lowpass at `LP` (0.7–12 kHz).
- Decay 20–400 ms.

**SYNTH** (BASS = 1 note, CHORD = 4 notes)
- Oscillators: saw only (PolyBLEP). No waveform choice.
- **Analog drift (baked in):** each oscillator gets a slow random pitch wander of ±4 cents. CHORD voices are detuned ±6 cents from each other.
- **Scale** (GLOBAL row): the 7 modes on Root, dark → bright, each step changes one note: Loc, Phr, **Min** (default), Dor, Mix, Maj, Lyd. Together they reach all 12 notes. BASS, CHORD and MELODY pitches are all read in it. Borrowing = set Scale at that chord, set it back after.
- **Size** (CHORD row, per note): oct, 5th, tri, **7th** (default), 9th. Stacked thirds from the scale, starting on the note's step, so major/minor/diminished fall out of the scale. **5th is always a perfect fifth** (power chord); tri and up follow the scale strictly, so e.g. step 1 in minor is diminished. Always 4 oscillators: oct/5th/tri double tones an octave up; 9th drops the 5th.
- CHORD **voicing is automatic, around one fixed centre**: every chord tone lands in the window −1…+10 st around the chord base (Root in F2…E3). So a chord always sounds the same wherever it's pasted, progressions move as few notes as possible, and nothing drifts. Pitch only picks the root step; ±7 gives the same voicing. Step 0 in Min with Size 7th = the old fixed m7 stab. No key compensation on CHORD (it stays in one register). Slide moves each oscillator to its new note.
- One **4-pole ladder filter** (tanh stages), `Cutoff` per synth from 20–26 Hz up to 2–2.6 kHz (see Filter tuning), `Res` 0–0.95 (self-oscillation just short of max).
- One envelope (fast 2 ms attack, exp decay `Decay` 30 ms–2 s) drives both amp and filter.
  - Filter env amount is fixed at +3 octaves.
- Mono retrigger; pitch moves only via slide.
- Pitch loudness compensation (BASS, MELODY): −2 dB per octave of pitch above root (follows the glide).
- **Attack** (synths, per note, Note group): fade-in time 2 ms (default, the old snap) · 10 · 30 · 80 · 150 · 300 ms · 0.6 · 1.2 · 2.5 s. A retrigger rises from the current level. The filter envelope rises with it.
- Root: each synth's base note is Root in its range starting on F: BASS F1…E2 (MIDI 29–40), CHORD F2…E3, MELODY F3…E4; the KICK's range starts on D (D1…C#2). `rootAbove(root, from)` in `params.ts`. The label is the note you hear. (Before the fix the synths played MIDI 29 + root index, so every Root label was 5 semitones off: "F" sounded B♭. Old songs now play 5 semitones lower or 7 higher accordingly; they weren't migrated.)

### 5.2 Tape delay (the important one)

**One tape echo per instrument track.** Its **Time**, **Fbk**, **Tone**, **Wobble**, **Spread** and **→ Rev** are rows in the track's Sends group (next to the per-note send), but they are **lanes**, not per-note values: set on **any step**, note or not, and held until the next change, like GLOBAL rows (drawn as one continuous fill; set = bright with the jump in amber, held = dim). Held rows (GLOBAL and lanes) store **only changes**: setting the value already in force stores nothing (it stays dim), and a later change that now repeats the held value is dropped too. Loading cleans up older files the same way. The echo rings after its note, so its settings must be changeable between notes: hit a snare, then bend its tail with a Time change on an empty step, swell Fbk across bars while nothing plays, or darken it with Tone as it fades. Adding, removing or moving notes leaves lane points where they are, and so do note selections (⇧-drag box: copy, cut, move): lanes belong to the timeline, not to notes. Whole-bar sections (ruler) carry them; see 3.2. Changing Time bends that track's echoes (the slew below). Files before v6 had GLOBAL Time/Fbk, before v8 GLOBAL Tone: their changes are copied to every track's lanes at the same steps, so old songs sound the same. Seven echoes cost about 8% of a core.

```
in ──► [+]──► delayline(time, wow) ──► out
        ▲                    │
        └── tanh ◄─ LP ◄─ HP ◄┘   × feedback
```
- **Time**, labelled as **repeats per bar** (tempo-synced): `16, 12, 8, 6, 5⅓, 4, 3, 2⅔, 2 per bar` = `1, 1⅓, 2, 2⅔, 3, 4, 5⅓, 6, 8` grid steps apart (a step is one cell, 4 steps a beat). Up = longer echo. 12, 6 and 3 per bar are **triplets**: notes can't sit between grid cells, but echoes can. 5⅓ and 2⅔ per bar are the dotted ones (3 and 6 steps); 5⅓ (the dub dotted eighth) is the default. 2 per bar is the longest: at 60 bpm it is 2 s, within the 4 s tape buffer. v7 inserted the triplets; older files' positions (1 2 3 4 6 steps) are remapped on load.
- Delay time changes are **slewed (~300 ms)**, so the pitch smears like tape. Fractional read with cubic/linear interpolation.
- Small wow on the read position: 0.4 Hz sine, ±0.6 ms, plus a tiny random component.
- **Fbk** 0–1.1. Above 1 it's held in check by `tanh` → blooms instead of exploding.
- **Tone** (per track lane, **17 positions** −8…+8, center = neutral; v9 doubled older files' 9-position indices):
  - left: LP 6 kHz → 250 Hz, HP fixed 120 Hz (dark, warm → muffled, behind a wall). Curved (`|tone|^1.335`) so the default (−2) stays at ~3.6 kHz: −4 ≈ 1.7 kHz, −6 ≈ 690 Hz, −8 = 250 Hz.
  - right: HP 120 Hz → 1.5 kHz, LP fixed 6 kHz (thin, telephone)
- **Spread** (per track lane, 0–8, default 2): two loops, A (left) and B (right). At the default they run identically and B is heard 11 ms late (the old fixed width). Below it the offset shrinks to 0 (mono). Above it the loops cross-feed: input goes only into A, A feeds B, B feeds A; at the top that's a clean **ping-pong** (each repeat on one side only). Echoes ignore the track's Pan.
- **→ Rev** (per track lane, 0–8, default 2 = 12.5 % of L+R, the old fixed amount; top 50 %): how much of this track's echoes goes into the shared reverb. 0 = dry, rhythmic repeats; up = they melt into the room. Different from the note's Reverb send, which only puts the hit itself in the room.
- On the first note after Play, Wobble, Spread and → Rev take their values outright (no glide from the last playback); Time still glides, as its tail may still ring.
- **Wobble** (per track lane, 0–8, default 2): tape wow on the read position. Slow wow (0.4 + 0.13 Hz) depth = 16·w² ms: 0 = clean digital, default = 1 ms (the old fixed amount), top = 16 ms (≈ ±70 cents, seasick). Above the default a 6.3 Hz flutter joins, up to 0.2 ms. Depths glide (150 ms) so changing it mid-tail doesn't click. No rate control: one knob, more = deeper and warblier.
- 12.5% of the (summed) delay output is also fed into the reverb (fixed).

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
- **Track fader** (in each track's head, before M and S): one volume per track for the whole song, −24…+6 dB in 1 dB steps, shown as its number with a fill. Drag up/down (4 px per dB), wheel ±1 dB, double-click = 0. It scales the whole track after its per-note Level: notes, echoes and the reverb share all together (pure mixing; not on the timeline, not in undo, like mute). Saved per track as `vol` (omitted at 0).
- **Ruler click** = set the start marker (bar-quantized). Play starts there, and Stop returns there.
- **FOLLOW** (key `F`): while playing, the view scrolls smoothly with the playhead at 25% from the left. Any manual scroll turns it off, and only you turn it back on (button or `F`): Play never does. The choice is remembered.
- **Scrolling:** a **trackpad** scrolls both ways like a native view: up/down scrolls the tracks panel, sideways scrolls the song. Both at once, freely (no axis lock). A **mouse wheel** scrolls the song sideways, and over an active note it changes the pitch. That pitch shortcut is off on a trackpad, where vertical drag does it. The first sideways scroll without ⇧ marks the device as a trackpad (remembered in localStorage), since browsers don't report the device.
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
