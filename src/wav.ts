// Collects recorded chunks from the engine and downloads a 24-bit stereo WAV or a 320 kbps MP3.
// (The VIDEO format records elsewhere: see video.ts.)

import { Mp3Encoder } from '@breezystack/lamejs';

export type RecFormat = 'wav' | 'mp3' | 'video';
const FORMATS: RecFormat[] = ['wav', 'mp3', 'video'];

const MP3_RATES = [32000, 44100, 48000]; // what LAME takes as-is; anything else falls back to WAV

export class Recorder {
  format: RecFormat = FORMATS.find((f) => f === localStorage.getItem('dubbox.recFormat')) ?? 'wav';

  setFormat(f: RecFormat) {
    this.format = f;
    localStorage.setItem('dubbox.recFormat', f);
  }

  private l: Float32Array[] = [];
  private r: Float32Array[] = [];

  push(l: Float32Array, r: Float32Array) {
    this.l.push(l);
    this.r.push(r);
  }

  finish(sampleRate: number) {
    const frames = this.l.reduce((n, c) => n + c.length, 0);
    const l = this.l, r = this.r;
    this.l = [];
    this.r = [];
    if (frames === 0) return;
    if (this.format === 'mp3' && MP3_RATES.includes(sampleRate)) download(mp3(l, r, sampleRate), 'audio/mpeg', 'mp3');
    else download(wav(l, r, frames, sampleRate), 'audio/wav', 'wav');
  }
}

function wav(l: Float32Array[], r: Float32Array[], frames: number, sampleRate: number): ArrayBuffer {
  const bytes = 44 + frames * 6;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 6, true);
  v.setUint16(32, 6, true);
  v.setUint16(34, 24, true);
  str(36, 'data');
  v.setUint32(40, frames * 6, true);

  let o = 44;
  const put = (x: number) => {
    const s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607);
    v.setUint8(o, s & 0xff);
    v.setUint8(o + 1, (s >> 8) & 0xff);
    v.setUint8(o + 2, (s >> 16) & 0xff);
    o += 3;
  };
  for (let c = 0; c < l.length; c++) {
    for (let i = 0; i < l[c].length; i++) {
      put(l[c][i]);
      put(r[c][i]);
    }
  }
  return buf;
}

function mp3(l: Float32Array[], r: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer>[] {
  const enc = new Mp3Encoder(2, sampleRate, 320);
  const out: Uint8Array<ArrayBuffer>[] = [];
  const i16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
  // the encoder reuses its output buffer: copy each block out
  for (let c = 0; c < l.length; c++) out.push(enc.encodeBuffer(i16(l[c]), i16(r[c])).slice());
  out.push(enc.flush().slice());
  return out;
}

export function download(data: BlobPart | BlobPart[], type: string, ext: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(Array.isArray(data) ? data : [data], { type }));
  a.download = `dubbox-${new Date().toISOString().slice(0, 16).replace(':', '')}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
