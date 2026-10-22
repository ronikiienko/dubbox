import { GLOBAL, PARAM_BY_ID, TRACKS, describe, pitchRange, fromIndex, lockIds, toIndex, toReal } from './params';
import {
  SONG_STEPS, STEPS_PER_BAR,
  type Project, type StepState, NO_LOCK, audible,
  exportProject, emptyProject, importProject, scheduleSave,
} from './state';
import { onEngine, send, startEngine } from './engine/bridge';
import { Recorder } from './wav';
import { type Clip, type Region, type Snapshot, clear, copy, paste, restore, snapshot } from './edit';

// ---- helpers ------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

const HELP: [string, string][] = [
  ['space', 'play / stop'],
  ['F', 'follow playhead'],
  ['1–6 / ⇧1–6', 'mute / solo'],
  ['hold Q W E R T Y', 'dub throw'],
  ['click step', 'on / off'],
  ['drag sideways', 'paint steps'],
  ['drag ↕ / wheel on step', 'pitch'],
  ['⌥-click step', 'slide (synths)'],
  ['click track name', 'per-note values (GLOBAL: tempo, FX…)'],
  ['drag in a value row', 'set · across = draw'],
  ['dbl-click value', 'unset'],
  ['click ruler', 'play from bar'],
  ['drag ruler / ⇧-drag', 'select bars / area'],
  ['⌘C ⌘X ⌘V', 'copy / cut / paste at mouse'],
  ['⌘D', 'duplicate'],
  ['delete', 'clear selection'],
  ['D', 'dice selection / hovered'],
  ['⌘Z / ⇧⌘Z', 'undo / redo'],
  ['wheel', 'scroll'],
];

const THROW_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY'];

// timeline geometry (px)
const CELL = 22;
const ROW_MIN = 28; // track lanes stretch between these to fill the screen
const ROW_MAX = 60;
const RULER_H = 20;
const SUB_MIN = 6; // value rows are compact (a heat strip) and stretch between these to fill the screen
const SUB_MAX = 14;
const HEAT_BELOW = 24;
const LABEL_COLS = 3; // rows shorter than this draw as heat, taller as bars
const HOT_H = 80; // the bar row under the mouse grows to this, for precise drawing
const HOT_PAD_TOP = 13; // room for the value numbers
const HOT_PAD_BOTTOM = 2;
const PANEL_BG = '#191816';
const COLORS = {
  bg: '#0b0a09',
  cell: '#141311', // recessed step
  beat: '#2a2722', // every 4th step, clearly lighter than the rest
  line: '#2c2a25',
  dim: '#6d675b',
  text: '#e6dfcc',
  accent: '#f0a032', // amber LED
  accentDim: '#6e4a1d',
  hit: '#ffd88a', // a step lighting up as the playhead passes
  playhead: '#ff6a2b',
};
const DISPLAY_FONT = "'DIN Condensed', 'Avenir Next Condensed', 'Arial Narrow', sans-serif";

// ---- UI -----------------------------------------------------------------

export function mountUI(root: HTMLElement, initial: Project) {
  let p = initial;

  // Transport mirror: the engine reports its phase ~30x/s, the UI extrapolates between reports.
  const t = { playing: false, phase: 0, enginePhase: 0, posAt: 0, rec: false, recStart: 0 };
  const recorder = new Recorder();
  const throws = new Set<number>();

  let heads: HTMLElement[] = [];
  let names: HTMLElement[] = [];
  let playBtn: HTMLButtonElement, recBtn: HTMLButtonElement, followBtn: HTMLButtonElement;
  let scroller: HTMLElement, canvas: HTMLCanvasElement;
  let startStep = 0; // where Play starts (set by clicking the ruler)
  let follow = true; // keep the playhead in view while playing
  let resizeObs: ResizeObserver | undefined;
  let help: HTMLElement, helpBtn: HTMLButtonElement;
  let helpOpen = false;
  let tracksEl: HTMLElement;
  let mainH = 52; // height of a track's main lane, fitted to the window
  let subH = 8; // height of a compact value row, fitted to the window
  let spacerEl: HTMLElement;
  type RowRef = { ti: number; sub: number } | null;
  let hot: RowRef = null; // the open value row, drawn tall for editing (opened by a click)
  let openedAt = 0; // when it opened: the double-click that may follow isn't an edit
  const rowAnim = new Map<string, number>(); // animated row heights
  let subLabels: HTMLElement[][] = [];

  // selection, clipboard, undo
  let sel: Region | null = null;
  let clip: Clip | null = null;
  let hover: { ti: number; si: number; sub: number } | null = null; // step (and bar row) under the mouse
  let modHeld = false; // ⌘/Ctrl down: show where a paste would land
  const undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let pending: Snapshot | null = null; // taken at gesture start, committed on its first real change

  // ---- timeline ---------------------------------------------------------
  // One canvas for all lanes, virtualized: only the visible steps are drawn.

  function setStep(ti: number, si: number, st: StepState, note: number, slide = st ? p.tracks[ti].slide[si] : 0) {
    const tr = p.tracks[ti];
    if (tr.s[si] === st && tr.note[si] === note && tr.slide[si] === slide) return;
    commitPending();
    if (st && !tr.s[si]) inheritLocks(ti, si);
    tr.s[si] = st;
    tr.note[si] = note;
    tr.slide[si] = slide;
    send({ t: 'step', i: ti, si, s: st, note, slide });
    // a removed note takes its locked values with it
    if (!st) for (const id of lockIds(ti)) setLock(ti, id, si, NO_LOCK);
    scheduleSave(p);
  }

  function flagsChanged(i: number) {
    const tr = p.tracks[i];
    send({ t: 'flags', i, mute: tr.mute, solo: tr.solo });
    p.tracks.forEach((_, j) => renderHead(j));
    scheduleSave(p);
  }

  function renderHead(ti: number) {
    const tr = p.tracks[ti];
    if (TRACKS[ti].global) return;
    heads[ti].classList.toggle('muted', !audible(p.tracks, ti));
    heads[ti].querySelector('.solo')!.classList.toggle('lit', tr.solo);
    heads[ti].querySelector('.mute')!.classList.toggle('lit', tr.mute);
  }

  // ---- undo + region edits ---------------------------------------------

  function pushUndo(snap: Snapshot) {
    undoStack.push(snap);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }

  function commitPending() {
    if (!pending) return;
    pushUndo(pending);
    pending = null;
  }

  /** After a bulk change: resend the whole song to the engine and save. */
  function bulkChanged() {
    send({ t: 'init', project: p });
    scheduleSave(p);
  }

  function undo(redo: boolean) {
    const from = redo ? redoStack : undoStack;
    const snap = from.pop();
    if (!snap) return;
    (redo ? undoStack : redoStack).push(snapshot(p));
    restore(p, snap);
    sel = null;
    bulkChanged();
  }

  /** Apply a region edit as one undo step. */
  function edit(fn: () => void) {
    pushUndo(snapshot(p));
    fn();
    bulkChanged();
  }

  function editKey(e: KeyboardEvent): boolean {
    switch (e.code) {
      case 'KeyZ':
        undo(e.shiftKey);
        return true;
      case 'KeyC':
        if (sel) clip = copy(p, sel);
        return !!sel;
      case 'KeyX':
        if (!sel) return false;
        clip = copy(p, sel);
        edit(() => clear(p, sel!));
        return true;
      case 'KeyV': {
        if (!clip) return false;
        const c = clip;
        const t0 = c.allTracks ? 0 : hover?.ti ?? sel?.t0 ?? 0;
        const s0 = hover?.si ?? sel?.s0 ?? startStep;
        edit(() => (sel = paste(p, c, t0, s0)));
        return true;
      }
      case 'KeyD': {
        // duplicate right after itself; the selection moves onto the copy so ⌘D keeps extending
        if (!sel) return false;
        const r0 = sel;
        edit(() => (sel = paste(p, copy(p, r0), r0.t0, r0.s1)));
        return true;
      }
    }
    return false;
  }

  /**
   * Dice: nudge every value of the selected notes (or the hovered note) by −1/0/+1 position.
   * Hovering a bar row limits it to that row. Repeated presses keep wandering; each is one undo step.
   */
  function dice() {
    const region: Region | null = sel ?? (hover ? { t0: hover.ti, t1: hover.ti, s0: hover.si, s1: hover.si + 1 } : null);
    if (!region) return;
    const onlyRow = hover && hover.sub >= 0 ? subRows(hover.ti)[hover.sub] : null;
    edit(() => {
      for (let ti = region.t0; ti <= region.t1; ti++) {
        const tr = p.tracks[ti];
        const ids = onlyRow ? lockIds(ti).filter((id) => id === onlyRow) : lockIds(ti);
        const single = region.s1 - region.s0 === 1;
        for (let si = region.s0; si < region.s1; si++) {
          if (!tr.s[si]) continue;
          for (const id of ids) {
            if (TRACKS[ti].global && !single && tr.locks[id][si] === NO_LOCK) continue;
            const d = PARAM_BY_ID[id];
            const step = Math.floor(Math.random() * 3) - 1;
            tr.locks[id][si] = clamp(toIndex(d, noteValue(ti, id, si)) + step, 0, d.positions - 1);
          }
        }
      }
    });
  }

  function setFollow(on: boolean) {
    follow = on;
    followBtn.classList.toggle('lit', on);
  }

  // ---- lane geometry ----------------------------------------------------
  // Each track has a main lane plus one compact row per per-note value, always visible.

  const subRows = (ti: number) => lockIds(ti);
  const isHot = (ti: number, j: number) => !!hot && hot.ti === ti && hot.sub === j;
  const rowH = (ti: number, j: number) => rowAnim.get(`${ti}:${j}`) ?? subH;
  const padTop = (ti: number, j: number) => (isHot(ti, j) ? HOT_PAD_TOP : 2);
  const padBottom = (ti: number, j: number) => (isHot(ti, j) ? HOT_PAD_BOTTOM : 2);
  /** Bar area of a row: [top y, height] in which 0..1 is drawn. */
  const barSpan = (ti: number, j: number) => rowH(ti, j) - padTop(ti, j) - padBottom(ti, j);
  const laneH = (ti: number) => subRows(ti).reduce((y, _, j) => y + rowH(ti, j), mainH);
  const laneTop = (ti: number) => {
    let y = RULER_H;
    for (let i = 0; i < ti; i++) y += laneH(i);
    return y;
  };
  const totalH = () => laneTop(TRACKS.length);
  const subTop = (ti: number, j: number) => {
    let y = laneTop(ti) + mainH;
    for (let k = 0; k < j; k++) y += rowH(ti, k);
    return y;
  };

  /**
   * Match the canvas to the timeline. Resizing a canvas wipes it, so this only touches the size
   * when it really changed, and redraws right away so a blank frame never reaches the screen.
   */
  function sizeCanvas() {
    fitRows();
    const dpr = window.devicePixelRatio || 1;
    const w = scroller.clientWidth, hh = Math.round(totalH());
    const pw = Math.round(w * dpr), ph = Math.round(hh * dpr);
    if (canvas.width === pw && canvas.height === ph) return;
    spacerEl.style.height = `${hh}px`;
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hh}px`;
    canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTimeline();
  }

  /**
   * Lanes and value rows share the panel's height, so the whole song fits without scrolling. Room for
   * the one hot row comes off the top; value rows get what's left after minimum lanes, then lanes
   * take the rest. Below the minimums the panel scrolls.
   */
  function fitRows() {
    if (!tracksEl) return;
    const cs = getComputedStyle(tracksEl);
    const avail = tracksEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - RULER_H - 14; // 14: scrollbar
    const rows = TRACKS.reduce((n, _, ti) => n + lockIds(ti).length, 0);
    const lanes = TRACKS.length;
    const nextSub = clamp(Math.floor((avail - HOT_H - lanes * ROW_MIN) / rows), SUB_MIN, SUB_MAX);
    const next = clamp(Math.floor((avail - HOT_H - rows * nextSub) / lanes), ROW_MIN, ROW_MAX);
    if (next === mainH && nextSub === subH) return;
    mainH = next;
    subH = nextSub;
    heads.forEach((el) => (el.style.height = `${mainH}px`));
    subLabels.forEach((labels, ti) => labels.forEach((el, j) => (el.style.height = `${rowH(ti, j)}px`)));
  }

  /** The ruler sticks to the top of the visible panel. */
  const rulerY = () => Math.max(0, Math.min(tracksEl?.scrollTop ?? 0, totalH() - RULER_H));

  const sameRow = (a: RowRef, b: RowRef) => a?.ti === b?.ti && a?.sub === b?.sub;

  /** Click a compact row = open it for editing (one at a time); click it again or Esc = close. */
  function openRow(r: RowRef) {
    hot = sameRow(r, hot) ? null : r;
    openedAt = performance.now();
  }

  /** Per frame: ease every row's height toward its target. */
  function animateRows(_now: number, dt: number) {
    const k = 1 - Math.exp(-dt / 0.04); // ~120 ms to settle
    let changed = false;
    subLabels.forEach((labels, ti) => labels.forEach((el, j) => {
      const key = `${ti}:${j}`;
      const cur = rowAnim.get(key) ?? subH;
      const target = isHot(ti, j) ? HOT_H : subH;
      const next = Math.abs(target - cur) < 0.5 ? target : cur + (target - cur) * k;
      el.classList.toggle('hot', isHot(ti, j));
      if (next === cur) return;
      rowAnim.set(key, next);
      el.style.height = `${next}px`;
      changed = true;
    }));
    if (changed) sizeCanvas();
  }

  function setLock(ti: number, id: string, si: number, v: number) {
    const arr = p.tracks[ti].locks[id];
    if (arr[si] === v) return;
    commitPending();
    arr[si] = v;
    send({ t: 'lock', i: ti, id, si, v });
    scheduleSave(p);
  }

  /** A new note starts with the values of the previous note on its track. */
  function inheritLocks(ti: number, si: number) {
    const tr = p.tracks[ti];
    let j = si - 1;
    while (j >= 0 && !tr.s[j]) j--;
    if (j < 0) return;
    for (const id of lockIds(ti)) setLock(ti, id, si, tr.locks[id][j]);
  }

  /**
   * Normalized value a note plays with for `id`: its lock, else the default.
   * GLOBAL has no notes: a set value holds until the next set one.
   */
  const noteValue = (ti: number, id: string, si: number) => {
    const arr = p.tracks[ti].locks[id];
    let j = si;
    if (TRACKS[ti].global) while (j > 0 && arr[j] === NO_LOCK) j--;
    const v = j >= 0 ? arr[j] : NO_LOCK;
    return v === NO_LOCK ? p.params[id] : fromIndex(PARAM_BY_ID[id], v);
  };

  function timeline(): HTMLElement {
    scroller = h('div', 'scroller');
    spacerEl = h('div', 'spacer');
    spacerEl.style.width = `${SONG_STEPS * CELL}px`;
    spacerEl.style.height = `${totalH()}px`;
    canvas = h('canvas');
    spacerEl.append(canvas);
    scroller.append(spacerEl);

    resizeObs?.disconnect();
    resizeObs = new ResizeObserver(sizeCanvas);
    resizeObs.observe(scroller);
    resizeObs.observe(tracksEl);

    // Manual scrolling (scrollbar, trackpad, wheel) stops follow mode.
    scroller.addEventListener('pointerdown', (e) => e.target === scroller && setFollow(false));

    /** Where the pointer is: ruler, a track's main lane (sub = -1), or one of its bar rows. */
    const hit = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const x = e.offsetX + scroller.scrollLeft;
      const si = clamp(Math.floor(x / CELL), 0, SONG_STEPS - 1);
      const y = e.offsetY;
      if (y < rulerY() + RULER_H) return { si, ti: -1, sub: -1, rowTop: 0, ruler: true };
      for (let ti = 0; ti < TRACKS.length; ti++) {
        const top = laneTop(ti);
        if (y < top + mainH) return { si, ti, sub: -1, rowTop: top, ruler: false };
        let rt = top + mainH;
        for (let j = 0; j < subRows(ti).length; j++) {
          if (y < rt + rowH(ti, j)) return { si, ti, sub: j, rowTop: rt, ruler: false };
          rt += rowH(ti, j);
        }
      }
      return { si, ti: -1, sub: -1, rowTop: 0, ruler: false };
    };

    // main lane: click = toggle on/off · drag sideways = paint · drag vertically = pitch
    let drag: { ti: number; si0: number; last: number; y: number; note: number; mode: 'pending' | 'paint' | 'note'; paint: StepState } | null = null;
    // bar rows: drag up/down = that note's value · drag sideways = draw across notes (absolute height)
    let bars: { ti: number; sub: number; id: string; si0: number; last: number; y: number; idx0: number; rowTop: number; mode: 'pending' | 'nudge' | 'draw' } | null = null;

    /** Absolute drawing: mouse height in the row → position (same geometry as drawTimeline). */
    const idxFromY = (b: NonNullable<typeof bars>, y: number) => {
      const d = PARAM_BY_ID[b.id];
      const n = clamp(1 - (y - b.rowTop - padTop(b.ti, b.sub)) / barSpan(b.ti, b.sub));
      return Math.round(n * (d.positions - 1));
    };

    // selecting: drag on the ruler = whole bars on all tracks · shift-drag in the lanes = rectangle
    let selDrag: { ruler: boolean; t0: number; s0: number; ti: number; moved: boolean } | null = null;

    const updateSel = (si: number, ti: number) => {
      const d = selDrag!;
      if (d.ruler) {
        const a = Math.floor(Math.min(d.s0, si) / STEPS_PER_BAR) * STEPS_PER_BAR;
        const b = (Math.floor(Math.max(d.s0, si) / STEPS_PER_BAR) + 1) * STEPS_PER_BAR;
        sel = { t0: 0, t1: TRACKS.length - 1, s0: a, s1: Math.min(b, SONG_STEPS) };
      } else {
        if (ti >= 0) d.ti = ti;
        sel = { t0: Math.min(d.t0, d.ti), t1: Math.max(d.t0, d.ti), s0: Math.min(d.s0, si), s1: Math.max(d.s0, si) + 1 };
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { si, ti, sub, rowTop, ruler } = hit(e);
      if (ruler || (e.shiftKey && ti >= 0)) {
        canvas.setPointerCapture(e.pointerId);
        selDrag = { ruler, t0: ti, s0: si, ti, moved: false };
        if (!ruler) updateSel(si, ti);
        return;
      }
      if (ti < 0) return;
      sel = null;
      pending = snapshot(p);
      const tr = p.tracks[ti];
      if (sub >= 0 && !isHot(ti, sub)) {
        // a compact row: this click only opens it
        pending = null;
        openRow({ ti, sub });
        return;
      }
      if (sub >= 0) {
        const id = subRows(ti)[sub];
        canvas.setPointerCapture(e.pointerId);
        bars = { ti, sub, id, si0: si, last: si, y: e.clientY, idx0: toIndex(PARAM_BY_ID[id], noteValue(ti, id, si)), rowTop, mode: 'pending' };
        return;
      }
      if (TRACKS[ti].global) {
        // no notes on GLOBAL: its values are edited in its rows
        pending = null;
        return;
      }
      if (e.altKey) {
        // Alt-click = toggle slide (turns the step on if needed)
        if (TRACKS[ti].slide) setStep(ti, si, (tr.s[si] || 1) as StepState, tr.note[si], tr.slide[si] ? 0 : 1);
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      drag = { ti, si0: si, last: si, y: e.clientY, note: tr.note[si], mode: 'pending', paint: (tr.s[si] ? 0 : 1) as StepState };
    });
    canvas.addEventListener('pointermove', (e) => {
      const h0 = hit(e);
      hover = h0.ti >= 0 ? { ti: h0.ti, si: h0.si, sub: h0.sub } : null;
      if (selDrag) {
        if (h0.si !== selDrag.s0 || h0.ti !== selDrag.t0) selDrag.moved = true;
        if (selDrag.moved || !selDrag.ruler) updateSel(h0.si, h0.ti);
        return;
      }
      if (bars) {
        const b = bars;
        const { si } = hit(e);
        const tr = p.tracks[b.ti];
        if (b.mode === 'pending') {
          if (si !== b.si0) b.mode = 'draw';
          else if (Math.abs(b.y - e.clientY) > 4) b.mode = 'nudge';
        }
        if (b.mode === 'nudge' && tr.s[b.si0]) {
          const max = PARAM_BY_ID[b.id].positions - 1;
          setLock(b.ti, b.id, b.si0, clamp(b.idx0 + Math.round((b.y - e.clientY) / 8), 0, max));
        } else if (b.mode === 'draw') {
          const idx = idxFromY(b, e.offsetY);
          const lo = Math.min(b.last, si), hi = Math.max(b.last, si);
          for (let i = lo; i <= hi; i++) if (tr.s[i]) setLock(b.ti, b.id, i, idx);
          b.last = si;
        }
        return;
      }
      if (!drag) return;
      const { si } = hit(e);
      const d = drag;
      const tr = p.tracks[d.ti];
      if (d.mode === 'pending') {
        if (si !== d.si0) {
          d.mode = 'paint';
          setStep(d.ti, d.si0, d.paint, tr.note[d.si0]);
        } else if (Math.abs(d.y - e.clientY) > 5) {
          d.mode = 'note';
        }
      }
      if (d.mode === 'paint' && si !== d.last) {
        const dir = si > d.last ? 1 : -1;
        for (let i = d.last + dir; i !== si + dir; i += dir) setStep(d.ti, i, d.paint, tr.note[i]);
        d.last = si;
      } else if (d.mode === 'note') {
        const note = clamp(d.note + Math.round((d.y - e.clientY) / 8), -pitchRange(d.ti), pitchRange(d.ti));
        setStep(d.ti, d.si0, (tr.s[d.si0] || 1) as StepState, note);
      }
    });
    const end = () => {
      if (selDrag?.ruler && !selDrag.moved) {
        // plain ruler click: move the start marker
        sel = null;
        startStep = Math.floor(selDrag.s0 / STEPS_PER_BAR) * STEPS_PER_BAR;
        if (!t.playing) t.phase = startStep;
      }
      selDrag = null;
      if (drag?.mode === 'pending') {
        const tr = p.tracks[drag.ti];
        setStep(drag.ti, drag.si0, drag.paint, tr.note[drag.si0]);
      }
      drag = null;
      bars = null;
      pending = null;
    };
    canvas.addEventListener('pointerleave', () => (hover = null));
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // double-click a bar = remove that note's lock (back to the knob)
    canvas.addEventListener('dblclick', (e) => {
      const { si, ti, sub } = hit(e);
      if (performance.now() - openedAt < 500) return; // that was the click that opened the row
      if (ti >= 0 && sub >= 0 && isHot(ti, sub)) {
        pending = snapshot(p);
        setLock(ti, subRows(ti)[sub], si, NO_LOCK);
        pending = null;
      }
    });

    // Vertical wheel over an active step = note. Otherwise wheel scrolls the timeline (or the panel, see below).
    scroller.addEventListener('wheel', (e) => {
      const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey;
      if (vertical && e.target === canvas) {
        const { si, ti, sub } = hit(e);
        const tr = ti >= 0 ? p.tracks[ti] : null;
        if (tr && sub < 0 && tr.s[si] && !TRACKS[ti].global) {
          e.preventDefault();
          setStep(ti, si, tr.s[si] as StepState, clamp(tr.note[si] + (e.deltaY < 0 ? 1 : -1), -pitchRange(ti), pitchRange(ti)));
          return;
        }
      }
      // when the lanes don't fit, the vertical wheel scrolls the panel (natively); otherwise the song
      if (vertical && tracksEl.scrollHeight > tracksEl.clientHeight) return;
      setFollow(false);
      if (vertical) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    return scroller;
  }

  function drawTimeline() {
    const ctx = canvas.getContext('2d')!;
    const w = scroller.clientWidth;
    const x0 = scroller.scrollLeft;
    const first = Math.floor(x0 / CELL);
    const last = Math.min(SONG_STEPS - 1, Math.ceil((x0 + w) / CELL));
    const H = totalH();
    ctx.clearRect(0, 0, w, H);

    // bar lines
    for (let b = Math.floor(first / STEPS_PER_BAR); b * STEPS_PER_BAR <= last; b++) {
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(b * STEPS_PER_BAR * CELL - x0, 0, 1, H);
    }

    // lanes
    ctx.textAlign = 'center';
    ctx.font = `bold 12px ${DISPLAY_FONT}`;
    for (let ti = 0; ti < TRACKS.length; ti++) {
      const tr = p.tracks[ti];
      const top = laneTop(ti);
      // a dark seam between tracks, so each track's rows read as one group
      if (ti > 0) {
        ctx.fillStyle = '#0c0b0a';
        ctx.fillRect(0, top, w, 1);
      }
      const pad = Math.round(mainH * 0.17);
      const y = top + pad;
      const hh = mainH - pad * 2;
      const ids = lockIds(ti);
      ctx.globalAlpha = audible(p.tracks, ti) ? 1 : 0.3;
      const g = TRACKS[ti].global;
      for (let si = first; si <= last; si++) {
        // GLOBAL: highlight the steps where a value changes, named by the scale if that's one of them
        const set = ids.some((id) => tr.locks[id][si] !== NO_LOCK);
        const st = g ? set : tr.s[si];
        const x = si * CELL - x0 + 1;
        ctx.fillStyle = st ? COLORS.accentDim : si % 4 === 0 ? COLORS.beat : COLORS.cell;
        ctx.fillRect(x, y, CELL - 2, hh);
        if (!st) continue;
        // an LED strip along the top of every note; the note under the playhead lights up whole
        const now = t.playing && Math.floor(t.phase) === si && !g;
        ctx.fillStyle = now ? COLORS.hit : COLORS.accent;
        if (now) ctx.fillRect(x, y, CELL - 2, hh);
        else ctx.fillRect(x, y, CELL - 2, 2);
        if (g) {
          ctx.fillStyle = COLORS.text;
          const sc = tr.locks.scale[si];
          if (sc !== NO_LOCK) ctx.fillText(PARAM_BY_ID.scale.steps![sc], x + (CELL - 2) / 2, y + hh / 2);
          else ctx.fillRect(x + CELL / 2 - 2, y + hh / 2 - 1, 3, 3);
          continue;
        }
        if (tr.slide[si]) {
          // slide: a tie from this step into the next
          ctx.fillStyle = COLORS.text;
          ctx.fillRect(x + CELL / 2, y + hh - 4, CELL, 3);
        }
        if (tr.note[si]) {
          ctx.fillStyle = COLORS.text;
          ctx.fillText((tr.note[si] > 0 ? '+' : '') + tr.note[si], x + (CELL - 2) / 2, y + hh / 2);
        }
        if (ids.some((id) => tr.locks[id][si] !== NO_LOCK)) {
          // this note has its own values
          ctx.fillStyle = COLORS.text;
          ctx.fillRect(x + CELL - 7, y + 2, 3, 3);
        }
      }

      // value rows: compact = heat strip of how far each note is from the default, hot = bars
      subRows(ti).forEach((id, j) => {
        const d = PARAM_BY_ID[id];
        const rowTop = subTop(ti, j);
        const height = rowH(ti, j);
        if (height < HEAT_BELOW) {
          const arr = tr.locks[id];
          let held = g ? noteValue(ti, id, first) : 0;
          for (let si = first; si <= last; si++) {
            if (!tr.s[si]) continue;
            if (g && arr[si] !== NO_LOCK) held = fromIndex(d, arr[si]);
            const n = g ? held : noteValue(ti, id, si);
            const dv = n - d.defN;
            const room = dv > 0 ? 1 - d.defN : d.defN;
            const k = room > 0 ? Math.min(1, Math.abs(dv) / room) : 0;
            // warm = above the default, cool = below, brighter = further; untouched = faint
            ctx.fillStyle = k < 0.01 ? COLORS.cell : dv > 0 ? `rgba(232, 163, 61, ${0.25 + 0.75 * k})` : `rgba(110, 160, 230, ${0.25 + 0.75 * k})`;
            const x = si * CELL - x0;
            // GLOBAL values run on, so their cells join up
            if (g) ctx.fillRect(x, rowTop + 1, CELL, height - 1);
            else ctx.fillRect(x + 2, rowTop + 1, CELL - 4, height - 1);
          }
          return;
        }
        const pad = padTop(ti, j);
        const span = barSpan(ti, j);
        const bottom = rowTop + height - padBottom(ti, j);
        const showValues = isHot(ti, j);
        if (showValues) {
          ctx.fillStyle = COLORS.cell;
          ctx.fillRect(0, rowTop, w, height);
        }
        ctx.fillStyle = COLORS.cell;
        ctx.fillRect(0, rowTop + height - 1, w, 1);
        const arr = tr.locks[id];
        let held = g ? noteValue(ti, id, first) : 0;
        for (let si = first; si <= last; si++) {
          if (!tr.s[si]) continue;
          const locked = arr[si] !== NO_LOCK;
          if (g && locked) held = fromIndex(d, arr[si]);
          const n = g ? held : noteValue(ti, id, si);
          const x = si * CELL - x0;
          ctx.fillStyle = locked ? COLORS.text : COLORS.line;
          if (d.bipolar) {
            // grows up/down from the centre line (e.g. Pan: up = right, down = left)
            const mid = rowTop + pad + span / 2;
            const bh = Math.max(2, Math.abs(n - 0.5) * span);
            ctx.fillRect(x + 4, n >= 0.5 ? mid - bh : mid, CELL - 8, bh);
          } else {
            const bh = Math.max(2, n * span);
            ctx.fillRect(x + 4, bottom - bh, CELL - 8, bh);
          }
          if (showValues && (!g || locked || si === first)) {
            // position as a number: 0–8, or −4…+4 around the centre for bipolar values
            const idx = toIndex(d, n);
            const half = (d.positions - 1) / 2;
            const label = d.steps ? d.steps[idx] : d.id === 'tempo' ? String(Math.round(toReal(d, n))) : d.bipolar ? (idx > half ? '+' : '') + (idx - half) : String(idx);
            ctx.fillStyle = locked ? COLORS.text : COLORS.dim;
            ctx.fillText(label, x + CELL / 2, rowTop + 7);
          }
        }
      });
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';

    // ruler (stays on top while the panel scrolls vertically): bar numbers + start marker
    const ry = rulerY();
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(0, ry, w, RULER_H);
    ctx.font = `bold 13px ${DISPLAY_FONT}`;
    ctx.textBaseline = 'middle';
    for (let b = Math.floor(first / STEPS_PER_BAR); b * STEPS_PER_BAR <= last; b++) {
      const x = b * STEPS_PER_BAR * CELL - x0;
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(x, ry, 1, RULER_H);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(String(b + 1), x + 4, ry + RULER_H / 2);
    }
    const sx = startStep * CELL - x0;
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(sx, ry + RULER_H - 7);
    ctx.lineTo(sx + 7, ry + RULER_H - 7);
    ctx.lineTo(sx, ry + RULER_H);
    ctx.fill();

    // selection + where a paste would land (while ⌘/Ctrl is held)
    const box = (r: Region) => {
      const y0 = laneTop(r.t0), y1 = laneTop(r.t1) + laneH(r.t1);
      return [r.s0 * CELL - x0, y0, (r.s1 - r.s0) * CELL, y1 - y0] as const;
    };
    if (sel) {
      const [bx, by, bw, bh] = box(sel);
      ctx.fillStyle = 'rgba(232, 163, 61, 0.12)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = COLORS.accent;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    }
    if (clip && modHeld && hover) {
      const t0 = clip.allTracks ? 0 : hover.ti;
      const t1 = Math.min(TRACKS.length - 1, t0 + clip.tracks.length - 1);
      const [bx, by, bw, bh] = box({ t0, t1, s0: hover.si, s1: Math.min(SONG_STEPS, hover.si + clip.len) });
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = COLORS.text;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      ctx.setLineDash([]);
    }

    // playhead
    if (t.playing || t.phase !== startStep) {
      ctx.fillStyle = COLORS.playhead;
      ctx.shadowColor = COLORS.playhead;
      ctx.shadowBlur = 8;
      ctx.fillRect(t.phase * CELL - x0, 0, 2, H);
      ctx.shadowBlur = 0;
    }
  }

  // ---- transport --------------------------------------------------------

  function setPlaying(on: boolean) {
    t.playing = on;
    t.phase = t.enginePhase = startStep;
    t.posAt = performance.now();
    if (on) {
      setFollow(true);
      startEngine(() => p).then(() => send({ t: 'play', on: t.playing, from: startStep }));
    } else {
      send({ t: 'play', on, from: startStep });
    }
    playBtn.classList.toggle('lit', on);
    playBtn.textContent = on ? 'STOP' : 'PLAY';
    document.body.classList.toggle('playing', on); // spins the record
  }

  function setRec(on: boolean) {
    t.rec = on;
    t.recStart = performance.now();
    if (on) startEngine(() => p).then(() => send({ t: 'rec', on: t.rec }));
    else send({ t: 'rec', on });
    recBtn.classList.toggle('lit', on);
    if (!on) recBtn.textContent = 'REC';
  }

  function setThrow(i: number, on: boolean) {
    if (on) throws.add(i);
    else throws.delete(i);
    names[i].classList.toggle('throw', on);
    send({ t: 'throw', i, on });
  }

  // ---- layout -----------------------------------------------------------

  function button(label: string, cls: string, onClick: () => void) {
    const b = h('button', cls, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function setHelp(on: boolean) {
    helpOpen = on;
    help.hidden = !on;
    helpBtn.classList.toggle('lit', on);
  }

  function logo() {
    const el = h('div', 'logo');
    const word = h('div', 'wordmark');
    word.append(h('b', '', 'DUBBOX'), h('small', '', '33⅓ RPM · STEREO · DUB TECHNIQUE'));
    el.append(h('div', 'vinyl'), word);
    return el;
  }

  function build() {
    const scrollLeft = scroller?.scrollLeft ?? 0;
    heads = [];
    subLabels = [];
    rowAnim.clear();
    hot = null;
    names = [];
    root.innerHTML = '';

    // header
    const header = h('header');
    playBtn = button(t.playing ? 'STOP' : 'PLAY', 'btn led', () => setPlaying(!t.playing));
    playBtn.classList.toggle('lit', t.playing);
    recBtn = button('REC', 'btn rec led', () => setRec(!t.rec));
    followBtn = button('FOLLOW', 'btn small lit', () => setFollow(!follow));
    followBtn.title = 'keep the playhead in view (F)';
    const file = h('input');
    file.type = 'file';
    file.accept = 'application/json';
    file.hidden = true;
    file.addEventListener('change', async () => {
      if (!file.files?.[0]) return;
      p = await importProject(file.files[0]);
      file.value = '';
      scheduleSave(p);
      send({ t: 'init', project: p });
      build();
    });
    header.append(
      logo(),
      playBtn, recBtn, followBtn,
      h('div', 'spacer'),
      helpBtn = button('?', 'btn small help-btn', () => setHelp(!helpOpen)),
      button('SAVE', 'btn small', () => exportProject(p)),
      button('LOAD', 'btn small', () => file.click()),
      button('NEW', 'btn small', () => {
        if (!confirm('Start a new empty project? Unsaved work is lost.')) return;
        p = emptyProject();
        scheduleSave(p);
        send({ t: 'init', project: p });
        build();
      }),
      file,
    );

    // tracks: heads | scrolling timeline
    const tracks = h('main', 'tracks');
    tracksEl = tracks;
    tracks.addEventListener('scroll', () => drawTimeline());
    const headCol = h('div', 'col');
    headCol.append(h('div', 'ruler-gap'));
    TRACKS.forEach((td, ti) => {
      const head = h('div', 'head');
      head.style.height = `${mainH}px`;
      const name = h('div', 'name', td.name);
      name.title = td.global
        ? 'song-wide values: scale, key, tempo, FX'
        : `hold ${THROW_KEYS[ti].slice(3)} = dub throw · ${ti + 1} = mute · shift+${ti + 1} = solo`;
      const toggles = h('div', 'toggles');
      if (!td.global) toggles.append(
        button('M', 'tog mute', () => { p.tracks[ti].mute = !p.tracks[ti].mute; flagsChanged(ti); }),
        button('S', 'tog solo', () => { p.tracks[ti].solo = !p.tracks[ti].solo; flagsChanged(ti); }),
      );
      head.append(name, toggles);
      headCol.append(head);
      heads.push(head);
      names.push(name);
      subLabels[ti] = subRows(ti).map((id, j) => {
        const el = h('div', 'sublabel');
        el.append(h('div', 'subname', PARAM_BY_ID[id].label), h('div', 'subdesc', describe(id)));
        el.style.height = `${rowH(ti, j)}px`;
        // names stagger across 3 columns, so each can be taller than its row without touching a neighbour
        el.style.setProperty('--col', String(j % LABEL_COLS));
        el.addEventListener('click', () => openRow({ ti, sub: j }));
        headCol.append(el);
        return el;
      });
    });
    tracks.append(headCol, timeline());


    // shortcuts: hidden until asked for (? button or key), floating over the timeline
    help = h('div', 'help');
    help.hidden = !helpOpen;
    helpBtn.classList.toggle('lit', helpOpen);
    for (const [key, what] of HELP) {
      const item = h('div');
      item.append(h('span', 'key', key), what);
      help.append(item);
    }

    root.append(header, tracks, help);
    sizeCanvas(); // fit the lanes to the window before the first frame
    p.tracks.forEach((_, i) => renderHead(i));
    scroller.scrollLeft = scrollLeft;
  }

  // ---- frame loop -------------------------------------------------------

  let lastFrame = performance.now();
  function frame(now: number) {
    animateRows(now, Math.min(0.1, (now - lastFrame) / 1000));
    lastFrame = now;
    if (t.playing) {
      const bpm = toReal(PARAM_BY_ID.tempo, noteValue(GLOBAL, 'tempo', Math.floor(t.phase)));
      t.phase = (t.enginePhase + (now - t.posAt) / 1000 / (60 / bpm / 4)) % SONG_STEPS;
      if (follow) scroller.scrollLeft = t.phase * CELL - scroller.clientWidth * 0.25;
    }
    drawTimeline();

    if (t.rec) {
      const s = Math.floor((now - t.recStart) / 1000);
      recBtn.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }
    requestAnimationFrame(frame);
  }

  // ---- keyboard ---------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) setPlaying(!t.playing);
      return;
    }
    if (e.key === 'Meta' || e.key === 'Control') modHeld = true;
    if ((e.metaKey || e.ctrlKey) && editKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape') {
      sel = null;
      hot = null;
      if (helpOpen) setHelp(false);
    }
    if (e.key === '?') setHelp(!helpOpen);
    if (e.code === 'KeyD' && !e.metaKey && !e.ctrlKey && !e.repeat) {
      dice();
      return;
    }
    if ((e.code === 'Backspace' || e.code === 'Delete') && sel) {
      const r0 = sel;
      edit(() => clear(p, r0));
      e.preventDefault();
      return;
    }
    if (e.repeat || e.metaKey || e.ctrlKey) return;
    const digit = /^Digit([1-6])$/.exec(e.code);
    if (digit) {
      const i = +digit[1] - 1;
      if (e.shiftKey) p.tracks[i].solo = !p.tracks[i].solo;
      else p.tracks[i].mute = !p.tracks[i].mute;
      flagsChanged(i);
    }
    if (e.code === 'KeyF') setFollow(!follow);
    const ti = THROW_KEYS.indexOf(e.code);
    if (ti >= 0) setThrow(ti, true);
  });
  window.addEventListener('blur', () => (modHeld = false));
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta' || e.key === 'Control') modHeld = false;
    const ti = THROW_KEYS.indexOf(e.code);
    if (ti >= 0) setThrow(ti, false);
  });

  onEngine((m) => {
    if (m.t === 'pos') {
      if (!t.playing) return;
      t.enginePhase = m.phase;
      t.posAt = performance.now();
    } else if (m.t === 'audio') {
      recorder.push(m.l, m.r);
    } else if (m.t === 'recEnd') {
      recorder.finish(m.sampleRate);
    }
  });

  build();
  requestAnimationFrame(frame);
}
