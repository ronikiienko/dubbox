import { PARAMS, PARAM_BY_ID, TRACKS, lockIds, snap, toIndex } from './params';

export const STEPS_PER_BAR = 16;
export const SONG_BARS = 300; // 10 min at 120 bpm
export const SONG_STEPS = SONG_BARS * STEPS_PER_BAR; // 4800

export type StepState = 0 | 1; // off / on

/** One lane of the song. Dense typed arrays: index = 16th step from song start. */
export interface TrackState {
  s: Uint8Array; // StepState per step
  note: Int8Array; // semitones: synths relative to root, drums shift tune/tone
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
  version: 2;
  params: Record<string, number>; // normalized base values
  tracks: TrackState[];
}

const KEY = 'dubbox.project';

// ---- empty project ------------------------------------------------------

function emptyTrack(i: number): TrackState {
  return {
    s: new Uint8Array(SONG_STEPS),
    note: new Int8Array(SONG_STEPS),
    slide: new Uint8Array(SONG_STEPS),
    locks: Object.fromEntries(lockIds(i).map((id) => [id, new Uint8Array(SONG_STEPS).fill(NO_LOCK)])),
    mute: false,
    solo: false,
  };
}

export function emptyProject(): Project {
  return {
    version: 2,
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
  version: 2;
  params: Record<string, number>;
  tracks: SavedTrack[];
}

function serialize(p: Project): SavedProject {
  return {
    version: 2,
    params: p.params,
    tracks: p.tracks.map((tr) => {
      const hits: Hit[] = [];
      for (let i = 0; i < SONG_STEPS; i++) if (tr.s[i]) hits.push(tr.slide[i] ? [i, tr.s[i], tr.note[i], 1] : [i, tr.s[i], tr.note[i]]);
      const locks: Record<string, [number, number][]> = {};
      for (const [id, arr] of Object.entries(tr.locks)) {
        const l: [number, number][] = [];
        for (let i = 0; i < SONG_STEPS; i++) if (arr[i] !== NO_LOCK) l.push([i, arr[i]]);
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
function deserialize(raw: { params?: Record<string, number>; tracks?: unknown[] }): Project {
  const p = emptyProject();
  // synth Cutoff was renamed Tone (every voice now shares Tone/Res/Decay)
  const rename = (id: string) => id.replace(/^(bass|chord)\.cutoff$/, '$1.tone');
  for (const [id, v] of Object.entries(raw.params ?? {})) p.params[rename(id)] = v;
  // knobs are stepped: snap values saved before that (or hand-edited) onto a detent
  for (const id in p.params) {
    if (PARAM_BY_ID[id]) p.params[id] = snap(PARAM_BY_ID[id], p.params[id]);
    else delete p.params[id];
  }
  raw.tracks?.slice(0, TRACKS.length).forEach((rt, i) => {
    const tr = p.tracks[i];
    if (rt && typeof rt === 'object' && 'hits' in rt) {
      const st = rt as SavedTrack;
      for (const [si, s, note, slide] of st.hits) {
        if (si < 0 || si >= SONG_STEPS) continue;
        tr.s[si] = s ? 1 : 0; // accents (2) were removed
        tr.note[si] = note;
        tr.slide[si] = slide ? 1 : 0;
      }
      for (const [oldId, l] of Object.entries(st.locks ?? {})) {
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
  // Track strips have no knobs any more: bake old knob settings into the notes that used them.
  p.tracks.forEach((tr, i) => {
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
