import { CRUSH } from '../params';
import { DelayLine, Noise, OnePole, SVF, Smooth, TAU, clamp, dbToGain, lpCoef, tanh, timeCoef } from './dsp';

/**
 * Tape echo: HP + LP + tanh inside the feedback loop, slewed time, wow. Two loops (A = left, B = right):
 * at Spread's default they run identically, the right one heard 11 ms late (the old fixed width); below it
 * the offset shrinks to mono; above it the loops cross-feed into ping-pong (input only into A, A → B → A).
 */
export class TapeDelay {
  private a: DelayLine;
  private b: DelayLine;
  private time: Smooth;
  private target = 0;
  private fbk = 0;
  private lpA = 0;
  private hpA = 0;
  private fa = [new OnePole(), new OnePole(), new OnePole()]; // loop A: lp, lp, hp
  private fb = [new OnePole(), new OnePole(), new OnePole()];
  private wowPh = 0;
  private wowPh2 = 0;
  private flutPh = 0;
  private wob = 1; // wow depth, ms (1 = the old fixed amount)
  private flut = 0; // flutter depth, ms
  private off = 0; // right side's extra delay, samples
  private cross = 0; // 0 = two equal loops .. 1 = ping-pong
  private verb = 0.125; // how much of the echo goes into the room
  // all glide, so changing them mid-tail doesn't click
  private wobS: Smooth;
  private flutS: Smooth;
  private offS: Smooth;
  private crossS: Smooth;
  private verbS: Smooth;
  l = 0;
  r = 0;
  rv = 0; // into the reverb

  constructor(private sr: number) {
    this.a = new DelayLine(sr * 4);
    this.b = new DelayLine(sr * 4);
    this.time = new Smooth(sr * 0.3, timeCoef(0.1, sr));
    const c = timeCoef(0.15, sr);
    this.wobS = new Smooth(1, c);
    this.flutS = new Smooth(0, c);
    this.offS = new Smooth(0.011 * sr, c);
    this.crossS = new Smooth(0, c);
    this.verbS = new Smooth(0.125, c);
  }

  /** tone: -1 dark .. 0 neutral .. +1 thin; wobble 0 clean .. 0.25 default .. 1 seasick;
   *  spread 0 mono .. 0.25 default .. 1 ping-pong; verb: share of the echo sent to the reverb */
  set(timeSamples: number, fbk: number, tone: number, wobble: number, spread: number, verb: number) {
    // slow wow grows with the square (default 1 ms, top 16 ms ≈ ±70 cents); fast flutter joins above default
    this.wob = 16 * wobble * wobble;
    this.flut = 0.2 * Math.max(0, wobble - 0.25) / 0.75;
    this.off = 0.011 * this.sr * Math.min(1, spread / 0.25);
    this.cross = Math.max(0, spread - 0.25) / 0.75;
    this.verb = verb;
    this.target = timeSamples;
    this.fbk = fbk;
    // dark side: 6 kHz → 250 Hz, curved so −0.25 (the default) stays at ~3.6 kHz
    const lp = tone < 0 ? 6000 * Math.pow(250 / 6000, Math.pow(-tone, 1.335)) : 6000;
    const hp = tone > 0 ? 120 * Math.pow(1500 / 120, tone) : 120;
    this.lpA = lpCoef(lp, this.sr);
    this.hpA = lpCoef(hp, this.sr);
  }

  /** Take the set values outright (first note after Play), apart from Time (its tail may still ring). */
  snap() {
    this.wobS.v = this.wob;
    this.flutS.v = this.flut;
    this.offS.v = this.off;
    this.crossS.v = this.cross;
    this.verbS.v = this.verb;
  }

  private filt(f: OnePole[], x: number) {
    return f[2].hp(f[1].lp(f[0].lp(x, this.lpA), this.lpA), this.hpA);
  }

  process(x: number) {
    const sr = this.sr;
    const t = this.time.next(this.target);
    this.wowPh += 0.4 / sr;
    this.wowPh2 += 0.13 / sr;
    if (this.wowPh >= 1) this.wowPh -= 1;
    if (this.wowPh2 >= 1) this.wowPh2 -= 1;
    this.flutPh += 6.3 / sr;
    if (this.flutPh >= 1) this.flutPh -= 1;
    const wow = ((Math.sin(TAU * this.wowPh) * 0.6 + Math.sin(TAU * this.wowPh2) * 0.3) * this.wobS.next(this.wob) + Math.sin(TAU * this.flutPh) * this.flutS.next(this.flut)) * 0.001 * sr;
    const d = t + wow;
    const p = this.crossS.next(this.cross);

    const tapA = this.a.read(d);
    const tapB = this.b.read(d);
    const fA = this.filt(this.fa, tapA);
    const fB = this.filt(this.fb, tapB);
    this.a.write(x + tanh(this.fbk * (fA + p * (fB - fA))));
    this.b.write(x * (1 - p) + tanh(this.fbk * (fB + p * (fA - fB))));
    this.l = tapA;
    this.r = this.b.read(d + this.offS.next(this.off) + 1); // +1: B was just written
    this.rv = (this.l + this.r) * this.verbS.next(this.verb);
  }
}

/** 8-line feedback delay network, Householder mix, damped, two lines modulated. */
/**
 * Spring tank (one spring per side): a feedback delay whose loop runs through a long chain of
 * allpasses. The chain delays low frequencies more than high ones, so every echo smears into the
 * dispersive "boing" chirp; a soft clip in the loop adds the splash when it's hit hard.
 */
export class Spring {
  private static N = 16; // allpasses per spring
  private static A = 0.6; // allpass coefficient: amount of dispersion
  private ap = [new Float64Array(Spring.N), new Float64Array(Spring.N)];
  private lines: DelayLine[];
  private len: number[];
  private lp = [new OnePole(), new OnePole()];
  private hp = [new OnePole(), new OnePole()];
  private inHp = new OnePole();
  private lpA: number;
  private hpA: number;
  private inHpA: number;
  private fb = 0.8;
  private modPh = 0;
  l = 0;
  r = 0;

  constructor(private sr: number) {
    this.len = [0.037 * sr, 0.043 * sr];
    this.lines = this.len.map((l) => new DelayLine(Math.ceil(l) + 64));
    this.lpA = lpCoef(4200, sr);
    this.hpA = lpCoef(120, sr);
    this.inHpA = lpCoef(150, sr);
  }

  /** Same Size as the room: longer tail. */
  set(size: number) {
    this.fb = 0.72 + 0.2 * size;
  }

  process(x: number) {
    const input = this.inHp.hp(x, this.inHpA);
    this.modPh += 0.9 / this.sr;
    if (this.modPh >= 1) this.modPh -= 1;
    const mod = Math.sin(TAU * this.modPh) * 3;
    const a = Spring.A;
    for (let c = 0; c < 2; c++) {
      let y = this.lines[c].read(this.len[c] + (c ? -mod : mod));
      const st = this.ap[c];
      for (let i = 0; i < Spring.N; i++) {
        const out = -a * y + st[i];
        st[i] = y + a * out;
        y = out;
      }
      y = this.hp[c].hp(this.lp[c].lp(y, this.lpA), this.hpA);
      this.lines[c].write(input + tanh(y * this.fb * 1.2) / 1.2);
      if (c) this.r = y;
      else this.l = y;
    }
  }
}

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
/** Bitcrusher: sample-and-hold at a lower rate (no anti-aliasing, that's the sound) + bit-depth quantize. */
export class Crush {
  private on = false;
  private ph = 0;
  private inc = 0;
  private q = 1;
  private hold = 0;
  constructor(private sr: number) {}
  /** v = 0..1 knob position; 0 = bypass. */
  set(v: number) {
    const [bits, rate] = CRUSH[Math.round(v * 8)];
    this.on = bits > 0;
    if (!this.on) return;
    this.inc = rate / this.sr;
    this.q = Math.pow(2, bits - 1);
  }
  process(x: number): number {
    if (!this.on) return x;
    this.ph += this.inc;
    if (this.ph >= 1) {
      this.ph -= 1;
      this.hold = Math.round(x * this.q) / this.q;
    }
    return this.hold;
  }
}

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

/** Smooth random LFO in -1..1: glides to a new random target every `period` seconds (±50%). */
class Wander {
  private v = 0;
  private target = 0;
  private left = 0;
  constructor(private sr: number, private period: number, private glide: number, private noise: Noise) {}
  next(): number {
    if (--this.left <= 0) {
      this.target = this.noise.next();
      this.left = Math.floor(this.period * this.sr * (0.5 + Math.abs(this.noise.next())));
    }
    return (this.v += this.glide * (this.target - this.v));
  }
}

/**
 * Master tape macro. One knob, Age 0..1: 0 clean · 0.3 warm · 0.6 good cassette · 1 worn dub cassette.
 * Chain per channel: pre-emphasis → level-matched saturation → de-emphasis → head bump → low cut
 * → stereo narrowing → wow/flutter (random, shared transport) → dropouts → hiss → top roll-off.
 */
export class Tape {
  private age = 0;
  // saturation: highs boosted before and cut after, so they compress more (tape "softness")
  private satL: Drive;
  private satR: Drive;
  private preL = new OnePole();
  private preR = new OnePole();
  private deL = new OnePole();
  private deR = new OnePole();
  private emphA: number;
  private emph = 0;
  // frequency response
  private bumpL = new SVF();
  private bumpR = new SVF();
  private bumpK = 0;
  private hpL = new SVF();
  private hpR = new SVF();
  private lpL = new SVF();
  private lpR = new SVF();
  private width = 1;
  // transport
  private dlL: DelayLine;
  private dlR: DelayLine;
  private base: number;
  private noise = new Noise(4711);
  private wow: Wander;
  private flutL: Wander;
  private flutR: Wander;
  private wowDepth = 0;
  private flutDepth = 0;
  // dropouts
  private dropPos = 0;
  private dropLen = 0;
  private dropDepth = 0;
  private dropRate = 0;
  private dropLpL = new OnePole();
  private dropLpR = new OnePole();
  private dropA: number;
  // hiss
  private hiss = 0;
  private nL = new Noise(777);
  private nR = new Noise(31337);
  private pinkL = new Float64Array(3);
  private pinkR = new Float64Array(3);
  l = 0;
  r = 0;

  constructor(private sr: number) {
    this.satL = new Drive(sr);
    this.satR = new Drive(sr);
    this.emphA = lpCoef(3000, sr);
    this.dlL = new DelayLine(0.03 * sr);
    this.dlR = new DelayLine(0.03 * sr);
    this.base = 0.008 * sr;
    this.wow = new Wander(sr, 0.6, timeCoef(0.25, sr), this.noise);
    this.flutL = new Wander(sr, 0.08, timeCoef(0.015, sr), this.noise);
    this.flutR = new Wander(sr, 0.08, timeCoef(0.015, sr), this.noise);
    this.dropA = lpCoef(2000, sr);
  }

  /** Called once per block. */
  set(age: number) {
    const a = (this.age = age);
    const sr = this.sr;
    this.satL.set(0.55 * a);
    this.satR.set(0.55 * a);
    this.emph = 1.5 * a;
    this.bumpL.set(90, 1, sr);
    this.bumpR.set(90, 1, sr);
    this.bumpK = dbToGain(4 * a) - 1;
    const hp = 10 * Math.pow(5, a); // 10 Hz (inaudible) … 50 Hz
    this.hpL.set(hp, 0.707, sr);
    this.hpR.set(hp, 0.707, sr);
    const lp = 20000 * Math.pow(5000 / 20000, a); // 20 kHz … 5 kHz
    this.lpL.set(lp, 0.707, sr);
    this.lpR.set(lp, 0.707, sr);
    const worn = Math.max(0, (a - 0.4) / 0.6); // 0 below Age 0.4, 1 at max: the 'damaged' artifacts
    this.width = 1 - 0.7 * worn;
    this.wowDepth = 0.0018 * sr * a * a; // up to ~1% pitch wander
    this.flutDepth = 0.00012 * sr * a * a;
    this.dropRate = (1.5 * worn * worn) / sr; // dropouts per sample: none below Age 0.4, ~1.5/s at max
    this.hiss = dbToGain(-90 + 45 * a);
  }

  private pink(n: Noise, b: Float64Array) {
    const w = n.next();
    b[0] = 0.99765 * b[0] + w * 0.099046;
    b[1] = 0.963 * b[1] + w * 0.2965164;
    b[2] = 0.57 * b[2] + w * 1.0526913;
    return (b[0] + b[1] + b[2] + w * 0.1848) * 0.2;
  }

  process(l: number, r: number) {
    if (this.age === 0) {
      this.l = l;
      this.r = r;
      return;
    }
    // pre-emphasis → saturation → de-emphasis (flat when linear, highs squash first when driven)
    const k = this.emph, ea = this.emphA;
    l = this.satL.process(l + k * (l - this.preL.lp(l, ea)));
    r = this.satR.process(r + k * (r - this.preR.lp(r, ea)));
    const kd = k / (1 + k);
    l -= kd * (l - this.deL.lp(l, ea));
    r -= kd * (r - this.deR.lp(r, ea));

    // head bump + low cut
    this.bumpL.run(l);
    this.bumpR.run(r);
    l += this.bumpK * this.bumpL.bp;
    r += this.bumpK * this.bumpR.bp;
    this.hpL.run(l);
    this.hpR.run(r);
    l = this.hpL.hp;
    r = this.hpR.hp;

    // stereo narrowing
    const mid = (l + r) * 0.5, side = (r - l) * 0.5 * this.width;
    l = mid - side;
    r = mid + side;

    // wow (shared transport) + flutter (slightly different per channel)
    const w = this.wow.next() * this.wowDepth;
    this.dlL.write(l);
    this.dlR.write(r);
    l = this.dlL.read(this.base + w + this.flutL.next() * this.flutDepth);
    r = this.dlR.read(this.base + w + this.flutR.next() * this.flutDepth);

    // dropouts: short random dips in level and highs
    if (this.dropPos >= this.dropLen && this.noise.next() * 0.5 + 0.5 < this.dropRate) {
      this.dropPos = 0;
      this.dropLen = Math.floor(this.sr * (0.02 + 0.1 * (this.noise.next() * 0.5 + 0.5)));
      this.dropDepth = (0.3 + 0.55 * (this.noise.next() * 0.5 + 0.5)) * this.age;
    }
    if (this.dropPos < this.dropLen) {
      const env = 0.5 - 0.5 * Math.cos((TAU * this.dropPos++) / this.dropLen);
      const d = env * this.dropDepth;
      l += d * (this.dropLpL.lp(l, this.dropA) - l);
      r += d * (this.dropLpR.lp(r, this.dropA) - r);
      l *= 1 - d * 0.6;
      r *= 1 - d * 0.6;
    } else {
      this.dropLpL.lp(l, this.dropA);
      this.dropLpR.lp(r, this.dropA);
    }

    // hiss, then the top roll-off over everything (hiss included)
    l += this.hiss * this.pink(this.nL, this.pinkL);
    r += this.hiss * this.pink(this.nR, this.pinkR);
    this.lpL.run(l);
    this.lpR.run(r);
    this.l = this.lpL.lp;
    this.r = this.lpR.lp;
  }
}
