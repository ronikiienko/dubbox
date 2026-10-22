// The whole engine: clock, sequencer, voices, mixer, FX, master.
// Runs on the audio thread. Talks to the UI only through `port` (see bridge.ts).

import { GLOBAL, PARAMS, RATCHET, lvlGain, PARAM_BY_ID, SWING, chordIntervals, stepToSemi, TRACKS, fromIndex, hpHz, lockIds, mixId, snap, toReal, type ParamDef } from '../params';
import { NO_LOCK, audible, type TrackState } from '../state';
import type { FromEngine, ToEngine } from './bridge';
import { SVF, Smooth, timeCoef } from './dsp';
import { Crush, Drive, Glue, Spring, Phaser, Reverb, Tape, TapeDelay } from './fx';
import { Hat, Kick, Perc, Snare, Synth, type Voice } from './voices';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const N = GLOBAL; // instrument tracks; GLOBAL is the last track and has no voice
const DELAY_SIXTEENTHS = [1, 2, 3, 4, 6];
const REC_CHUNK = 8192;
const SPRING_GAIN = 0.33; // spring tank level vs the room (measured: the tank is ~10 dB hotter)

class Engine extends AudioWorkletProcessor {
  private sr = sampleRate;

  // state mirrored from the UI
  private norm: Record<string, number> = {};
  private tracks: TrackState[] = [];
  private throws = new Array<boolean>(N).fill(false);
  private R: Record<string, number> = {}; // real values for this block

  // per-note locks: each track plays with the values of its current note
  private lockDefs = TRACKS.map((_, i) => lockIds(i).map((id) => PARAM_BY_ID[id]));
  private globalDefs = lockIds(GLOBAL).map((id) => PARAM_BY_ID[id]);
  private gv: Record<string, number> = {}; // GLOBAL values in force now (normalized)
  private curK = new Int32Array(N).fill(-1); // step of the note now sounding, -1 = none yet
  private glideOn = new Array<boolean>(N).fill(false); // slid note: values glide into the next note

  // transport
  private playing = false;
  private phase = 0; // song position in 16th steps
  private nextK = 0; // next step to trigger
  private total = 0; // song length in steps
  private posCounter = 0;

  // voices + mixer
  private kick = new Kick(this.sr);
  private hat = new Hat(this.sr);
  private perc = new Perc(this.sr);
  private snare = new Snare(this.sr);
  private bass = new Synth(this.sr, 29, [0]);
  private chord = new Synth(this.sr, 41, [-6, 2, -2, 6], true);
  private mel = new Synth(this.sr, 53, [0]); // same mono saw as BASS, two octaves up
  private voices: Voice[] = [this.kick, this.hat, this.perc, this.snare, this.bass, this.chord, this.mel];
  private vals = new Float64Array(N);
  private hps = TRACKS.map(() => new SVF());
  private hpOn = new Array<boolean>(N).fill(false);
  private hpIds = TRACKS.map((td) => td.voice.find((id) => id.endsWith('.hp'))!);
  private drives = TRACKS.map(() => new Drive(this.sr));
  private crushes = TRACKS.map(() => new Crush(this.sr));
  private phasers = TRACKS.map(() => new Phaser(this.sr));
  private lvlT = new Float64Array(N);
  // ratchet: extra hits still to play inside the current step
  private ratLeft = new Int32Array(N);
  private ratAt = new Float64Array(N); // song phase of the next extra hit
  private ratStep = new Float64Array(N);
  private ratSemi = new Float64Array(N); // what to retrigger (synths: semitones, drums: the step's note)
  private dlyT = new Float64Array(N);
  private revT = new Float64Array(N);
  private panT = new Float64Array(N);
  private lvl: Smooth[];
  private dly: Smooth[];
  private rev: Smooth[];
  private pan: Smooth[];
  private vol: Smooth;

  // fx + master
  private delay = new TapeDelay(this.sr);
  private reverb = new Reverb(this.sr);
  private spring = new Spring(this.sr);
  private glue = new Glue(this.sr);
  private tape = new Tape(this.sr);

  // wav recording
  private recOn = false;
  private recL = new Float32Array(REC_CHUNK);
  private recR = new Float32Array(REC_CHUNK);
  private recN = 0;

  constructor() {
    super();
    const a = timeCoef(0.02, this.sr);
    this.lvl = TRACKS.map(() => new Smooth(0, a));
    this.dly = TRACKS.map(() => new Smooth(0, a));
    this.rev = TRACKS.map(() => new Smooth(0, a));
    this.pan = TRACKS.map(() => new Smooth(0, a));
    this.vol = new Smooth(0, a);
    for (const d of PARAMS) this.norm[d.id] = d.defN;
    this.port.onmessage = (e: MessageEvent<ToEngine>) => this.onMessage(e.data);
  }

  private post(msg: FromEngine, transfer: Transferable[] = []) {
    this.port.postMessage(msg, transfer);
  }

  private onMessage(m: ToEngine) {
    switch (m.t) {
      case 'init':
        Object.assign(this.norm, m.project.params);
        this.tracks = m.project.tracks;
        this.total = this.tracks[0].s.length;
        this.resolveGlobal(this.nextK - 1);
        break;
      case 'param':
        this.norm[m.id] = m.v;
        break;
      case 'step':
        this.tracks[m.i].s[m.si] = m.s;
        this.tracks[m.i].note[m.si] = m.note;
        this.tracks[m.i].slide[m.si] = m.slide;
        break;
      case 'lock':
        this.tracks[m.i].locks[m.id][m.si] = m.v;
        if (m.i === GLOBAL) this.resolveGlobal(this.nextK - 1);
        break;
      case 'flags':
        this.tracks[m.i].mute = m.mute;
        this.tracks[m.i].solo = m.solo;
        break;
      case 'throw':
        this.throws[m.i] = m.on;
        break;
      case 'play':
        this.playing = m.on;
        // release slide holds, otherwise a held note rings forever once the clock stops
        for (const v of this.voices) if (v instanceof Synth) v.setHold(false);
        this.curK.fill(-1);
        this.glideOn.fill(false);
        this.ratLeft.fill(0);
        this.phase = m.from;
        this.nextK = Math.ceil(m.from);
        this.resolveGlobal(this.nextK - 1);
        break;
      case 'rec':
        if (!m.on && this.recOn) this.flushRec(true);
        this.recOn = m.on;
        this.recN = 0;
        break;
    }
  }

  /** Normalized → snapped → real units. Once per block. */
  private updateParams() {
    for (const d of PARAMS) this.R[d.id] = toReal(d, snap(d, this.norm[d.id]));
    this.applyGlobal();
    for (let t = 0; t < N; t++) this.applyTrack(t);
    const R = this.R;
    const stepSamples = (this.sr * 60) / R.tempo / 4;
    this.delay.set(DELAY_SIXTEENTHS[R['delay.time']] * stepSamples, R['delay.fbk'], R['delay.tone']);
    this.reverb.set(R['reverb.size']);
    this.spring.set(R['reverb.size']);
    this.tape.set(R['tape.age']);
  }

  /** GLOBAL values in force at step k: each one's latest set value at or before k, else its default. */
  private resolveGlobal(k: number) {
    const locks = this.tracks[GLOBAL]?.locks;
    if (!locks) return;
    for (const d of this.globalDefs) {
      const arr = locks[d.id];
      let j = Math.min(k, this.total - 1);
      while (j >= 0 && arr[j] === NO_LOCK) j--;
      this.gv[d.id] = j >= 0 ? fromIndex(d, arr[j]) : snap(d, this.norm[d.id]);
    }
    this.applyGlobal();
  }

  private applyGlobal() {
    for (const d of this.globalDefs) if (d.id in this.gv) this.R[d.id] = toReal(d, this.gv[d.id]);
  }

  /** Locked value of param `d` at step k, or the knob's value. Normalized. */
  private lockValue(t: number, d: ParamDef, k: number): number {
    const v = k >= 0 ? this.tracks[t].locks[d.id][k] : NO_LOCK;
    return v === NO_LOCK ? snap(d, this.norm[d.id]) : fromIndex(d, v);
  }

  /** Resolve track t's strip for its current note (gliding if slid) and push it to voice + mixer. */
  private applyTrack(t: number) {
    const R = this.R;
    const k = this.curK[t];
    const glide = this.glideOn[t];
    const frac = glide ? Math.min(1, Math.max(0, this.phase - k)) : 0;
    for (const d of this.lockDefs[t]) {
      let n = this.lockValue(t, d, k);
      if (glide) n += (this.lockValue(t, d, k + 1) - n) * frac;
      R[d.id] = toReal(d, n);
    }

    this.lvlT[t] = audible(this.tracks, t) ? lvlGain(R[mixId(t, 'lvl')]) : 0;
    this.dlyT[t] = this.throws[t] ? 1 : R[mixId(t, 'dly')];
    this.revT[t] = R[mixId(t, 'rev')];
    this.panT[t] = R[mixId(t, 'pan')];
    const hpId = this.hpIds[t];
    const hp = hpHz(hpId.slice(0, hpId.indexOf('.')), R[hpId]);
    this.hpOn[t] = hp > 0;
    if (this.hpOn[t]) this.hps[t].set(hp, 0.707, this.sr);
    this.drives[t].set(R[mixId(t, 'dst')]);
    this.crushes[t].set(R[mixId(t, 'crs')]);
    this.phasers[t].set(R[mixId(t, 'phs')]);
    switch (t) {
      case 0: this.kick.set(R['kick.lp'], R['kick.res'], R['kick.decay'], R['kick.punch'], R['kick.click']); break;
      case 1: this.hat.set(R['hat.lp'], R['hat.res'], R['hat.decay'], R['hat.metal']); break;
      case 2: this.perc.set(R['perc.lp'], R['perc.res'], R['perc.decay']); break;
      case 3: this.snare.set(R['snare.lp'], R['snare.res'], R['snare.decay'], R['snare.snap']); break;
      case 4: this.bass.set(R['bass.lp'], R['bass.res'], R['bass.decay'], R.root); break;
      case 5: this.chord.set(R['chord.lp'], R['chord.res'], R['chord.decay'], R.root); break;
      case 6: this.mel.set(R['mel.lp'], R['mel.res'], R['mel.decay'], R.root); break;
    }
  }

  private iv = new Float64Array(4);

  /** A note with Ratchet > 1×: schedule its extra hits evenly inside the step. */
  private armRatchet(t: number, pitch: number) {
    const r = RATCHET[this.R[mixId(t, 'rat')]] ?? 1;
    if (r < 2) return;
    this.ratLeft[t] = r - 1;
    this.ratStep[t] = 1 / r;
    this.ratAt[t] = this.phase + 1 / r;
    this.ratSemi[t] = pitch;
  }

  private ratchetHit(t: number) {
    const v = this.voices[t];
    if (v instanceof Synth) v.trigger(this.ratSemi[t], v === this.chord ? this.iv : undefined);
    else v.trigger(this.ratSemi[t]);
  }

  private triggerStep(k: number) {
    // GLOBAL values set on this step take over first, so this step's notes already use them
    let changed = false;
    for (const d of this.globalDefs) {
      const v = this.tracks[GLOBAL].locks[d.id][k];
      if (v === NO_LOCK) continue;
      this.gv[d.id] = fromIndex(d, v);
      changed = true;
    }
    if (changed) this.applyGlobal();
    for (let t = 0; t < N; t++) {
      const tr = this.tracks[t];
      const v = this.voices[t];
      const s = tr.s[k];
      if (s) {
        // this note's values take over the track until the next note
        this.curK[t] = k;
        this.glideOn[t] = !!tr.slide[k] && k + 1 < this.total && !!tr.s[k + 1];
        this.applyTrack(t);
      }
      if (!audible(this.tracks, t)) {
        if (v instanceof Synth) v.setHold(false);
        continue;
      }
      if (s) this.ratLeft[t] = 0; // a new note cancels the previous one's remaining hits
      if (v instanceof Synth) {
        // synth pitch = scale step in the current scale; CHORD also stacks its chord from there
        let semi = 0;
        const iv = v === this.chord ? this.iv : undefined;
        if (s) {
          const scale = this.R.scale;
          semi = stepToSemi(scale, tr.note[k]);
          if (iv) chordIntervals(scale, this.R['chord.size'], tr.note[k], iv);
        }
        // 303 slide: a slid step holds its note and glides into this one instead of retriggering
        const slidIn = k > 0 && tr.s[k - 1] && tr.slide[k - 1];
        if (s && slidIn) v.glide(semi, iv);
        else if (s) v.trigger(semi, iv);
        if (s) this.armRatchet(t, semi);
        v.setHold(!!s && !!tr.slide[k]);
      } else if (s) {
        v.trigger(tr.note[k]);
        this.armRatchet(t, tr.note[k]);
      }
    }
  }

  private flushRec(end: boolean) {
    if (this.recN > 0) {
      const l = this.recL.slice(0, this.recN);
      const r = this.recR.slice(0, this.recN);
      this.post({ t: 'audio', l, r }, [l.buffer, r.buffer]);
      this.recN = 0;
    }
    if (end) this.post({ t: 'recEnd', sampleRate: this.sr });
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outL;
    const frames = outL.length;
    if (this.tracks.length === 0) return true;

    this.updateParams();
    const R = this.R;
    const inc = R.tempo / 60 / this.sr * 4;
    const swing = (SWING[R.swing] - 50) / 50;
    const vol = R.volume;
    const vals = this.vals;

    for (let s = 0; s < frames; s++) {
      if (this.playing) {
        while (this.nextK < this.total && this.phase >= this.nextK + (this.nextK & 1 ? swing : 0)) this.triggerStep(this.nextK++);
        for (let t = 0; t < N; t++) {
          if (this.ratLeft[t] > 0 && this.phase >= this.ratAt[t]) {
            this.ratchetHit(t);
            this.ratLeft[t]--;
            this.ratAt[t] += this.ratStep[t];
          }
        }
        this.phase += inc;
        if (this.phase >= this.total) {
          // song end: loop to the top
          this.phase -= this.total;
          this.nextK = 0;
          this.ratLeft.fill(0);
          this.resolveGlobal(-1);
        }
      }

      for (let t = 0; t < N; t++) vals[t] = this.voices[t].process();

      // per track: highpass → dist → bitcrush → phaser → fader → post-fader sends
      let dryL = 0, dryR = 0, dIn = 0, rIn = 0;
      for (let t = 0; t < N; t++) {
        const g = this.lvl[t].next(this.lvlT[t]);
        let x = vals[t];
        if (this.hpOn[t]) {
          this.hps[t].run(x);
          x = this.hps[t].hp;
        }
        const v = this.phasers[t].process(this.crushes[t].process(this.drives[t].process(x))) * g;
        // equal-power pan, scaled so centre = unity on both sides (sounds exactly like no pan)
        const th = (this.pan[t].next(this.panT[t]) + 1) * (Math.PI / 4);
        dryL += v * Math.SQRT2 * Math.cos(th);
        dryR += v * Math.SQRT2 * Math.sin(th);
        // sends are taken before the pan: echo and room stay one centred space
        dIn += v * this.dly[t].next(this.dlyT[t]);
        rIn += v * this.rev[t].next(this.revT[t]);
      }

      this.delay.process(dIn);
      const dl = this.delay.l, dr = this.delay.r;
      const rvIn = rIn + 0.125 * (dl + dr);
      this.reverb.process(rvIn);
      this.spring.process(rvIn);
      // Spring: equal-power crossfade room → spring tank (the spring is level-matched to the room)
      const sa = (R['reverb.spring'] * Math.PI) / 2;
      const rc = Math.cos(sa), sc = Math.sin(sa) * SPRING_GAIN;
      const rvL = this.reverb.l * rc + this.spring.l * sc;
      const rvR = this.reverb.r * rc + this.spring.r * sc;

      this.glue.process(dryL + dl + rvL, dryR + dr + rvR);
      this.tape.process(this.glue.l, this.glue.r);

      const g = this.vol.next(vol);
      const l = safety(this.tape.l * g);
      const r = safety(this.tape.r * g);
      outL[s] = l;
      outR[s] = r;

      if (this.recOn) {
        this.recL[this.recN] = l;
        this.recR[this.recN] = r;
        if (++this.recN === REC_CHUNK) this.flushRec(false);
      }
    }

    this.posCounter += frames;
    if (this.posCounter >= this.sr / 30) {
      this.posCounter = 0;
      this.post({ t: 'pos', phase: this.phase });
    }
    return true;
  }
}

/** Transparent below 0.9, soft-clips above. */
function safety(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.9) return x;
  return Math.sign(x) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
}

registerProcessor('dubbox', Engine);
