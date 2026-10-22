import { DEFAULT_SCALE, GLOBAL, PARAMS, PARAM_BY_ID, SCALES, TRACKS, lockIds, pitchRange, snap, toIndex } from './params';

export const STEPS_PER_BAR = 16;
export const SONG_BARS = 300; // 10 min at 120 bpm
export const SONG_STEPS = SONG_BARS * STEPS_PER_BAR; // 4800

export type StepState = 0 | 1; // off / on

/** One lane of the song. Dense typed arrays: index = 16th step from song start. */
export interface TrackState {
  s: Uint8Array; // StepState per step
  note: Int8Array; // synths: scale steps from Root (7 per octave); drums: semitones of tune/tone
  slide: Uint8Array; // 1 = glide into the next step (synths)
  locks: Record<string, Uint8Array>; // per lockable param: detent index per step, NO_LOCK = use the knob
  mute: boolean;
  solo: boolean;
}

/** A track sounds if it isn't muted and, when anything is soloed, it is soloed too. */
export function audible(tracks: TrackState[], i: number): boolean {
  return !tracks[i].mute && (tracks[i].solo || !tracks.some((t) => t.solo));
}

export const NO_LOCK = 255;

export interface Project {
  version: 4;
  params: Record<string, number>; // normalized base values
  tracks: TrackState[];
}

const KEY = 'dubbox.project';

// ---- empty project ------------------------------------------------------

function emptyTrack(i: number): TrackState {
  return {
    s: new Uint8Array(SONG_STEPS).fill(TRACKS[i].global ? 1 : 0), // GLOBAL: every step is always on
    note: new Int8Array(SONG_STEPS),
    slide: new Uint8Array(SONG_STEPS),
    locks: Object.fromEntries(lockIds(i).map((id) => [id, new Uint8Array(SONG_STEPS).fill(NO_LOCK)])),
    mute: false,
    solo: false,
  };
}

export function emptyProject(): Project {
  return {
    version: 4,
    params: Object.fromEntries(PARAMS.map((d) => [d.id, d.defN])),
    tracks: TRACKS.map((_, i) => emptyTrack(i)),
  };
}

// ---- serialization ------------------------------------------------------
// On disk tracks are sparse: only the hits, as [step, state, note, slide?], and locks as [step, index].

type Hit = [number, number, number, number?];

interface SavedTrack {
  hits: Hit[];
  locks?: Record<string, [number, number][]>;
  mute: boolean;
  solo?: boolean;
}

interface SavedProject {
  version: 4;
  params: Record<string, number>;
  tracks: SavedTrack[];
}

function serialize(p: Project): SavedProject {
  return {
    version: 4,
    params: p.params,
    tracks: p.tracks.map((tr, ti) => {
      const hits: Hit[] = [];
      if (tr !== p.tracks[GLOBAL]) for (let i = 0; i < SONG_STEPS; i++) if (tr.s[i]) hits.push(tr.slide[i] ? [i, tr.s[i], tr.note[i], 1] : [i, tr.s[i], tr.note[i]]);
      const locks: Record<string, [number, number][]> = {};
      for (const [id, arr] of Object.entries(tr.locks)) {
        const l: [number, number][] = [];
        // notes: a default value isn't stored (it plays the same as unset); GLOBAL: a set value is a change
        const def = TRACKS[ti].global ? NO_LOCK : toIndex(PARAM_BY_ID[id], PARAM_BY_ID[id].defN);
        for (let i = 0; i < SONG_STEPS; i++) if (arr[i] !== NO_LOCK && arr[i] !== def) l.push([i, arr[i]]);
        if (l.length) locks[id] = l;
      }
      return { hits, locks, mute: tr.mute, solo: tr.solo };
    }),
  };
}

// v1 = one 16-step loop per track with its own length.
interface V1Track {
  steps: { s: number; note: number }[];
  length: number;
  mute: boolean;
  ph: boolean;
}

/** Accept v2 files and v1 loops (tiled across the whole song). Unknown fields are dropped. */
function deserialize(raw: { version?: number; params?: Record<string, number>; tracks?: unknown[] }): Project {
  const p = emptyProject();
  // the voice lowpass was called Cutoff (synths), then Tone; now LP
  // before v4 there was no SNARE (index 3): tracks from BASS on, and their mixer ids, move up one
  const old = (raw.version ?? 1) < 4;
  const rename = (id: string) =>
    id
      .replace(/^(kick|hat|perc|bass|chord)\.(cutoff|tone)$/, '$1.lp')
      .replace(/^mix\.(\d+)\./, (m, k) => (old && +k >= 3 ? `mix.${+k + 1}.` : m));
  const rawTracks = old && raw.tracks ? [...raw.tracks.slice(0, 3), null, ...raw.tracks.slice(3)] : raw.tracks;
  for (const [id, v] of Object.entries(raw.params ?? {})) p.params[rename(id)] = v;
  // knobs are stepped: snap values saved before that (or hand-edited) onto a detent
  for (const id in p.params) {
    if (PARAM_BY_ID[id]) p.params[id] = snap(PARAM_BY_ID[id], p.params[id]);
    else delete p.params[id];
  }
  rawTracks?.slice(0, TRACKS.length).forEach((rt, i) => {
    const tr = p.tracks[i];
    if (rt && typeof rt === 'object' && 'hits' in rt) {
      const st = rt as SavedTrack;
      if (TRACKS[i].global) for (const [id, l] of Object.entries(st.locks ?? {})) {
        const arr = tr.locks[id];
        if (arr) for (const [si, idx] of l) if (si >= 0 && si < SONG_STEPS) arr[si] = Math.min(idx, PARAM_BY_ID[id].positions - 1);
      }
      if (TRACKS[i].global) return;
      for (const [si, s, note, slide] of st.hits) {
        if (si < 0 || si >= SONG_STEPS) continue;
        tr.s[si] = s ? 1 : 0; // accents (2) were removed
        tr.note[si] = note;
        tr.slide[si] = slide ? 1 : 0;
      }
      for (const [oldId, l] of Object.entries(st.locks ?? {})) {
        // v3 had Scale on CHORD notes: it now lives on GLOBAL
        if (oldId === 'chord.scale') {
          for (const [si, idx] of l) if (si >= 0 && si < SONG_STEPS) p.tracks[GLOBAL].locks.scale[si] = idx;
          continue;
        }
        const id = rename(oldId);
        const arr = tr.locks[id];
        if (!arr) continue;
        const max = PARAM_BY_ID[id].positions - 1;
        for (const [si, idx] of l) if (si >= 0 && si < SONG_STEPS) arr[si] = Math.min(idx, max);
      }
      tr.mute = !!st.mute;
      tr.solo = !!st.solo;
    } else if (rt && typeof rt === 'object' && 'steps' in rt) {
      const v1 = rt as V1Track;
      const len = v1.length || STEPS_PER_BAR;
      for (let si = 0; si < SONG_STEPS; si++) {
        const step = v1.steps[si % len];
        tr.s[si] = step?.s ? 1 : 0;
        tr.note[si] = step?.note ?? 0;
      }
      tr.mute = !!v1.mute;
    }
  });
  // Before v3 synth pitch was semitones: move each note to the nearest minor-scale step (lower on a tie).
  if ((raw.version ?? 1) < 3) {
    const minor = SCALES[DEFAULT_SCALE][1];
    p.tracks.forEach((tr, i) => {
      if (!TRACKS[i].slide) return;
      const r = pitchRange(i);
      for (let si = 0; si < SONG_STEPS; si++) {
        const st = tr.note[si];
        if (!st) continue;
        const o = Math.floor(st / 12);
        const pc = st - 12 * o;
        let best = 0;
        for (let d = 1; d < 8; d++) if (Math.abs((d < 7 ? minor[d] : 12) - pc) < Math.abs((best < 7 ? minor[best] : 12) - pc)) best = d;
        tr.note[si] = Math.max(-r, Math.min(r, 7 * o + best));
      }
    });
  }
  // Track strips have no knobs any more: bake old knob settings into the notes that used them.
  // Global knobs are gone too: a non-default old setting becomes GLOBAL's value at the first step.
  for (const id of lockIds(GLOBAL)) {
    const d = PARAM_BY_ID[id];
    const arr = p.tracks[GLOBAL].locks[id];
    if (p.params[id] !== d.defN && arr[0] === NO_LOCK) arr[0] = toIndex(d, p.params[id]);
    p.params[id] = d.defN;
  }
  p.tracks.forEach((tr, i) => {
    if (TRACKS[i].global) return;
    for (const id of lockIds(i)) {
      const d = PARAM_BY_ID[id];
      if (p.params[id] === d.defN) continue;
      const idx = toIndex(d, p.params[id]);
      const arr = tr.locks[id];
      for (let si = 0; si < SONG_STEPS; si++) if (tr.s[si] && arr[si] === NO_LOCK) arr[si] = idx;
      p.params[id] = d.defN;
    }
  });
  return p;
}

// ---- persistence --------------------------------------------------------

export function load(): Project {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return deserialize(JSON.parse(raw));
  } catch {
    /* fall through to an empty project */
  }
  return emptyProject();
}

let saveTimer = 0;
export function scheduleSave(p: Project) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => localStorage.setItem(KEY, JSON.stringify(serialize(p))), 500);
}

export function exportProject(p: Project) {
  const blob = new Blob([JSON.stringify(serialize(p))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dubbox-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importProject(file: File): Promise<Project> {
  return deserialize(JSON.parse(await file.text()));
}
