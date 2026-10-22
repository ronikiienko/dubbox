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
  voice: string[];
}

export const TRACKS: TrackDef[] = [
  // Every voice has the same core: LP (lowpass), Res, HP (highpass, off by default), Decay.
  { name: 'KICK', voice: ['kick.lp', 'kick.res', 'kick.hp', 'kick.decay'] },
  { name: 'HAT', voice: ['hat.lp', 'hat.res', 'hat.hp', 'hat.decay'] },
  { name: 'PERC', voice: ['perc.lp', 'perc.res', 'perc.hp', 'perc.decay'] },
  { name: 'BASS', slide: true, voice: ['bass.lp', 'bass.res', 'bass.hp', 'bass.decay'] },
  { name: 'CHORD', slide: true, voice: ['chord.lp', 'chord.res', 'chord.hp', 'chord.decay'] },
];

export const mixId = (i: number, k: 'dst' | 'phs' | 'lvl' | 'dly' | 'rev') => `mix.${i}.${k}`;

/** A track's per-note values, in signal-flow order: voice → Dist → Phs → Lvl → sends. */
export const lockIds = (i: number) => [
  ...TRACKS[i].voice,
  mixId(i, 'dst'), mixId(i, 'phs'), mixId(i, 'lvl'), mixId(i, 'dly'), mixId(i, 'rev'),
];

export const SWING = [50, 54, 58, 62, 66, 75];

/** Highpass value meaning "off": the filter is bypassed entirely, so the default changes nothing. */
export const HP_OFF = 18;

/** The shared core every voice has. */
const core = (k: string, lp: [number, number, number], res: number, decay: [number, number, number]) => [
  p({ id: `${k}.lp`, label: 'LP', min: lp[0], max: lp[1], def: lp[2], curve: 'exp', fmt: hz }),
  p({ id: `${k}.res`, label: 'Res', min: 0, max: 0.95, def: res, curve: 'lin' }),
  // position 0 = off (bypassed); 1..8 = ~30 Hz … 2 kHz
  p({ id: `${k}.hp`, label: 'HP', min: HP_OFF, max: 2000, def: HP_OFF, curve: 'exp', fmt: (v) => (v <= HP_OFF * 1.01 ? 'off' : hz(v)) }),
  p({ id: `${k}.decay`, label: 'Decay', min: decay[0], max: decay[1], def: decay[2], curve: 'exp', fmt: sec }),
];

const synthParams = (k: string, lp: number, decay: number) => core(k, [40, 12000, lp], 0.25, [0.03, 2, decay]);

export const PARAMS: ParamDef[] = [
  // global
  p({ id: 'tempo', label: 'Tempo', min: 60, max: 160, def: 122, curve: 'lin', positions: 101, fmt: (v) => Math.round(v) + ' bpm' }),
  p({ id: 'swing', label: 'Swing', min: 0, max: 5, def: 1, curve: 'step', steps: SWING.map((v) => v + '%') }),
  p({ id: 'root', label: 'Root', min: 0, max: 11, def: 5, curve: 'step', steps: NOTES }),
  p({ id: 'volume', label: 'Vol', min: 0, max: 1, def: 0.8, curve: 'lin' }),

  // voices
  ...core('kick', [150, 12000, 12000], 0, [0.1, 1.2, 0.45]),
  ...core('hat', [2000, 16000, 16000], 0, [0.015, 0.6, 0.05]),
  ...core('perc', [500, 12000, 12000], 0.25, [0.02, 0.4, 0.12]),
  ...synthParams('bass', 220, 0.25),
  ...synthParams('chord', 600, 0.35),

  // mixer
  ...TRACKS.flatMap((_, i) => [
    p({ id: mixId(i, 'dst'), label: 'Dist', min: 0, max: 1, def: 0, curve: 'lin' }),
    p({ id: mixId(i, 'lvl'), label: 'Lvl', min: 0, max: 1, def: 0.7, curve: 'lin' }),
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
  p({ id: 'reverb.size', label: 'Size', min: 0, max: 1, def: 0.6, curve: 'lin', fmt: (v) => (1.5 * Math.pow(14 / 1.5, v)).toFixed(1) + ' s' }),
  p({ id: 'tape.age', label: 'Age', min: 0, max: 1, def: 0.3, curve: 'lin' }),
];

export const PARAM_BY_ID: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((d) => [d.id, d]));
