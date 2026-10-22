import { Ladder, Noise, OnePole, SVF, Smooth, TAU, decayCoef, lpCoef, mtof, saw, tanh, timeCoef } from './dsp';

export interface Voice {
  trigger(accent: boolean, note: number): void;
  process(): number;
}

/** Per-step note (semitones) → frequency ratio. Drums use it to shift their tune/tone. */
const ratio = (note: number) => Math.pow(2, note / 12);

export class Kick implements Voice {
  private filter = new Ladder();
  private tone = 12000;
  private res = 0;
  private ph = 0;
  private amp = 0;
  private pEnv = 0;
  private dec = 0;
  private pDec: number;
  private tune = 50; // fixed base pitch; per-step pitch moves it
  private ratio = 1;
  private drive = 1.5;
  private gain = 1;
  constructor(private sr: number) {
    this.pDec = Math.exp(-1 / (0.03 * sr));
  }
  set(tone: number, res: number, decay: number) {
    this.tone = tone;
    this.res = res;
    this.dec = decayCoef(decay, this.sr);
  }
  trigger(accent: boolean, note: number) {
    this.ratio = ratio(note);
    this.ph = 0;
    this.amp = 1;
    this.pEnv = 1;
    this.drive = accent ? 2.2 : 1.5;
    this.gain = accent ? 1.15 : 1;
  }
  process() {
    if (this.amp < 1e-5) return 0;
    this.pEnv *= this.pDec;
    this.ph += (this.tune * this.ratio * (1 + 3 * this.pEnv)) / this.sr;
    if (this.ph >= 1) this.ph -= 1;
    const x = Math.sin(TAU * this.ph) * this.amp;
    this.amp *= this.dec;
    return this.filter.process(tanh(x * this.drive), this.tone, this.res, this.sr) * this.gain * 0.9;
  }
}

export class Hat implements Voice {
  private static BASE = 8000; // noise highpass frequency at pitch 0
  private amp = 0;
  private dec = 0;
  private svf = new SVF();
  private lp = new OnePole();
  private lp2 = new OnePole();
  private noise = new Noise(1234);
  private lpA = 1;
  private q = 0.7;
  private ratio = 1;
  constructor(private sr: number) {}
  set(tone: number, res: number, decay: number) {
    this.lpA = lpCoef(tone, this.sr);
    this.q = 0.7 + res * 8;
    this.svf.set(Hat.BASE * this.ratio, this.q, this.sr);
    this.dec = decayCoef(decay, this.sr);
  }
  trigger(accent: boolean, note: number) {
    this.ratio = ratio(note);
    this.svf.set(Hat.BASE * this.ratio, this.q, this.sr);
    this.amp = accent ? 1.4 : 1;
  }
  process() {
    if (this.amp < 1e-5) return 0;
    this.svf.run(this.noise.next());
    const y = this.lp2.lp(this.lp.lp(this.svf.hp, this.lpA), this.lpA) * this.amp;
    this.amp *= this.dec;
    return y * 1.8;
  }
}

export class Perc implements Voice {
  private amp = 0;
  private dec = 0;
  private click = 0;
  private clickDec: number;
  private ph = 0;
  private static BASE = 1400; // ring frequency at pitch 0
  private ratio = 1;
  private q = 4;
  private svf = new SVF();
  private filter = new Ladder();
  private tone = 12000;
  private noise = new Noise(98765);
  constructor(private sr: number) {
    this.clickDec = Math.exp(-1 / (0.002 * sr));
  }
  set(tone: number, res: number, decay: number) {
    this.tone = tone;
    this.q = 1 + res * 12; // ringy ↔ noisy
    this.svf.set(Perc.BASE * this.ratio, this.q, this.sr);
    this.dec = decayCoef(decay, this.sr);
  }
  trigger(accent: boolean, note: number) {
    this.ratio = ratio(note);
    this.svf.set(Perc.BASE * this.ratio, this.q, this.sr);
    this.amp = accent ? 1.4 : 1;
    this.click = 1;
    this.ph = 0;
  }
  process() {
    if (this.amp < 1e-5) return 0;
    this.svf.run(this.noise.next());
    this.ph += (Perc.BASE * this.ratio * 0.5) / this.sr;
    const c = Math.sin(TAU * this.ph) * this.click;
    this.click *= this.clickDec;
    const y = (this.svf.bp * (0.6 + this.q * 0.25) + c * 0.6) * this.amp;
    this.amp *= this.dec;
    return this.filter.process(y * 0.6, this.tone, 0, this.sr);
  }
}

const HOLD_LEVEL = 0.3;
const DB_PER_OCTAVE = -2; // higher notes sound louder (esp. on small speakers), so tilt them down

/** Mono saw synth. One oscillator for BASS, four (minor 7th) for CHORD. Analog drift is baked in. */
export class Synth implements Voice {
  private ph: Float64Array;
  private dt: Float64Array;
  private drift: Float64Array;
  private driftTarget: Float64Array;
  private noise = new Noise(4242);
  private ladder = new Ladder();
  private cutSm: Smooth;
  private env = 0; // amp envelope
  private fenv = 0; // filter envelope: always decays, even during a slide (like a 303)
  private attacking = false;
  private atkInc: number;
  private dec = 0;
  private envAmt = 3;
  private gain = 1;
  private note = 0; // current pitch in semitones (float while gliding)
  private target = 0;
  private gliding = false;
  private glideA: number; // per-block glide coefficient (~60 ms, like a 303)
  private hold = false; // slide: sustain the envelope into the next step
  private keyGain = 1; // loudness compensation for the current pitch
  private cutoff = 500;
  private res = 0;
  private blockCount = 0;

  constructor(
    private sr: number,
    private baseMidi: number,
    private intervals: number[],
    private detune: number[], // cents per oscillator
  ) {
    const n = intervals.length;
    this.ph = new Float64Array(n).map(() => Math.random());
    this.dt = new Float64Array(n);
    this.drift = new Float64Array(n);
    this.driftTarget = new Float64Array(n);
    this.atkInc = 1 / (0.002 * sr);
    this.cutSm = new Smooth(500, timeCoef(0.01, sr));
    this.glideA = 1 - Math.exp(-128 / (0.06 * sr));
  }

  /** Called once per block. */
  set(cutoff: number, res: number, decay: number, root: number) {
    this.cutoff = cutoff;
    this.res = res;
    this.dec = decayCoef(decay, this.sr);
    // analog drift: slow random wander of ±4 cents
    if (++this.blockCount % 64 === 0) {
      for (let i = 0; i < this.drift.length; i++) this.driftTarget[i] = this.noise.next() * 4;
    }
    if (this.gliding) this.note += (this.target - this.note) * this.glideA;
    this.keyGain = Math.pow(10, (DB_PER_OCTAVE * this.note) / 12 / 20);
    const midi = this.baseMidi + root + this.note;
    for (let i = 0; i < this.dt.length; i++) {
      this.drift[i] += (this.driftTarget[i] - this.drift[i]) * 0.02;
      const cents = this.detune[i] + this.drift[i];
      this.dt[i] = (mtof(midi + this.intervals[i]) * Math.pow(2, cents / 1200)) / this.sr;
    }
  }

  trigger(accent: boolean, note: number) {
    this.note = this.target = note;
    this.gliding = false;
    this.attacking = true;
    this.envAmt = accent ? 4.5 : 3;
    this.gain = accent ? 1.4 : 1;
  }

  /** Slide into a note: glide the pitch, don't retrigger the envelope. */
  glide(accent: boolean, note: number) {
    this.target = note;
    this.gliding = true;
    this.envAmt = accent ? 4.5 : 3;
    this.gain = accent ? 1.4 : 1;
  }

  setHold(on: boolean) {
    this.hold = on;
  }

  process() {
    if (this.attacking) {
      this.env += this.atkInc;
      if (this.env >= 1) {
        this.env = 1;
        this.attacking = false;
      }
      this.fenv = this.env;
    } else {
      if (this.env < 1e-5) return 0;
      // slide holds the volume at a sustain level instead of letting it die
      if (!this.hold || this.env > HOLD_LEVEL) this.env *= this.dec;
      this.fenv *= this.dec;
    }

    let osc = 0;
    for (let i = 0; i < this.ph.length; i++) {
      const dt = this.dt[i];
      let ph = this.ph[i] + dt;
      if (ph >= 1) ph -= 1;
      this.ph[i] = ph;
      osc += saw(ph, dt);
    }
    osc /= Math.sqrt(this.ph.length);

    const fc = this.cutSm.next(this.cutoff) * Math.pow(2, this.envAmt * this.fenv);
    return this.ladder.process(osc * 0.7, fc, this.res, this.sr) * this.env * this.gain * this.keyGain;
  }
}
