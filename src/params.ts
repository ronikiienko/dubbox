// The parameter registry: single source of truth for UI and engine.
// Values are stored normalized 0..1; `toReal` maps them through the curve.
// Every knob is stepped: it only lands on `positions` evenly spaced values.

export type Curve = 'lin' | 'exp' | 'step';

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number; // real units (step index for 'step')
  defN: number; // normalized default, derived
  curve: Curve;
  steps?: string[];
  positions: number; // detents: 9 by default, steps.length for 'step' params
  bipolar?: boolean; // arc drawn from center
  fmt: (v: number) => string;
}

type Spec = Omit<ParamDef, 'defN' | 'fmt' | 'positions'> & Partial<Pick<ParamDef, 'fmt' | 'positions'>>;

const hz = (v: number) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + ' Hz');
const sec = (v: number) => (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s');
const pct = (v: number) => Math.round(v * 100) + '%';

export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function toReal(d: ParamDef, n: number): number {
  switch (d.curve) {
    case 'lin':
      return d.min + (d.max - d.min) * n;
    case 'exp':
      return d.min * Math.pow(d.max / d.min, n);
    case 'step':
      return Math.round(n * (d.steps!.length - 1));
  }
}

export function toNorm(d: Pick<ParamDef, 'curve' | 'min' | 'max' | 'steps'>, v: number): number {
  switch (d.curve) {
    case 'lin':
      return (v - d.min) / (d.max - d.min);
    case 'exp':
      return Math.log(v / d.min) / Math.log(d.max / d.min);
    case 'step':
      return v / (d.steps!.length - 1);
  }
}

export function snap(d: ParamDef, n: number): number {
  const k = d.positions - 1;
  return Math.round(n * k) / k;
}

/** Detent index ↔ normalized value. Per-note locks are stored as indices. */
export const toIndex = (d: ParamDef, n: number) => Math.round(n * (d.positions - 1));
export const fromIndex = (d: ParamDef, i: number) => i / (d.positions - 1);

export function formatParam(d: ParamDef, n: number): string {
  const v = toReal(d, n);
  return d.steps ? d.steps[v] : d.fmt(v);
}

function p(s: Spec): ParamDef {
  const d: ParamDef = { fmt: pct, positions: s.steps?.length ?? 9, ...s, defN: 0 };
  d.defN = snap(d, toNorm(s, s.def));
  return d;
}

// ---- tracks -------------------------------------------------------------

export interface TrackDef {
  name: string;
  slide?: boolean; // supports 303-style slide (synths)
  global?: boolean; // GLOBAL: no notes, a value on every step (a set value holds until the next one)
  voice: string[];
}

export const TRACKS: TrackDef[] = [
  // Every voice has the same core: LP (lowpass), Res, HP (highpass, off by default), Decay.
  { name: 'KICK', voice: ['kick.lp', 'kick.res', 'kick.hp', 'kick.decay'] },
  { name: 'HAT', voice: ['hat.lp', 'hat.res', 'hat.hp', 'hat.decay'] },
  { name: 'PERC', voice: ['perc.lp', 'perc.res', 'perc.hp', 'perc.decay'] },
  { name: 'BASS', slide: true, voice: ['bass.lp', 'bass.res', 'bass.hp', 'bass.decay'] },
  { name: 'CHORD', slide: true, voice: ['chord.size', 'chord.lp', 'chord.res', 'chord.hp', 'chord.decay'] },
  { name: 'MELODY', slide: true, voice: ['mel.lp', 'mel.res', 'mel.hp', 'mel.decay'] },
  // last, so instrument indices (mix ids, keys 1–6) stay put
  {
    name: 'GLOBAL', global: true,
    voice: ['scale', 'root', 'tempo', 'swing', 'volume', 'delay.time', 'delay.fbk', 'delay.tone', 'reverb.size', 'tape.age'],
  },
];
export const GLOBAL = TRACKS.length - 1;

export const mixId = (i: number, k: 'dst' | 'phs' | 'lvl' | 'pan' | 'dly' | 'rev') => `mix.${i}.${k}`;

/** A track's per-note values, in signal-flow order: voice → Dist → Phs → Lvl → Pan, plus sends. */
export const lockIds = (i: number) => TRACKS[i].global ? TRACKS[i].voice : [
  ...TRACKS[i].voice,
  mixId(i, 'dst'), mixId(i, 'phs'), mixId(i, 'lvl'), mixId(i, 'pan'), mixId(i, 'dly'), mixId(i, 'rev'),
];

export const SWING = [50, 54, 58, 62, 66, 75];

/** Modes on Root, dark → bright: each step changes one note. Index 2 (minor) is the default. */
export const SCALES: [string, number[]][] = [
  ['Loc', [0, 1, 3, 5, 6, 8, 10]],
  ['Phr', [0, 1, 3, 5, 7, 8, 10]],
  ['Min', [0, 2, 3, 5, 7, 8, 10]],
  ['Dor', [0, 2, 3, 5, 7, 9, 10]],
  ['Mix', [0, 2, 4, 5, 7, 9, 10]],
  ['Maj', [0, 2, 4, 5, 7, 9, 11]],
  ['Lyd', [0, 2, 4, 6, 7, 9, 11]],
];
export const DEFAULT_SCALE = 2;
export const SIZES = ['oct', '5th', 'tri', '7th', '9th'];

/** Pitch range per track: synths count scale steps (±7 = an octave), drums semitones. */
export const pitchRange = (i: number) => (TRACKS[i].global ? 0 : TRACKS[i].slide ? 7 : 12);

/** Scale step (any integer, 7 per octave) → semitones above Root. */
export function stepToSemi(scale: number, step: number): number {
  const o = Math.floor(step / 7);
  return SCALES[scale][1][step - 7 * o] + 12 * o;
}

/**
 * The chord on scale step `step`: 4 intervals (one per oscillator) in semitones above its root, stacked in
 * thirds from the scale. 12+ = an octave above where that tone gets voiced. The 5th size is always a perfect
 * fifth (a power chord); triads and up follow the scale, so some steps are diminished.
 */
export function chordIntervals(scale: number, size: number, step: number, out: Float64Array) {
  const r = stepToSemi(scale, step);
  const t = (k: number) => stepToSemi(scale, step + k) - r;
  const iv =
    size === 0 ? [0, 12, 0, 12] :
    size === 1 ? [0, 7, 0, 12] :
    size === 2 ? [0, t(2), t(4), 12] :
    size === 3 ? [0, t(2), t(4), t(6)] :
    [0, t(2), t(6), t(8)]; // 9th: no 5th, 4 oscillators
  out.set(iv);
}

/** One-line explanations of the per-note values, shown when a value row is expanded. */
const DESCRIPTIONS: Record<string, string> = {
  'chord.size': 'Chord size: octave, 5th, triad, 7th, 9th. Voiced automatically.',
  scale: 'Scale of BASS, CHORD, MELODY, dark → bright.',
  root: 'Key: the note every scale starts on.',
  tempo: 'Beats per minute.',
  swing: 'Delays every second 16th.',
  volume: 'Master volume.',
  'delay.time': 'Echo time, in 16ths.',
  'delay.fbk': 'How long echoes repeat. Top = runaway.',
  'delay.tone': 'Echo colour: darker ↔ thinner each repeat.',
  'reverb.size': 'Room length.',
  'tape.age': 'Tape wear: warmth, wobble, hiss.',
  lp: 'Lowpass. Lower = darker, softer.',
  res: 'Filter resonance. Higher = ringing, squelchy.',
  hp: 'Highpass. Cuts the low end. 0 = off.',
  decay: 'How long the note rings. Middle = default.',
  dst: 'Saturation. More grit, same loudness.',
  phs: 'Phaser: slow swirling sweep. 0 = off.',
  lvl: 'Volume. Middle = default, top = +6 dB.',
  pan: 'Left ↔ right. Middle = centre.',
  dly: 'Send to the tape delay (shared echo).',
  rev: 'Send to the reverb (shared room).',
};
export const describe = (id: string) => DESCRIPTIONS[id] ?? DESCRIPTIONS[id.slice(id.lastIndexOf('.') + 1)] ?? '';

/** HP range per voice, so every position actually cuts into that instrument (hats live above 8 kHz). */
const HP_RANGE: Record<string, [number, number]> = {
  kick: [30, 1000],
  hat: [3000, 16000],
  perc: [200, 8000],
  bass: [30, 2000],
  chord: [60, 4000],
  mel: [80, 6000],
};

/** HP knob position (0..1) → Hz. Position 0 = 0 = off: the filter is bypassed, so the default changes nothing. */
export function hpHz(voice: string, n: number): number {
  if (n < 1 / 16) return 0;
  const [lo, hi] = HP_RANGE[voice];
  return lo * Math.pow(hi / lo, (n - 0.125) / 0.875);
}

/** The shared core every voice has. */
/** Exp range centred on `mid`: the default sits exactly at the middle position, `ratio` either way. */
const around = (mid: number, ratio: number): [number, number, number] => [mid / ratio, mid * ratio, mid];

const core = (k: string, lp: [number, number, number], res: number, decay: [number, number, number]) => [
  p({ id: `${k}.lp`, label: 'LP', min: lp[0], max: lp[1], def: lp[2], curve: 'exp', fmt: hz }),
  p({ id: `${k}.res`, label: 'Res', min: 0, max: 0.95, def: res, curve: 'lin' }),
  // position 0 = off (bypassed); 1..8 = the voice's HP_RANGE
  p({ id: `${k}.hp`, label: 'HP', min: 0, max: 1, def: 0, curve: 'lin', fmt: (v) => (hpHz(k, v) ? hz(hpHz(k, v)) : 'off') }),
  p({ id: `${k}.decay`, label: 'Decay', min: decay[0], max: decay[1], def: decay[2], curve: 'exp', fmt: sec }),
];

// Decay (and synth LP) default to the middle position, so every note can go either way.
const synthParams = (k: string, lp: number, decay: number) => core(k, around(lp, 8), 0.25, around(decay, 6));

export const PARAMS: ParamDef[] = [
  // global
  p({ id: 'tempo', label: 'Tempo', min: 60, max: 160, def: 122, curve: 'lin', positions: 101, fmt: (v) => Math.round(v) + ' bpm' }),
  p({ id: 'swing', label: 'Swing', min: 0, max: 5, def: 1, curve: 'step', steps: SWING.map((v) => v + '%') }),
  p({ id: 'scale', label: 'Scale', min: 0, max: 6, def: DEFAULT_SCALE, curve: 'step', steps: SCALES.map((c) => c[0]) }),
  p({ id: 'root', label: 'Root', min: 0, max: 11, def: 5, curve: 'step', steps: NOTES }),
  p({ id: 'volume', label: 'Vol', min: 0, max: 1, def: 0.8, curve: 'lin' }),

  // voices
  // drum LP defaults fully open (top); Decay defaults to the middle
  ...core('kick', [150, 12000, 12000], 0, around(0.45, 4)),
  ...core('hat', [2000, 16000, 16000], 0, around(0.06, 8)),
  ...core('perc', [500, 12000, 12000], 0.25, around(0.12, 4)),
  ...synthParams('bass', 220, 0.25),
  p({ id: 'chord.size', label: 'Size', min: 0, max: 4, def: 3, curve: 'step', steps: SIZES }),
  ...synthParams('chord', 600, 0.35),
  ...synthParams('mel', 1500, 0.3),

  // mixer
  ...TRACKS.flatMap((_, i) => [
    p({ id: mixId(i, 'dst'), label: 'Dist', min: 0, max: 1, def: 0, curve: 'lin' }),
    p({ id: mixId(i, 'lvl'), label: 'Lvl', min: 0, max: 1.4, def: 0.7, curve: 'lin' }), // middle = default, top = +6 dB
    p({
      id: mixId(i, 'pan'), label: 'Pan', min: -1, max: 1, def: 0, curve: 'lin', bipolar: true,
      fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)),
    }),
    p({ id: mixId(i, 'dly'), label: 'Dly', min: 0, max: 1, def: 0, curve: 'lin' }),
    p({ id: mixId(i, 'rev'), label: 'Rev', min: 0, max: 1, def: 0, curve: 'lin' }),
    p({ id: mixId(i, 'phs'), label: 'Phs', min: 0, max: 1, def: 0, curve: 'lin' }),
  ]),

  // fx
  p({ id: 'delay.time', label: 'Time', min: 0, max: 4, def: 2, curve: 'step', steps: ['1/16', '1/8', '3/16', '1/4', '3/8'] }),
  p({ id: 'delay.fbk', label: 'Fbk', min: 0, max: 1.1, def: 0.55, curve: 'lin' }),
  p({
    id: 'delay.tone', label: 'Tone', min: -1, max: 1, def: -0.25, curve: 'lin', bipolar: true,
    fmt: (v) => (v < -0.05 ? 'dark ' + Math.round(-v * 100) : v > 0.05 ? 'thin ' + Math.round(v * 100) : 'flat'),
  }),
  p({ id: 'reverb.size', label: 'Size', min: 0, max: 1, def: 0.5, curve: 'lin', fmt: (v) => (1.5 * Math.pow(14 / 1.5, v)).toFixed(1) + ' s' }),
  p({ id: 'tape.age', label: 'Age', min: 0, max: 1, def: 0.3, curve: 'lin' }),
];

export const PARAM_BY_ID: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((d) => [d.id, d]));
