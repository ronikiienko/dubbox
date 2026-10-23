// Region edits on the song (copy / cut / paste / duplicate) and undo snapshots.
// Pure operations on Project; the UI owns selection, keys and engine sync.
//
// Held rows (GLOBAL, and each track's echo time/feedback lanes) aren't the notes': a box of notes
// (⇧-drag) leaves them alone. A section (ruler: whole bars, every track) carries them, and keeps the
// song around it as it was: the copy starts with the values in force where it came from, and after
// it the values in force there before carry on.

import { PARAM_BY_ID, TRACKS, isLane, lockIds, pitchRange, toIndex } from './params';
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
  locks: Record<string, Uint8Array>; // a section's lanes included; a box's not
  laneStart: Record<string, number>; // section: each lane's value in force at its first step
}

/** A section: whole-song slice across every track (from the ruler). */
const isSection = (r: { t0: number; t1: number }) => r.t0 === 0 && r.t1 === TRACKS.length - 1;

/** A held row's value in force at step k: the latest set at or before k, else the default. */
function heldAt(p: Project, ti: number, id: string, k: number): number {
  const arr = p.tracks[ti].locks[id];
  for (let j = Math.min(k, SONG_STEPS - 1); j >= 0; j--) if (arr[j] !== NO_LOCK) return arr[j];
  return toIndex(PARAM_BY_ID[id], p.params[id]);
}

/** Held rows store only changes: drop values that repeat the one in force. */
export function onlyChanges(p: Project, ti: number, id: string) {
  const arr = p.tracks[ti].locks[id];
  let held = toIndex(PARAM_BY_ID[id], p.params[id]);
  for (let k = 0; k < SONG_STEPS; k++) {
    if (arr[k] === NO_LOCK) continue;
    if (arr[k] === held) arr[k] = NO_LOCK;
    else held = arr[k];
  }
}

/** After rewriting steps s0..s1 of a section: the steps after it keep the values they had (`after`). */
function keepAfter(p: Project, ti: number, id: string, s1: number, after: number) {
  const arr = p.tracks[ti].locks[id];
  if (s1 < SONG_STEPS && arr[s1] === NO_LOCK) arr[s1] = after;
  onlyChanges(p, ti, id);
}

export interface Clip {
  len: number;
  tracks: ClipTrack[];
  allTracks: boolean; // copied from the ruler: always pastes onto the same tracks
}

export function copy(p: Project, r: Region): Clip {
  const section = isSection(r);
  const tracks: ClipTrack[] = [];
  for (let ti = r.t0; ti <= r.t1; ti++) {
    const tr = p.tracks[ti];
    const ids = Object.keys(tr.locks).filter((id) => section || !isLane(ti, id));
    tracks.push({
      src: ti,
      s: tr.s.slice(r.s0, r.s1),
      note: tr.note.slice(r.s0, r.s1),
      slide: tr.slide.slice(r.s0, r.s1),
      locks: Object.fromEntries(ids.map((id) => [id, tr.locks[id].slice(r.s0, r.s1)])),
      laneStart: section ? Object.fromEntries(ids.filter((id) => isLane(ti, id)).map((id) => [id, heldAt(p, ti, id, r.s0)])) : {},
    });
  }
  return { len: r.s1 - r.s0, tracks, allTracks: section };
}

export function clear(p: Project, r: Region) {
  const section = isSection(r);
  for (let ti = r.t0; ti <= r.t1; ti++) {
    const tr = p.tracks[ti];
    if (!TRACKS[ti].global) tr.s.fill(0, r.s0, r.s1); // GLOBAL has a value on every step
    tr.note.fill(0, r.s0, r.s1);
    tr.slide.fill(0, r.s0, r.s1);
    for (const [id, a] of Object.entries(tr.locks)) {
      if (!isLane(ti, id)) a.fill(NO_LOCK, r.s0, r.s1);
      else if (section) {
        const after = heldAt(p, ti, id, r.s1 - 1);
        a.fill(NO_LOCK, r.s0, r.s1);
        keepAfter(p, ti, id, r.s1, after);
      }
    }
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
    // GLOBAL values only paste onto GLOBAL, and notes never onto it
    if (!TRACKS[ti].global !== !TRACKS[ct.src].global) return;
    t1 = ti;
    const tr = p.tracks[ti];
    if (!TRACKS[ti].global) tr.s.set(ct.s.subarray(0, len), s0);
    // drums count semitones (±12), synths scale steps (±7)
    const r = pitchRange(ti);
    for (let i = 0; i < len; i++) tr.note[s0 + i] = Math.max(-r, Math.min(r, ct.note[i]));
    // only synth tracks can slide
    if (TRACKS[ti].slide) tr.slide.set(ct.slide.subarray(0, len), s0);
    else tr.slide.fill(0, s0, s0 + len);
    // the values the steps after a section have now, before it's written over
    const after: Record<string, number> = {};
    for (const id of lockIds(ti)) {
      if (isLane(ti, id)) {
        if (!clip.allTracks) continue; // a box of notes leaves held rows alone
        after[id] = heldAt(p, ti, id, s0 + len - 1);
      }
      tr.locks[id].fill(NO_LOCK, s0, s0 + len);
    }
    for (const [id, a] of Object.entries(ct.locks)) {
      const dst = mapLockId(id, ct.src, ti);
      if (dst && tr.locks[dst]) tr.locks[dst].set(a.subarray(0, len), s0);
    }
    // a section starts with the values it had where it came from, and the song after it carries on
    for (const [id, v] of Object.entries(ct.laneStart)) {
      const arr = tr.locks[id];
      if (!arr) continue;
      if (arr[s0] === NO_LOCK) arr[s0] = v;
      keepAfter(p, ti, id, s0 + len, after[id]);
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
