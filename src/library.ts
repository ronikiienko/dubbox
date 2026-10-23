// The project library: which project is open, autosaving into it, and moving projects in and out
// (files, the clipboard, the export-all bundle). Where they're kept is store.ts.

import { GLOBAL, PARAM_BY_ID, fromIndex, snap, toReal } from './params';
import { NO_LOCK, SONG_STEPS, STEPS_PER_BAR, emptyProject, fromSaved, fromText, toText, type Project } from './state';
import { store, type ProjectMeta } from './store';
import { download } from './wav';

export type { ProjectMeta };

const CURRENT = 'dubbox.current'; // id of the open project
const OLD_KEY = 'dubbox.project'; // before the library there was one autosaved song here
export const UNTITLED = 'Untitled';

let current: ProjectMeta = { id: '', name: UNTITLED, modified: 0, tempo: 0, bars: 0, map: [] };
export const currentMeta = () => current;

/** List-view facts about a song: tempo at bar 1, length up to the last note, how busy each track is per bar. */
export function summarize(p: Project): Pick<ProjectMeta, 'tempo' | 'bars' | 'map'> {
  const d = PARAM_BY_ID.tempo;
  const t0 = p.tracks[GLOBAL].locks.tempo[0];
  const tempo = Math.round(toReal(d, t0 === NO_LOCK ? snap(d, p.params.tempo) : fromIndex(d, t0)));
  const counts = p.tracks.slice(0, GLOBAL).map((tr) => {
    const c = new Array<number>(SONG_STEPS / STEPS_PER_BAR).fill(0);
    for (let k = 0; k < SONG_STEPS; k++) if (tr.s[k]) c[(k / STEPS_PER_BAR) | 0]++;
    return c;
  });
  let bars = 0;
  for (const c of counts) for (let b = c.length - 1; b >= bars; b--) if (c[b]) { bars = b + 1; break; }
  const map = counts.map((c) => c.slice(0, bars).map((n) => (n === 0 ? 0 : n < 3 ? 1 : n < 7 ? 2 : 3)).join(''));
  return { tempo, bars, map };
}

export const newestFirst = (metas: ProjectMeta[]) => metas.sort((a, b) => b.modified - a.modified);

// ---- autosave -------------------------------------------------------------

let pending: Project | null = null;
let timer = 0;

/** Save the open project half a second after the last change. */
export function scheduleSave(p: Project) {
  pending = p;
  clearTimeout(timer);
  timer = window.setTimeout(flush, 500);
}

/** Write a pending save now. */
export async function flush() {
  clearTimeout(timer);
  const p = pending;
  pending = null;
  if (!p || !current.id) return;
  Object.assign(current, summarize(p), { modified: Date.now() });
  await store.write({ ...current }, toText(p));
}

// leaving or hiding the page: don't wait for the timer
addEventListener('visibilitychange', () => void (document.visibilityState === 'hidden' && flush()));
addEventListener('pagehide', () => void flush());

// ---- library ----------------------------------------------------------------

function uniqueName(base: string, metas: ProjectMeta[]) {
  const names = new Set(metas.map((m) => m.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Add a song to the library (its name made unique). */
export async function add(name: string, p: Project, modified = Date.now(), draft = false): Promise<ProjectMeta> {
  const meta: ProjectMeta = { id: crypto.randomUUID(), name: uniqueName(name.trim() || UNTITLED, await store.list()), modified, ...summarize(p) };
  if (draft) meta.draft = true;
  await store.write(meta, toText(p));
  return meta;
}

/** Make `id` the open project and return its song. Leaving an empty project deletes it: nothing to keep. */
export async function open(id: string): Promise<Project> {
  await flush();
  if (current.id && current.id !== id && current.bars === 0) await store.remove(current.id);
  const [meta, text] = await Promise.all([store.list().then((l) => l.find((m) => m.id === id)), store.read(id)]);
  if (!meta || text === undefined) throw new Error(`no project ${id}`);
  current = meta;
  localStorage.setItem(CURRENT, id);
  return fromText(text);
}

/** At startup: the project open last time, else the newest. First run: the old autosave (or an empty song) becomes the first project. */
export async function openInitial(): Promise<Project> {
  let metas = await store.list();
  if (!metas.length) {
    const old = localStorage.getItem(OLD_KEY);
    let p = emptyProject();
    try {
      if (old) p = fromText(old);
    } catch {
      /* unreadable: start empty */
    }
    metas = [await add(old ? 'My song' : UNTITLED, p)];
    if (old) {
      // kept as a spare copy until we're sure nobody lost a song in the move
      localStorage.setItem(`${OLD_KEY}.backup`, old);
      localStorage.removeItem(OLD_KEY);
    }
  }
  const last = metas.find((m) => m.id === localStorage.getItem(CURRENT)) ?? newestFirst(metas)[0];
  // empty songs left over from earlier sessions go
  for (const m of metas) if (m.bars === 0 && m.id !== last.id) await store.remove(m.id);
  return open(last.id);
}

/** Leaving the open project: does it need asking about? (a draft with notes in it) */
export async function needsKeepOrDiscard(): Promise<boolean> {
  await flush();
  return !!current.id && !!current.draft && current.bars > 0;
}

export const discardCurrent = () => remove(current);

export async function list(): Promise<ProjectMeta[]> {
  await flush(); // so the open project's row is up to date
  return newestFirst(await store.list());
}

export async function rename(meta: ProjectMeta, name: string): Promise<ProjectMeta> {
  const others = (await store.list()).filter((m) => m.id !== meta.id);
  // naming a draft keeps it
  const next = { ...meta, name: uniqueName(name.trim() || UNTITLED, others) };
  delete next.draft;
  await store.rename(next);
  if (meta.id === current.id) {
    current.name = next.name;
    delete current.draft;
  }
  return next;
}

export async function duplicate(meta: ProjectMeta): Promise<ProjectMeta> {
  return add(`${meta.name} copy`, await song(meta));
}

/** Delete; returns what's needed to undo it. */
export async function remove(meta: ProjectMeta): Promise<() => Promise<void>> {
  if (meta.id === current.id) await flush();
  const text = await store.read(meta.id);
  await store.remove(meta.id);
  if (meta.id === current.id) current = { ...current, id: '' }; // gone: nothing to save or ask about
  return () => (text === undefined ? Promise.resolve() : store.write(meta, text));
}

async function song(meta: ProjectMeta): Promise<Project> {
  if (meta.id === current.id) await flush();
  return fromText((await store.read(meta.id)) ?? '{}');
}

// ---- moving projects in and out ---------------------------------------------
// A shared project is the stored JSON with its name inside; EXPORT ALL wraps several in a bundle.

async function shareText(meta: ProjectMeta): Promise<string> {
  if (meta.id === current.id) await flush();
  const text = (await store.read(meta.id)) ?? '{}';
  return `{"name":${JSON.stringify(meta.name)},${text.slice(1)}`;
}

const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'dubbox';

export async function exportFile(meta: ProjectMeta) {
  download(await shareText(meta), 'application/json', 'json', fileName(meta.name));
}

/** Copy to the clipboard. The text is handed over as a promise so Safari still counts the click. */
export async function copy(meta: ProjectMeta) {
  const text = shareText(meta);
  if (typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}

export async function exportAll() {
  const metas = await list();
  const items = await Promise.all(
    metas.map(async (m) => `{"name":${JSON.stringify(m.name)},"modified":${m.modified},"project":${(await store.read(m.id)) ?? '{}'}}`),
  );
  download(`{"dubbox":"library","projects":[\n${items.join(',\n')}\n]}`, 'application/json', 'json', `dubbox-library-${new Date().toISOString().slice(0, 10)}`);
}

/** Import pasted or loaded text: one project, or an EXPORT ALL bundle. Returns the new projects. */
export async function importText(text: string, fallbackName: string): Promise<ProjectMeta[]> {
  let raw: { dubbox?: string; projects?: { name?: unknown; modified?: unknown; project?: unknown }[]; name?: unknown; tracks?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('that isn\'t a DUBBOX project');
  }
  const isSong = (x: unknown): x is Parameters<typeof fromSaved>[0] => !!x && typeof x === 'object' && Array.isArray((x as { tracks?: unknown }).tracks);
  const name = (x: unknown) => (typeof x === 'string' ? x : fallbackName);
  if (raw?.dubbox === 'library' && Array.isArray(raw.projects)) {
    const added: ProjectMeta[] = [];
    for (const it of raw.projects) {
      if (isSong(it.project)) added.push(await add(name(it.name), fromSaved(it.project), typeof it.modified === 'number' ? it.modified : Date.now()));
    }
    return added;
  }
  const songName = name(raw?.name);
  if (!isSong(raw)) throw new Error('that isn\'t a DUBBOX project');
  return [await add(songName, fromSaved(raw))];
}
