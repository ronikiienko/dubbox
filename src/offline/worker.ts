// Offline export: runs the engine as fast as the CPU allows, from bar 1 to the last note plus the
// effect tails, then encodes. Same sound as playback (mute/solo included), no realtime needed.

import { Engine, SAMPLE_RATE } from './shim';
import '../engine/worklet';
import { GLOBAL } from '../params';
import type { Project } from '../state';
import type { ToEngine } from '../engine/bridge';
import { mp3, wav } from '../wav';

export type ToExport = { project: Project; format: 'wav' | 'mp3' };
export type FromExport = { t: 'progress'; f: number } | { t: 'done'; data: BlobPart[]; type: string; ext: string };

const BLOCK = 128;
const CHUNK = 1 << 16; // samples per stored chunk
const SILENT = 10 ** (-60 / 20); // tails end once this quiet (tape hiss sits below)...
const SILENT_FOR = 1; // ...for this many seconds
const MAX_TAIL = 20; // seconds, in case something never dies away

self.onmessage = (e: MessageEvent<ToExport>) => {
  const { project, format } = e.data;
  const eng = new Engine!();
  const msg = (m: ToEngine) => eng.port.onmessage!({ data: m });
  msg({ t: 'init', project });
  msg({ t: 'play', on: true, from: 0 });

  // the song runs to the last note, plus a bar so the last note and ties play out
  let last = -1;
  for (const tr of project.tracks.slice(0, GLOBAL)) for (let k = tr.s.length - 1; k > last; k--) if (tr.s[k]) { last = k; break; }
  const stopAt = Math.min(last + 1 + 16, project.tracks[0].s.length);

  const outL = new Float32Array(BLOCK), outR = new Float32Array(BLOCK);
  const L: Float32Array[] = [], R: Float32Array[] = [];
  let cl = new Float32Array(CHUNK), cr = new Float32Array(CHUNK), n = 0;
  let phase = 0, stopped = last < 0, quiet = 0, tail = 0, lastPost = 0;
  const pos = eng as unknown as { phase: number }; // the engine's song position

  for (;;) {
    eng.process([], [[outL, outR]]);
    let pk = 0;
    for (let i = 0; i < BLOCK; i++) {
      cl[n] = outL[i];
      cr[n] = outR[i];
      pk = Math.max(pk, Math.abs(outL[i]), Math.abs(outR[i]));
      if (++n === CHUNK) {
        L.push(cl); R.push(cr);
        cl = new Float32Array(CHUNK); cr = new Float32Array(CHUNK); n = 0;
      }
    }
    if (!stopped) {
      const wrapped = pos.phase < phase; // the song end jumps back to the top
      phase = pos.phase;
      if (phase >= stopAt || wrapped) {
        msg({ t: 'play', on: false, from: 0 }); // releases held notes; delay and reverb ring on
        stopped = true;
      }
      if (phase - lastPost > 64) {
        self.postMessage({ t: 'progress', f: phase / stopAt } satisfies FromExport);
        lastPost = phase;
      }
    } else {
      tail += BLOCK;
      quiet = pk < SILENT ? quiet + BLOCK : 0;
      if (quiet >= SILENT_FOR * SAMPLE_RATE || tail >= MAX_TAIL * SAMPLE_RATE) break;
    }
  }
  L.push(cl.slice(0, n)); R.push(cr.slice(0, n));

  self.postMessage({ t: 'progress', f: 1 } satisfies FromExport);
  const frames = L.reduce((s, c) => s + c.length, 0);
  const data: BlobPart[] = format === 'mp3' ? mp3(L, R, SAMPLE_RATE) : [wav(L, R, frames, SAMPLE_RATE)];
  self.postMessage({ t: 'done', data, type: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', ext: format } satisfies FromExport);
};
