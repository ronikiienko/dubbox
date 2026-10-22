# DUBBOX: design spec

A tiny browser-based groovebox for dub techno and 90s techno.
One screen, one pattern, about 40 knobs total. You perform it, record it, done.

---

## 0. Minimalism rules (the constitution)

Every future feature must pass these rules. If it doesn't, it isn't added.

1. **Max 4 knobs per module.** Prefer 1–2. Use macros: one knob drives several internal params along hand-tuned curves.
2. **No menus, no dialogs, no hidden pages.** Everything is visible on one screen at all times.
3. **No editors.** No piano roll, no automation lanes, no curve drawing. You *perform* changes.
4. **Fixed structure.** 5 tracks, one 300-bar song, 16th-step grid. Not configurable.
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
  state.ts         project model, defaults, autosave, save/load JSON
  ui.ts            render screen, knob + step widgets, keyboard
  wav.ts           encode recorded float chunks to WAV
  style.css
  engine/
    worklet.ts     AudioWorkletProcessor: clock, sequencer, mixing, routing
    dsp.ts         small DSP building blocks (ladder, svf, onepole, delayline, tanh, noise, smoother)
    voices.ts      Kick, Hat, Perc, Synth (mono/chord)
    fx.ts          TapeDelay, Reverb (FDN), Phaser, Tape, Glue
```

---

## 2. The instrument

### Tracks (fixed, 5)

Every voice has the **same core** of per-note values. Only genuinely unique things differ.

| Value | Meaning everywhere | KICK | HAT | PERC | BASS / CHORD |
|---|---|---|---|---|---|
| *Pitch* (per step) | the sound's frequency, ±12 st | sine pitch (base 50 Hz) | noise HP frequency (base 8 kHz) | ring + click frequency (base 1.4 kHz) | note (relative to Root) |
| **Tone** | brightness: lowpass on the voice | 4-pole ladder after drive | 2× one-pole LP | 4-pole ladder | ladder cutoff (+ envelope) |
| **Res** | resonance of the voice's filter | ladder res (boom) | HP resonance (ring) | BP Q (ringy ↔ noisy) | ladder res |
| **Decay** | length | ✓ | ✓ | ✓ | ✓ |
| **Shape** | waveform | — | — | — | saw → square → pulse |
| **Dist** | saturation, loudness-matched | ✓ | ✓ | ✓ | ✓ |
| Phs · Lvl · Dly · Rev | mixer | ✓ | ✓ | ✓ | ✓ |

Row order is Tone, Res, Decay, (Shape), Dist, Phs, Lvl, Dly, Rev (signal flow), so the shared values line up on every track.
Copying notes between tracks carries every same-named value by its knob position. Only Shape is lost on drums.

### Effects (global)

| Module | Knobs | Notes |
|---|---|---|
| DELAY | **Time** (stepped), **Fbk**, **Tone** | tape echo, the main instrument |
| REVERB | **Size** | dark FDN, size and darkness linked |
| TAPE | **Age** | master: saturation + wow/flutter + hiss + HF loss |

### Global

**Tempo**, **Swing**, **Root** (note), **Volume**.

Knobs: 5 FX + 4 global = **9**. Everything else is per note.

---

## 3. Sequencer: one linear song

- The whole track is one timeline: **300 bars × 16 steps = 4800 steps per track** (10 min at 120 bpm). It's fixed for now (`SONG_BARS` in `state.ts`).
- No loops, patterns or per-track lengths. Playback runs from the start marker to the end, then loops to bar 1.
- Grid resolution is 16th steps only. Nothing can be placed off the grid; swing is the only timing offset.
- Step states: `off → on → accent → off` (click cycles).
- **Drag sideways** from a step = paint the clicked step's new state across every step you pass.
- **Every step has a pitch**: drag a step vertically, or wheel over an active step → semitone offset −12..+12. Shown as a small number. Synths: relative to Root. Drums: shifts the voice (KICK pitch, HAT/PERC tone) by that many semitones.
- **Slide** (BASS, CHORD): **Alt-click** a step to toggle it, drawn as a tie into the next step. Like a 303: the slid note's volume decays to a 30% sustain level and holds there until the next step. The filter envelope keeps decaying as normal, so slid notes aren't louder or brighter. If that step is on, the pitch glides into it (~60 ms) without retriggering the envelope. If it's off, the note just ends there.
- **Swing** 50 / 54 / 58 / 62 / 66 / 75 %, delays every odd 16th by `(swing − 50) / 50` of a step.
- Clock lives in the worklet: `samplesPerStep = sr × 60 / bpm / 4`. Sample-accurate triggers.

### 3.1 Per-note values (locks)
- A track's sound is set **only per note**: its instrument values plus Lvl, Dly, Rev, Phs. There are no track knobs. Global knobs (delay, reverb, tape, tempo, swing, root, vol) are the only knobs.
- **Click a track name** to expand it (one at a time). Under its lane, one row per value shows a **bar per note**: bright = this note has its own value, faint = the fixed default.
- Drag a bar up/down = set that note's value. Drag across a row = draw values over every note you pass (bar height follows the mouse). Double-click a bar = back to the default.
- **A new note copies the values of the previous note** on its track (or uses the defaults if it's the first). Painting a run carries the current sound forward.
- Old saves: track knob settings that differ from the default are baked into the notes that used them.
- Notes with locks get a small dot on the main lane. Deleting a note deletes its locks.
- Engine: tracks are mono, so a note's values hold for the track **until the next note**. No interpolation: values change exactly at the note (only the 20 ms anti-click smoothing).
- **Slide glides everything**: on a slid note, pitch *and* all strip values glide linearly into the next note's values over the step.

### 3.2 Selection, copy/paste, undo (`edit.ts`)
- **Drag on the ruler** = select whole bars on all tracks (a plain ruler click still moves the start marker). **Shift-drag in the lanes** = rectangle of steps × tracks. **Esc** or a plain click in the lanes clears it.
- **⌘C / ⌘X** copy / cut. **⌘V** pastes with its top-left at the step under the mouse; hold ⌘ to see a dashed outline of where it lands. Bar selections from the ruler always paste onto the same tracks. **Delete** clears the selection.
- **⌘D** duplicates the selection right after itself and moves the selection onto the copy, so repeated ⌘D keeps extending (4 → 8 → 12 bars…).
- Paste **overwrites** the target area (empty steps included). Notes carry pitch, accent, slide and per-note values. Across tracks, Lvl/Dly/Rev/Phs carry over; instrument values only onto the same track.
- **⌘Z / ⇧⌘Z** undo / redo (100 steps) for all note edits: clicks, paints, drags, bar edits, region edits. Mutes/solo and global knobs are not in the history.

### 3.3 Stepped knobs
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
- `tanh(x × 1.5)` drive → 4-pole ladder lowpass at `Tone` (150 Hz–12 kHz) with `Res`. Accent: +3 dB and slightly more drive.
- Base pitch fixed at 50 Hz; per-step pitch ±12 st → ~25–100 Hz.

**HAT**
- White noise → 2-pole highpass at 8 kHz × pitch, Q 0.7 + 8 × `Res` → 2× one-pole lowpass at `Tone` (2–16 kHz).
- Decay 15–600 ms (low = closed, high = open). Accent +3 dB.

**PERC**
- Noise → bandpass at 1.4 kHz × pitch, Q 1 + 12 × `Res`, plus a 2 ms sine click at half that → 4-pole ladder lowpass at `Tone` (0.5–12 kHz).
- Decay 20–400 ms.

**SYNTH** (BASS = 1 note, CHORD = 4 notes)
- Oscillators: `Shape` crossfades saw → square → narrow pulse (0..0.5 = saw→square, 0.5..1 = pulse width 50%→10%). PolyBLEP.
- **Analog drift (baked in):** each oscillator gets a slow random pitch wander of ±4 cents. CHORD voices are detuned ±6 cents from each other.
- CHORD notes: root+0, +3, +7, +10 (minor 7), one octave above BASS.
- One **4-pole ladder filter** (tanh stages), `Cutoff` 40 Hz–12 kHz (exp), `Res` 0–0.95 (self-oscillation just short of max).
- One envelope (fast 2 ms attack, exp decay `Decay` 30 ms–2 s) drives both amp and filter.
  - Filter env amount is fixed at +3 octaves (accent: +4.5 octaves, +3 dB).
- Mono retrigger; glide only via slide.
- Pitch loudness compensation: −2 dB per octave of step pitch above root (follows the glide).
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
- Insert right after the voice: voice → **Dist** → phaser → fader → sends.
- `tanh(g·x + b) − tanh(b)`, g = 1 + 30·amount², b = 0.15·amount (slight asymmetry = even harmonics). 0 = bypassed.
- **Loudness stays the same.** Makeup is computed every block for the *current input level*: the RMS of a sine at that level before vs. after the curve. So it's right from a note's first sample, then a slow (300 ms) RMS correction trims the rest. The input level follower runs even when bypassed. Measured: within ±0.5 dB across all settings for quiet, loud and percussive signals.

### 5.5 Phaser (per track)
- One phaser per track, as an insert before the fader, so the sends get the phased sound too.
- 4-stage allpass (Small Stone style), mono, at full Amount summed with dry 50/50.
- **Phs** (per-track knob) → depth + feedback together; rate fixed slow at 0.12 Hz, mildly increasing with Amount (up to 0.4 Hz). 0 = bypassed.

### 5.6 Master chain
```
track: voice ─► dist ─► phaser ─► fader ─┬─► sum ─► GLUE ─► TAPE(Age) ─► Volume ─► out
                                 ├─► delay send ─► delay ret ──► sum
                                 └─► reverb send ─► reverb ret ─► sum
```
- **GLUE** (no knob): RMS compressor, ratio 2:1, attack 10 ms, release 150 ms, threshold ≈ −12 dBFS, ~2 dB GR on a typical mix.
- **TAPE / Age** (one macro, 0..1, curves tuned by ear):
  - drive into `tanh`: 1.0 → 3.0
  - HF loss: LP 20 kHz → 7 kHz
  - wow/flutter: depth 0 → 0.8 ms (0.5 Hz + 6 Hz components), slight L/R difference
  - hiss: −90 dBFS → −58 dBFS pink-ish noise
  - low bump: +0 → +2 dB shelf at 80 Hz
  - Default Age 0.3 (warm cassette). 1.0 = worn VHS dub.
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
  s: Uint8Array;                    // 4800 steps: 0 off / 1 on / 2 accent
  note: Int8Array;                  // semitone offset per step
  mute: boolean;
  solo: boolean;
}
```
- In memory: dense typed arrays. On disk: sparse, only hits as `[step, state, note]`.
- v1 files (16-step loops) still load: the loop is tiled across the whole song.
- **Autosave** to `localStorage` (debounced 500 ms). Loads on start.
- **SAVE** downloads `dubbox-<date>.json`, **LOAD** opens one.
- **NEW** starts an empty project (with confirm).

### Messages
Defined in `src/engine/bridge.ts`. Param values are **normalized 0..1**. The worklet imports `params.ts` and maps them itself.

main → worklet:
- `{t:'init', project}` full state when audio starts, and on LOAD/NEW
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

- **REC** button: records the master output in realtime while you perform. The worklet streams chunks, and on stop it encodes a **24-bit WAV** and downloads it (`dubbox-<date>.wav`).
- No offline render. The performance *is* the arrangement.

---

## 9. UI layout (one screen, dark, monospace)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ DUBBOX  ▶ PLAY ● REC FOLLOW   Tempo Swing Root Vol             SAVE LOAD NEW  │
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
- ■ on, ▣ accent, bar lines + numbers on the ruler, playhead = vertical line.
- **Ruler click** = set the start marker (bar-quantized). Play starts there, and Stop returns there.
- **FOLLOW** (key `F`): while playing, the view scrolls smoothly with the playhead at 25% from the left. Any manual scroll turns it off.
- Vertical mouse wheel scrolls the timeline horizontally (except over an active synth step, where it changes the note).
- Knobs: vertical drag (Shift = fine), value tooltip while dragging, double-click = reset.
- Knob visual: arc = base, dot = live value (shows throws).
- Colors: near-black background, off-white text, one accent color (amber) for active/playhead, red only for REC.

Keyboard: `Space` play · `1–5` mute · `Shift+1–5` solo · `Q W E R T` hold = dub throw · `F` follow.

---

## 10. New project

A new project (first launch and **NEW**) is **empty**: no steps on the 300-bar timeline, all knobs at their registry defaults. Pressing Play on it is silent apart from faint tape hiss.

---

## 11. Out of scope (v1). Do not build.

Plugins · audio import/samples · patterns/loops · piano roll · automation lanes · MIDI · per-track effects beyond the phaser · EQ · panning · presets browser · themes · mobile layout.

Candidates for v2, only if missing after real use: MIDI clock out/in, zoom, drift knob, A/B scenes + morph, sampler/bit mode inside TAPE, Tauri desktop build.

---

## 12. Acceptance checklist

- [ ] `npm run dev` → page loads → empty project → enter a few steps → Play → sounds like dub techno.
- [ ] No clicks/zipper noise when turning any knob.
- [ ] Delay Fbk at max blooms and saturates, never blows up. Changing Time smears pitch.
- [ ] Holding Q–T throws a track into the delay.
- [ ] Paint 300 bars' worth of hits by dragging; FOLLOW keeps the playhead in view; ruler click sets the start.
- [ ] REC → perform → stop → valid WAV downloads.
- [ ] Reload page → everything restored.
- [ ] CPU < 15% of one core on a modern laptop at 48 kHz.
