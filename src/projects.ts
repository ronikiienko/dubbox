// The projects screen: every song in the library, newest first. Click one to open it; rename, copy,
// export, duplicate or delete it in its row. ⌘V (or PASTE) imports a copied project.

import { copy, currentMeta, duplicate, exportAll, exportFile, importText, list, remove, rename, type ProjectMeta } from './library';

export interface ProjectsHost {
  open(id: string): Promise<void>; // switch the app to this project
  create(): Promise<void>; // a new empty project, opened
  renamed(): void; // the open project's name changed
}

let overlay: HTMLElement | null = null;
export const projectsOpen = () => !!overlay;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function button(label: string, title: string, onClick: () => void) {
  const b = h('button', 'btn small', label);
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // not a click on the row
    onClick();
  });
  return b;
}

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 300 * 86400 ? 'numeric' : undefined });
}

function length(m: ProjectMeta): string {
  if (!m.bars) return 'empty';
  const sec = Math.round((m.bars * 4 * 60) / m.tempo);
  return `${m.tempo} bpm · ${m.bars} bars · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const MAP_W = 180, ROW = 3; // overview: one 2 px line per track
const SHADES = ['', '#4a3a22', '#8a6530', '#e8a33d'];

/** Where the notes are: tracks top to bottom, bars left to right (at least 32 bars wide, so sketches stay short). */
function overview(m: ProjectMeta): HTMLCanvasElement {
  const c = h('canvas', 'map');
  const dpr = devicePixelRatio || 1;
  const H = m.map.length * ROW;
  c.width = MAP_W * dpr;
  c.height = H * dpr;
  c.style.width = `${MAP_W}px`;
  c.style.height = `${H}px`;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = '#1f1e1b';
  for (let t = 0; t < m.map.length; t++) g.fillRect(0, t * ROW, MAP_W, ROW - 1);
  const bw = MAP_W / Math.max(32, m.bars);
  m.map.forEach((row, t) => {
    for (let b = 0; b < row.length; b++) {
      const v = +row[b];
      if (!v) continue;
      g.fillStyle = SHADES[v];
      g.fillRect(b * bw, t * ROW, Math.max(1, bw - (bw > 3 ? 1 : 0)), ROW - 1);
    }
  });
  return c;
}

export function showProjects(host: ProjectsHost) {
  if (overlay) return;
  const root = h('div', 'projects-back');
  const panel = h('div', 'projects');
  root.append(panel);
  overlay = root;
  document.body.append(root);

  const status = h('div', 'projects-status');
  const say = (text: string, undo?: () => Promise<void>) => {
    status.replaceChildren(text);
    if (undo) status.append(' ', button('UNDO', 'bring it back', async () => {
      await undo();
      say('restored');
      render();
    }));
  };

  const close = () => {
    root.remove();
    overlay = null;
    removeEventListener('keydown', onKey, true);
    removeEventListener('paste', onPaste);
  };

  async function importAndShow(text: string, name: string) {
    try {
      const added = await importText(text, name);
      say(added.length === 1 ? `imported “${added[0].name}”` : `imported ${added.length} projects`);
      render();
    } catch (e) {
      say((e as Error).message);
    }
  }

  const file = h('input');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.multiple = true;
  file.hidden = true;
  file.addEventListener('change', async () => {
    for (const f of file.files ?? []) await importAndShow(await f.text(), f.name.replace(/\.json$/i, ''));
    file.value = '';
  });

  const top = h('div', 'projects-top');
  top.append(
    h('div', 'projects-title', 'PROJECTS'),
    button('NEW', 'start a new empty project', async () => {
      await host.create();
      close();
    }),
    button('PASTE', 'import a project you copied (or press ⌘V)', async () => {
      try {
        await importAndShow(await navigator.clipboard.readText(), 'Pasted');
      } catch {
        say('the browser didn’t allow reading the clipboard: press ⌘V instead');
      }
    }),
    button('IMPORT FILE', 'import a .json project, or an EXPORT ALL backup', () => file.click()),
    button('EXPORT ALL', 'download every project as one file: a backup, or to move them to another browser', () => void exportAll()),
    h('div', 'spacer'),
    button('✕', 'close (Esc)', close),
    file,
  );
  const rows = h('div', 'projects-list');
  const foot = h('div', 'projects-foot', 'Projects are kept in this browser. Use EXPORT ALL now and then for a backup, since clearing the browser’s site data deletes them.');
  panel.append(top, rows, status, foot);

  async function render() {
    const metas = await list();
    const cur = currentMeta().id;
    rows.replaceChildren(
      ...metas.map((m) => {
        const row = h('div', 'project' + (m.id === cur ? ' open' : ''));
        row.title = m.id === cur ? 'open now' : 'click to open';
        const name = h('input', 'project-name');
        name.value = m.name;
        name.spellcheck = false;
        name.title = 'rename';
        name.addEventListener('click', (e) => e.stopPropagation());
        name.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') name.blur();
          if (e.key === 'Escape') {
            name.value = m.name;
            name.blur();
            e.stopPropagation();
          }
        });
        name.addEventListener('change', async () => {
          m = await rename(m, name.value);
          name.value = m.name;
          if (m.id === currentMeta().id) host.renamed();
        });
        const info = h('div', 'project-info');
        info.append(h('div', '', length(m)), h('div', 'dim', ago(m.modified)));
        const acts = h('div', 'project-acts');
        acts.append(
          button('COPY', 'copy to the clipboard: paste it into a chat, then ⌘V in PROJECTS to import', async () => {
            try {
              await copy(m);
              say(`copied “${m.name}”`);
            } catch {
              say('the browser didn’t allow copying');
            }
          }),
          button('FILE', 'download as a .json file', () => void exportFile(m)),
          button('DUP', 'duplicate', async () => {
            const d = await duplicate(m);
            say(`made “${d.name}”`);
            render();
          }),
          button('DEL', 'delete (undo right after)', async () => {
            const undo = await remove(m);
            say(`deleted “${m.name}”`, undo);
            // the open project went: open the next newest, or start a new one
            if (m.id === currentMeta().id) {
              const rest = await list();
              await (rest.length ? host.open(rest[0].id) : host.create());
            }
            render();
          }),
        );
        row.append(name, overview(m), info, acts);
        row.addEventListener('click', async () => {
          if (m.id !== currentMeta().id) await host.open(m.id);
          close();
        });
        return row;
      }),
    );
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return; // typing a name: the app ignores inputs anyway
    // the app's shortcuts are off while this is open (⌘V still pastes, see onPaste)
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (!((e.metaKey || e.ctrlKey) && e.code === 'KeyV')) e.preventDefault();
  }

  function onPaste(e: ClipboardEvent) {
    if (e.target instanceof HTMLInputElement) return; // pasting into a name
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    void importAndShow(text, 'Pasted');
  }

  root.addEventListener('click', (e) => e.target === root && close());
  addEventListener('keydown', onKey, true);
  addEventListener('paste', onPaste);
  void render();
}
