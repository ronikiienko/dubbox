// Small DSP building blocks. Everything is per-sample and allocation-free after construction.

export const TAU = Math.PI * 2;

// Cheap tanh (Padé), exact enough for saturation and cheaper than Math.tanh.
export function tanh(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** One-pole coefficient for a cutoff frequency. */
export const lpCoef = (fc: number, sr: number) => 1 - Math.exp((-TAU * clamp(fc, 1, sr * 0.45)) / sr);
/** One-pole coefficient for a time constant in seconds (smoothing). */
export const timeCoef = (sec: number, sr: number) => 1 - Math.exp(-1 / (sec * sr));
/** Per-sample multiplier that decays by 60 dB over `t60` seconds. */
export const decayCoef = (t60: number, sr: number) => Math.exp(-6.9 / (t60 * sr));

export class Noise {
  private s: number;
  constructor(seed = 22222) {
    this.s = seed >>> 0 || 1;
  }
  /** White noise in -1..1 (xorshift32). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 2147483648 - 1;
  }
}

export class OnePole {
  y = 0;
  lp(x: number, a: number) {
    return (this.y += a * (x - this.y));
  }
  hp(x: number, a: number) {
    return x - this.lp(x, a);
  }
}

export class Smooth {
  constructor(public v: number, private a: number) {}
  next(target: number) {
    return (this.v += this.a * (target - this.v));
  }
}

/** Topology-preserving state variable filter (Simper). Call `set` then `run`; read lp/bp/hp. */
export class SVF {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  lp = 0;
  bp = 0;
  hp = 0;
  set(fc: number, q: number, sr: number) {
    const g = Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  run(x: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }
}

/** 4-pole transistor-ladder style lowpass with tanh-saturated input and resonance feedback. */
export class Ladder {
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private s4 = 0;
  process(x: number, fc: number, res: number, sr: number): number {
    const g = 1 - Math.exp((-TAU * clamp(fc, 20, sr * 0.35)) / sr);
    const k = res * 4;
    const u = tanh(x * (1 + res) - k * this.s4);
    this.s1 += g * (u - this.s1);
    this.s2 += g * (tanh(this.s1) - this.s2);
    this.s3 += g * (this.s2 - this.s3);
    this.s4 += g * (this.s3 - this.s4);
    return this.s4;
  }
}

/** Circular delay line with fractional (linear) read. `read(d)` = value written d samples ago. */
export class DelayLine {
  private buf: Float32Array;
  private mask: number;
  private w = 0;
  constructor(maxSamples: number) {
    let size = 1;
    while (size < maxSamples + 4) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }
  write(x: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  read(d: number): number {
    const r = this.w - Math.max(1, d);
    const i = Math.floor(r);
    const f = r - i;
    return this.buf[i & this.mask] * (1 - f) + this.buf[(i + 1) & this.mask] * f;
  }
}

/** PolyBLEP residual for band-limited discontinuities. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export function saw(ph: number, dt: number): number {
  return 2 * ph - 1 - blep(ph, dt);
}

