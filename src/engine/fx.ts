import { DelayLine, Noise, OnePole, Smooth, TAU, clamp, dbToGain, lpCoef, tanh, timeCoef } from './dsp';

/** Tape echo: HP + LP + tanh inside the feedback loop, slewed time, wow. */
export class TapeDelay {
  private dl: DelayLine;
  private time: Smooth;
  private target = 0;
  private fbk = 0;
  private lpA = 0;
  private hpA = 0;
  private lp1 = new OnePole();
  private lp2 = new OnePole();
  private hp = new OnePole();
  private wowPh = 0;
  private wowPh2 = 0;
  private stereo: number;
  l = 0;
  r = 0;

  constructor(private sr: number) {
    this.dl = new DelayLine(sr * 4);
    this.time = new Smooth(sr * 0.3, timeCoef(0.1, sr));
    this.stereo = 0.011 * sr;
  }

  /** tone: -1 dark .. 0 neutral .. +1 thin */
  set(timeSamples: number, fbk: number, tone: number) {
    this.target = timeSamples;
    this.fbk = fbk;
    const lp = tone < 0 ? 6000 * Math.pow(800 / 6000, -tone) : 6000;
    const hp = tone > 0 ? 120 * Math.pow(1500 / 120, tone) : 120;
    this.lpA = lpCoef(lp, this.sr);
    this.hpA = lpCoef(hp, this.sr);
  }

  process(x: number) {
    const sr = this.sr;
    const t = this.time.next(this.target);
    this.wowPh += 0.4 / sr;
    this.wowPh2 += 0.13 / sr;
    if (this.wowPh >= 1) this.wowPh -= 1;
    if (this.wowPh2 >= 1) this.wowPh2 -= 1;
    const wow = (Math.sin(TAU * this.wowPh) * 0.6 + Math.sin(TAU * this.wowPh2) * 0.3) * 0.001 * sr;

    const tapL = this.dl.read(t + wow);
    const tapR = this.dl.read(t + wow + this.stereo);
    const f = this.hp.hp(this.lp2.lp(this.lp1.lp(tapL, this.lpA), this.lpA), this.hpA);
    this.dl.write(x + tanh(f * this.fbk));
    this.l = tapL;
    this.r = tapR;
  }
}

/** 8-line feedback delay network, Householder mix, damped, two lines modulated. */
export class Reverb {
  private static MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 79.3];
  private lines: DelayLine[];
  private len: number[];
  private damp: OnePole[];
  private g = new Float64Array(8);
  private outs = new Float64Array(8);
  private dampA = 0;
  private inHp = new OnePole();
  private inHpA: number;
  private pre: DelayLine;
  private preLen: number;
  private modPh = 0;
  l = 0;
  r = 0;

  constructor(private sr: number) {
    const scale = 1.4;
    this.len = Reverb.MS.map((ms) => (ms * scale * sr) / 1000);
    this.lines = this.len.map((l) => new DelayLine(Math.ceil(l) + 64));
    this.damp = this.len.map(() => new OnePole());
    this.inHpA = lpCoef(200, sr);
    this.preLen = 0.02 * sr;
    this.pre = new DelayLine(Math.ceil(this.preLen) + 4);
  }

  set(size: number) {
    const rt60 = 1.5 * Math.pow(14 / 1.5, size);
    for (let i = 0; i < 8; i++) this.g[i] = Math.pow(10, (-3 * this.len[i]) / (rt60 * this.sr));
    this.dampA = lpCoef(7000 * Math.pow(2500 / 7000, size), this.sr);
  }

  process(x: number) {
    this.pre.write(this.inHp.hp(x, this.inHpA));
    const input = this.pre.read(this.preLen) * 0.35;

    this.modPh += 0.7 / this.sr;
    if (this.modPh >= 1) this.modPh -= 1;
    const mod = Math.sin(TAU * this.modPh) * 6;

    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const d = this.len[i] + (i === 1 ? mod : i === 5 ? -mod : 0);
      const v = this.damp[i].lp(this.lines[i].read(d), this.dampA) * this.g[i];
      this.outs[i] = v;
      sum += v;
    }
    const h = sum * 0.25; // Householder: v - (2/N) * sum
    let l = 0;
    let r = 0;
    for (let i = 0; i < 8; i++) {
      const v = this.outs[i];
      this.lines[i].write(v - h + (i & 1 ? -input : input));
      if (i & 1) r += v * (i & 2 ? -1 : 1);
      else l += v * (i & 2 ? -1 : 1);
    }
    this.l = l * 0.5;
    this.r = r * 0.5;
  }
}

/**
 * Saturation that keeps loudness constant: tanh drive with a little asymmetry (even harmonics).
 * Makeup gain is computed per block for the *current input level* (RMS of a sine at that level,
 * before vs after the curve), so it's right from the first sample of a note; a slow RMS
 * correction then trims what the sine model misses. 0 = bypassed.
 */
export class Drive {
  private amt = 0;
  private g = 1;
  private bias = 0;
  private makeup = 1;
  private inP = 0;
  private outP = 0;
  private corr = 1;
  private a: number;
  private ca: number;
  constructor(sr: number) {
    this.a = timeCoef(0.03, sr);
    this.ca = timeCoef(0.3, sr);
  }

  /** Called once per block. */
  set(amount: number) {
    this.amt = amount;
    if (amount === 0) return;
    this.g = 1 + 30 * amount * amount;
    this.bias = 0.15 * amount;
    const level = clamp(Math.sqrt(2 * this.inP), 0.05, 1.5); // peak of a sine with this RMS
    let pin = 0, pout = 0;
    for (let i = 0; i < 32; i++) {
      const x = level * Math.sin((TAU * i) / 32);
      const y = tanh(this.g * x + this.bias) - tanh(this.bias);
      pin += x * x;
      pout += y * y;
    }
    this.makeup = Math.sqrt(pin / pout);
  }

  process(x: number): number {
    // the input follower always runs, so the makeup is ready when Dist switches on at a note
    this.inP += this.a * (x * x - this.inP);
    if (this.amt === 0) return x;
    const y = (tanh(this.g * x + this.bias) - tanh(this.bias)) * this.makeup;
    this.outP += this.a * (y * y - this.outP);
    if (this.inP > 1e-7) {
      const target = clamp(Math.sqrt(this.inP / (this.outP + 1e-12)), 0.5, 2);
      this.corr += this.ca * (target - this.corr);
    }
    return y * this.corr;
  }
}

/** 4-stage allpass phaser, one per track as an insert. Amount 0 is transparent. */
export class Phaser {
  private x1 = new Float64Array(4);
  private y1 = new Float64Array(4);
  private lfo = 0;
  private fb = 0;
  private amount = 0;
  constructor(private sr: number) {}

  set(amount: number) {
    this.amount = amount;
  }

  process(x: number): number {
    const amt = this.amount;
    if (amt < 0.001) return x;
    this.lfo += (0.12 + 0.28 * amt) / this.sr;
    if (this.lfo >= 1) this.lfo -= 1;
    const l01 = 0.5 + 0.5 * Math.sin(TAU * this.lfo);
    const fc = 250 * Math.pow(10, l01 * (0.4 + 0.6 * amt));
    const t = Math.tan((Math.PI * fc) / this.sr);
    const a = (t - 1) / (t + 1);

    let y = x + this.fb * amt * 0.6;
    for (let i = 0; i < 4; i++) {
      const out = a * y + this.x1[i] - a * this.y1[i];
      this.x1[i] = y;
      this.y1[i] = out;
      y = out;
    }
    this.fb = clamp(y, -2, 2);
    return x + amt * 0.5 * (y - x);
  }
}

/** Fixed bus compressor: 2:1, 10 ms / 150 ms, RMS, stereo-linked. */
export class Glue {
  private env = 0;
  private atk: number;
  private rel: number;
  private makeup = dbToGain(1);
  l = 0;
  r = 0;
  constructor(sr: number) {
    this.atk = timeCoef(0.01, sr);
    this.rel = timeCoef(0.15, sr);
  }
  process(l: number, r: number) {
    const p = (l * l + r * r) * 0.5;
    this.env += (p > this.env ? this.atk : this.rel) * (p - this.env);
    const db = 10 * Math.log10(this.env + 1e-12);
    const over = db + 12;
    const g = over > 0 ? Math.pow(10, (-over * 0.5) / 20) * this.makeup : this.makeup;
    this.l = l * g;
    this.r = r * g;
  }
}

/** Master tape macro. Age 0..1 drives saturation, wow/flutter, HF loss, hiss and low bump together. */
export class Tape {
  private dlL: DelayLine;
  private dlR: DelayLine;
  private base: number;
  private wow = 0;
  private flutter = 0;
  private depth = 0;
  private drive = 1;
  private norm = 1;
  private hfA = 1;
  private lpL = [new OnePole(), new OnePole()];
  private lpR = [new OnePole(), new OnePole()];
  private bumpL = new OnePole();
  private bumpR = new OnePole();
  private bumpA: number;
  private bumpK = 0;
  private hiss = 0;
  private nL = new Noise(777);
  private nR = new Noise(31337);
  private pinkL = new Float64Array(3);
  private pinkR = new Float64Array(3);
  l = 0;
  r = 0;

  constructor(private sr: number) {
    this.dlL = new DelayLine(0.02 * sr);
    this.dlR = new DelayLine(0.02 * sr);
    this.base = 0.005 * sr;
    this.bumpA = lpCoef(80, sr);
  }

  set(age: number) {
    this.drive = 1 + 2 * age;
    this.norm = 1 / Math.pow(this.drive, 0.7);
    this.hfA = lpCoef(20000 * Math.pow(7000 / 20000, age), this.sr);
    this.depth = 0.0008 * this.sr * age;
    this.hiss = dbToGain(-90 + 32 * age);
    this.bumpK = dbToGain(2 * age) - 1;
  }

  private pink(n: Noise, b: Float64Array) {
    const w = n.next();
    b[0] = 0.99765 * b[0] + w * 0.099046;
    b[1] = 0.963 * b[1] + w * 0.2965164;
    b[2] = 0.57 * b[2] + w * 1.0526913;
    return (b[0] + b[1] + b[2] + w * 0.1848) * 0.2;
  }

  process(l: number, r: number) {
    const sr = this.sr;
    this.wow += 0.5 / sr;
    this.flutter += 6 / sr;
    if (this.wow >= 1) this.wow -= 1;
    if (this.flutter >= 1) this.flutter -= 1;
    const mL = 0.7 * Math.sin(TAU * this.wow) + 0.3 * Math.sin(TAU * this.flutter);
    const mR = 0.7 * Math.sin(TAU * this.wow + 0.3) + 0.3 * Math.sin(TAU * this.flutter + 1.1);

    this.dlL.write(tanh(l * this.drive) * this.norm);
    this.dlR.write(tanh(r * this.drive) * this.norm);
    l = this.dlL.read(this.base + this.depth * mL);
    r = this.dlR.read(this.base + this.depth * mR);

    l += this.bumpK * this.bumpL.lp(l, this.bumpA);
    r += this.bumpK * this.bumpR.lp(r, this.bumpA);
    l = this.lpL[1].lp(this.lpL[0].lp(l, this.hfA), this.hfA);
    r = this.lpR[1].lp(this.lpR[0].lp(r, this.hfA), this.hfA);

    this.l = l + this.hiss * this.pink(this.nL, this.pinkL);
    this.r = r + this.hiss * this.pink(this.nR, this.pinkR);
  }
}
