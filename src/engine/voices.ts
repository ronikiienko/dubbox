import { Ladder, Noise, OnePole, SVF, Smooth, TAU, decayCoef, lpCoef, mtof, saw, tanh, timeCoef } from './dsp';
import { rootAbove } from '../params';

export interface Voice {
  trigger(note: number): void;
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
  private pDec = 0;
  private depth = 3; // pitch starts at (1 + depth) × the base
  private tune = 43.65; // base pitch: Root, D1…C#2; per-step pitch moves it
  private ratio = 1;
  private punch = 0.5;
  private click = 0;
  private cEnv = 0; // beater click envelope
  private cLevel = 0;
  private cPh = 0;
  private cDec: number;
  private noise = new Noise(777);
  constructor(private sr: number) {
    this.cDec = Math.exp(-1 / (0.0015 * sr));
  }
  set(tone: number, res: number, decay: number, punch: number, click: number, root: number) {
    this.tune = mtof(26 + rootAbove(root, 2)); // D1 = MIDI 26
    this.tone = tone;
    this.res = res;
    this.dec = decayCoef(decay, this.sr);
    this.punch = punch;
    this.click = click;
  }
  trigger(note: number) {
    this.ratio = ratio(note);
    this.ph = 0;
    this.amp = 1;
    this.pEnv = 1;
    // Punch: deeper and faster pitch drop together. 0.5 = the classic 4× → 1× over 30 ms.
    const p = this.punch;
    this.depth = 12 * p * p;
    this.pDec = Math.exp(-1 / (0.03 * Math.sqrt(0.5 / Math.max(p, 0.05)) * this.sr));
    this.cEnv = 1;
    this.cPh = 0;
    this.cLevel = 0.9 * this.click;
  }
  process() {
    if (this.amp < 1e-5) return 0;
    this.pEnv *= this.pDec;
    this.ph += (this.tune * this.ratio * (1 + this.depth * this.pEnv)) / this.sr;
    if (this.ph >= 1) this.ph -= 1;
    let x = Math.sin(TAU * this.ph) * this.amp;
    if (this.cEnv > 1e-4) {
      // a 1–3 ms tick: noise plus a 2.5 kHz blip
      this.cPh += 2500 / this.sr;
      x += (this.noise.next() * 0.6 + Math.sin(TAU * this.cPh) * 0.4) * this.cEnv * this.cLevel;
      this.cEnv *= this.cDec;
    }
    this.amp *= this.dec;
    return this.filter.process(tanh(x * 1.5), this.tone, this.res, this.sr) * 0.9;
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
  private metal = 0;
  // 808 metal: six square waves at inharmonic frequencies (Hz at pitch 0), free-running
  private static METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
  private mPh = new Float64Array(6);
  constructor(private sr: number) {}
  set(tone: number, res: number, decay: number, metal: number) {
    this.metal = metal;
    this.lpA = lpCoef(tone, this.sr);
    this.q = 0.7 + res * 8;
    this.svf.set(Hat.BASE * this.ratio, this.q, this.sr);
    this.dec = decayCoef(decay, this.sr);
  }
  trigger(note: number) {
    this.ratio = ratio(note);
    this.svf.set(Hat.BASE * this.ratio, this.q, this.sr);
    this.amp = 1;
  }
  process() {
    if (this.amp < 1e-5) return 0;
    let src = this.noise.next();
    if (this.metal > 0) {
      let m = 0;
      for (let i = 0; i < 6; i++) {
        let ph = this.mPh[i] + (Hat.METAL[i] * this.ratio) / this.sr;
        if (ph >= 1) ph -= 1;
        this.mPh[i] = ph;
        m += ph < 0.5 ? 1 : -1;
      }
      // equal-power crossfade; the squares get more gain to match the noise's loudness past the HP
      const a = (this.metal * Math.PI) / 2;
      src = src * Math.cos(a) + m * 1.15 * Math.sin(a);
    }
    this.svf.run(src);
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
  trigger(note: number) {
    this.ratio = ratio(note);
    this.svf.set(Perc.BASE * this.ratio, this.q, this.sr);
    this.amp = 1;
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

/**
 * Snare ↔ clap. Snap 0: two tuned sine heads + a little noise (round dub snare); 0.5: body + bright
 * noise (909-ish); 1: clap = three noise bursts 11 ms apart, then a tail, no body.
 */
export class Snare implements Voice {
  private amp = 0; // noise / tail envelope
  private dec = 0;
  private bAmp = 0; // body envelope (shorter than the noise)
  private bDec = 0;
  private pEnv = 0;
  private pDec: number;
  private ph1 = 0;
  private ph2 = 0;
  private t = 0; // samples since the hit
  private ratio = 1;
  private snap = 0.5;
  private wb = 0; // mix weights for body / snare noise / clap, set per hit
  private wn = 0;
  private wc = 0;
  private tone = 12000;
  private res = 0;
  private hpN = new SVF();
  private bpC = new SVF();
  private filter = new Ladder();
  private noise = new Noise(4321);
  constructor(private sr: number) {
    this.pDec = Math.exp(-1 / (0.01 * sr));
  }
  set(tone: number, res: number, decay: number, snap: number) {
    this.tone = tone;
    this.res = res;
    this.dec = decayCoef(decay, this.sr);
    this.bDec = decayCoef(decay * 0.6, this.sr);
    this.snap = snap;
  }
  trigger(note: number) {
    this.ratio = ratio(note);
    this.t = 0;
    this.amp = this.bAmp = this.pEnv = 1;
    this.ph1 = this.ph2 = 0;
    this.hpN.set(1800 * this.ratio, 0.7, this.sr);
    this.bpC.set(1100 * this.ratio, 1.2, this.sr);
    // three anchors (snare / 909 / clap), linear in between, each loudness-matched
    const s = this.snap;
    const lerp = (a: number, b: number, c: number) => (s < 0.5 ? a + (b - a) * s * 2 : b + (c - b) * (s - 0.5) * 2);
    const g = lerp(SNARE_GAIN[0], SNARE_GAIN[1], SNARE_GAIN[2]);
    this.wb = lerp(1, 0.7, 0) * g;
    this.wn = lerp(0.35, 0.9, 0) * g;
    this.wc = lerp(0, 0, 1) * g;
  }
  process() {
    if (this.amp < 1e-5) return 0;
    const ts = this.t++ / this.sr;
    this.pEnv *= this.pDec;
    const f = this.ratio * (1 + 0.5 * this.pEnv);
    this.ph1 += (185 * f) / this.sr;
    this.ph2 += (330 * f) / this.sr;
    if (this.ph1 >= 1) this.ph1 -= 1;
    if (this.ph2 >= 1) this.ph2 -= 1;
    const body = (Math.sin(TAU * this.ph1) * 0.6 + Math.sin(TAU * this.ph2) * 0.4) * this.bAmp;
    this.bAmp *= this.bDec;
    const n = this.noise.next();
    this.hpN.run(n);
    let y = this.wb * body + this.wn * this.hpN.hp * this.amp;
    if (this.wc > 0) {
      this.bpC.run(n);
      // clap: three short bursts, then the tail takes over
      let ce = 0;
      for (let k = 0; k < 3; k++) {
        const d = ts - k * 0.011;
        if (d >= 0) ce = Math.max(ce, Math.exp(-d / 0.004));
      }
      if (ts >= 0.03) ce = Math.max(ce, this.amp * 0.7);
      y += this.wc * this.bpC.bp * ce;
    }
    this.amp *= this.dec;
    return this.filter.process(y * 0.7, this.tone, this.res, this.sr);
  }
}
const SNARE_GAIN = [1.26, 1.43, 4.5]; // loudness match at Snap 0 / 0.5 / 1 (measured)

const DB_PER_OCTAVE = -2; // higher notes sound louder (esp. on small speakers), so tilt them down

/**
 * Mono saw synth. One oscillator for BASS and MELODY, four for CHORD. Analog drift is baked in.
 * CHORD voicing: each tone lands in the octave window just around the base note (-1…+10 st), whatever the root,
 * so moving between chords changes as few notes as possible.
 */
export class Synth implements Voice {
  private ph: Float64Array;
  private dt: Float64Array;
  private drift: Float64Array;
  private driftTarget: Float64Array;
  private noise = new Noise(4242);
  private ladder = new Ladder();
  private cutSm: Smooth;
  private env = 0; // amp envelope
  private fenv = 0; // filter envelope (the pluck): none while a note slides
  private attacking = false;
  private atkInc: number;
  private dec = 0;
  private envAmt = 3; // filter envelope depth, octaves
  private note = 0; // current pitch in semitones (float while sliding)
  private cur: Float64Array; // per-oscillator offset from the base note (float while sliding)
  private tgt: Float64Array;
  private from: Float64Array; // slide: where the pitch set off from…
  private fromNote = 0;
  private toNote = 0; // …and where it's heading
  private hold = false; // slide: no fading and no pluck until the next note
  private keyGain = 1; // loudness compensation for the current pitch
  private cutoff = 500;
  private res = 0;
  private blockCount = 0;

  constructor(
    private sr: number,
    private baseMidi: number,
    private detune: number[], // cents per oscillator
    private chord = false, // CHORD: trigger/glide take intervals, voiced around the base note
  ) {
    const n = detune.length;
    this.cur = new Float64Array(n);
    this.tgt = new Float64Array(n);
    this.from = new Float64Array(n);
    this.ph = new Float64Array(n).map(() => Math.random());
    this.dt = new Float64Array(n);
    this.drift = new Float64Array(n);
    this.driftTarget = new Float64Array(n);
    this.atkInc = 1 / (0.002 * sr);
    this.cutSm = new Smooth(500, timeCoef(0.01, sr));
  }

  /** Called once per block. */
  set(cutoff: number, res: number, decay: number, root: number, attack: number) {
    this.atkInc = 1 / (attack * this.sr);
    this.cutoff = cutoff;
    this.res = res;
    this.dec = decayCoef(decay, this.sr);
    // analog drift: slow random wander of ±4 cents
    if (++this.blockCount % 64 === 0) {
      for (let i = 0; i < this.drift.length; i++) this.driftTarget[i] = this.noise.next() * 4;
    }
    // chords stay in one register, so only mono notes need it
    this.keyGain = this.chord ? 1 : Math.pow(10, (DB_PER_OCTAVE * this.note) / 12 / 20);
    const midi = this.baseMidi + rootAbove(root, 5); // baseMidi is an F
    for (let i = 0; i < this.dt.length; i++) {
      this.drift[i] += (this.driftTarget[i] - this.drift[i]) * 0.02;
      const cents = this.detune[i] + this.drift[i];
      this.dt[i] = (mtof(midi + this.cur[i]) * Math.pow(2, cents / 1200)) / this.sr;
    }
  }

  /** Oscillator offsets for a note: the note itself (mono) or the chord voiced around the base note. */
  private voice(note: number, iv?: ArrayLike<number>) {
    if (!this.chord || !iv) {
      this.tgt.fill(note);
      return;
    }
    for (let i = 0; i < this.tgt.length; i++) {
      const pc = (((note + iv[i]) % 12) + 12) % 12;
      this.tgt[i] = (pc === 11 ? -1 : pc) + 12 * Math.floor(iv[i] / 12);
    }
  }

  trigger(note: number, iv?: ArrayLike<number>) {
    // from silence nothing can click: the filter starts right at this note's cutoff, no glide from the last one
    if (this.env < 1e-4) this.cutSm.v = this.cutoff;
    this.voice(note, iv);
    this.cur.set(this.tgt);
    this.note = note;
    this.attacking = true;
  }

  /** Arrive at the note a slide was heading for: exactly on its pitch, nothing retriggers. */
  arrive(note: number, iv?: ArrayLike<number>) {
    this.voice(note, iv);
    this.cur.set(this.tgt);
    this.note = note;
  }

  /** Start sliding from the current pitch toward this note; slidePos moves along the way. */
  slideTo(note: number, iv?: ArrayLike<number>) {
    this.from.set(this.cur);
    this.fromNote = this.note;
    this.voice(note, iv);
    this.toNote = note;
  }

  /** How far along the slide (0..1): pitch moves in a straight line, like every other value. */
  slidePos(f: number) {
    for (let i = 0; i < this.cur.length; i++) this.cur[i] = this.from[i] + (this.tgt[i] - this.from[i]) * f;
    this.note = this.fromNote + (this.toNote - this.fromNote) * f;
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
      this.fenv = this.hold ? 0 : this.env;
    } else {
      if (this.env < 1e-5) return 0;
      // a slid note just holds (no fading, no pluck) into the next note; otherwise Decay fades it
      if (this.hold) this.fenv = 0;
      else {
        this.env *= this.dec;
        this.fenv *= this.dec;
      }
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
    return this.ladder.process(osc * 0.7, fc, this.res, this.sr) * this.env * this.keyGain;
  }
}
