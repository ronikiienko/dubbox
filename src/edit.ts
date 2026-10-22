// Region edits on the song (copy / cut / paste / duplicate) and undo snapshots.
// Pure operations on Project; the UI owns selection, keys and engine sync.

import { TRACKS, lockIds } from './params';
import { NO_LOCK, SONG_STEPS, type Project, type TrackState } from './state';

/** Tracks t0..t1 (inclusive) × steps s0..s1 (exclusive). */
export interface Region {
  t0: number;
  t1: number;
  s0: number;
  s1: number;
}

interface ClipTrack {
  src: number; // track it was copied from
  s: Uint8Array;
  note: Int8Array;
  slide: Uint8Array;
  locks: Record<string, Uint8Array>;
}

export interface Clip {
  len: number;
  tracks: ClipTrack[];
  allTracks: boolean; // copied from the ruler: always pastes onto the same tracks
}

export function copy(p: Project, r: Region): Clip {
  const tracks: ClipTrack[] = [];
  for (let ti = r.t0; ti <= r.t1; ti++) {
    const tr = p.tracks[ti];
    tracks.push({
      src: ti,
      s: tr.s.slice(r.s0, r.s1),
      note: tr.note.slice(r.s0, r.s1),
      slide: tr.slide.slice(r.s0, r.s1),
      locks: Object.fromEntries(Object.entries(tr.locks).map(([id, a]) => [id, a.slice(r.s0, r.s1)])),
    });
  }
  return { len: r.s1 - r.s0, tracks, allTracks: r.t0 === 0 && r.t1 === TRACKS.length - 1 };
}

export function clear(p: Project, r: Region) {
  for (let ti = r.t0; ti <= r.t1; ti++) {
    const tr = p.tracks[ti];
    tr.s.fill(0, r.s0, r.s1);
    tr.note.fill(0, r.s0, r.s1);
    tr.slide.fill(0, r.s0, r.s1);
    for (const a of Object.values(tr.locks)) a.fill(NO_LOCK, r.s0, r.s1);
  }
}

/** Values carry across tracks by name (tone → tone, dly → dly…), as knob positions. */
function mapLockId(id: string, src: number, dst: number): string | null {
  if (src === dst) return id;
  const name = id.slice(id.lastIndexOf('.') + 1);
  return lockIds(dst).find((x) => x.endsWith('.' + name)) ?? null;
}

/** Overwrite the area at (t0, s0) with the clip. Returns the region actually written. */
export function paste(p: Project, clip: Clip, t0: number, s0: number): Region {
  const len = Math.min(clip.len, SONG_STEPS - s0);
  let t1 = t0;
  clip.tracks.forEach((ct, k) => {
    const ti = t0 + k;
    if (ti >= TRACKS.length) return;
    t1 = ti;
    const tr = p.tracks[ti];
    tr.s.set(ct.s.subarray(0, len), s0);
    tr.note.set(ct.note.subarray(0, len), s0);
    // only synth tracks can slide
    if (TRACKS[ti].slide) tr.slide.set(ct.slide.subarray(0, len), s0);
    else tr.slide.fill(0, s0, s0 + len);
    for (const id of lockIds(ti)) tr.locks[id].fill(NO_LOCK, s0, s0 + len);
    for (const [id, a] of Object.entries(ct.locks)) {
      const dst = mapLockId(id, ct.src, ti);
      if (dst && tr.locks[dst]) tr.locks[dst].set(a.subarray(0, len), s0);
    }
  });
  return { t0, t1, s0, s1: s0 + len };
}

// ---- undo -----------------------------------------------------------------

export type Snapshot = Pick<TrackState, 's' | 'note' | 'slide' | 'locks'>[];

export function snapshot(p: Project): Snapshot {
  return p.tracks.map((tr) => ({
    s: tr.s.slice(),
    note: tr.note.slice(),
    slide: tr.slide.slice(),
    locks: Object.fromEntries(Object.entries(tr.locks).map(([id, a]) => [id, a.slice()])),
  }));
}

export function restore(p: Project, snap: Snapshot) {
  snap.forEach((st, i) => Object.assign(p.tracks[i], st));
}
