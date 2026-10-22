import { GLOBAL, PARAM_BY_ID, RATCHET, TRACKS, rowGroups, mixId, describe, pitchRange, fromIndex, lockIds, toIndex, toReal } from './params';
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
  ['1–7 / ⇧1–7', 'mute / solo'],
  ['hold Q W E R T Y U', 'dub throw'],
  ['click step', 'on / off'],
  ['drag sideways', 'paint steps'],
  ['drag ↕ / wheel on step', 'pitch'],
  ['⌥-click step', 'slide (synths)'],
  ['click track name', 'per-note values (GLOBAL: tempo, FX…)'],
  ['drag in a value row', 'set · across = draw'],
  ['hold ⌥ over a value row', 'magnify it (numbers, fine drawing)'],
  ['⇧-drag in a value row', 'ramp: straight line across notes'],
  ['dbl-click value', 'back to default'],
  ['click ruler', 'play from bar'],
  ['drag ruler / ⇧-drag', 'select bars / area'],
  ['L', 'loop selection / bar · again = off'],
  ['⌘C ⌘X ⌘V', 'copy / cut / paste at mouse'],
  ['⌘D', 'duplicate'],
  ['delete', 'clear selection'],
  ['D', 'dice selection / hovered'],
  ['⌘Z / ⇧⌘Z', 'undo / redo'],
  ['wheel', 'scroll'],
  ['⌘-wheel / pinch · − =', 'zoom out / in'],
];

const THROW_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU'];

// timeline geometry (px)
const CELL_MAX = 22; // step width fully zoomed in (px)…
const CELL_MIN = 1; // …and fully out: the whole song is 4800 px
const ROW_MIN = 40; // track lanes: one fixed height, open or closed (the panel scrolls if needed)
const ROW_MAX = 40;
const RULER_H = 20;
const PAD = 9;
const SUB_H = 22; // per-note bar rows of an expanded track
const HOT_H = 80; // hold ⌥ over a value row: it pops out this tall over its neighbours (a lens)
const HOT_PAD_TOP = 13; // room for the value numbers
const HOT_PAD_BOTTOM = 2;
const GROUP_H = 5; // gap + divider above each group's first row (its name runs down the left)
/** Per track: row index → name of the group it starts. */
const GROUP_AT = TRACKS.map((_, i) => {
  const at = new Map<number, string>();
  let j = 0;
  for (const g of rowGroups(i)) {
    at.set(j, g.name);
    j += g.ids.length;
  }
  return at;
});
const COLORS = {
  bg: '#0d0d0c',
  cell: '#1f1e1b',
  beat: '#292824',
  line: '#3a3833',
  dim: '#5d5a53',
  text: '#d9d4c7',
  accent: '#e8a33d',
  accentDim: '#6b4d22',
  bar: '#a39d90', // a note's value bar: one tone, set or default alike
};

// ---- UI -----------------------------------------------------------------

export function mountUI(root: HTMLElement, initial: Project) {
  let p = initial;

  // Transport mirror: the engine reports its phase ~30x/s, the UI extrapolates between reports.
  const t = { playing: false, phase: 0, enginePhase: 0, posAt: 0, rec: false, recStart: 0 };
  const recorder = new Recorder();
  const throws = new Set<number>();

  let heads: HTMLElement[] = [];
  let names: HTMLElement[] = [];
  let playBtn: HTMLButtonElement, recBtn: HTMLButtonElement, followBtn: HTMLButtonElement, loopBtn: HTMLButtonElement;
  let scroller: HTMLElement, canvas: HTMLCanvasElement;
  let startStep = 0; // where Play starts (set by clicking the ruler)
  let follow = true; // keep the playhead in view while playing
  let CELL = CELL_MAX; // step width now: zoom glides it toward cellTarget
  let cellTarget = CELL_MAX;
  let zoomAt = 0; // px from the timeline's left edge that stays put while zooming…
  let zoomStep = 0; // …and the song position (in steps) pinned there
  let mouseX: number | null = null; // pointer over the timeline (px from its left edge)
  let loop: { s0: number; s1: number } | null = null; // playback repeats steps s0..s1 (exclusive)
  let expanded = -1; // track showing its per-note bar rows
  let closing = -1; // track whose rows are folding away (still drawn until they reach 0)
  let resizeObs: ResizeObserver | undefined;
  let help: HTMLElement, helpBtn: HTMLButtonElement;
  let helpOpen = false;
  let tracksEl: HTMLElement;
  let mainH = 52; // height of a track's main lane, fitted to the window
  let spacerEl: HTMLElement;
  type RowRef = { ti: number; sub: number } | null;
  let hot: RowRef = null; // the magnified value row (while ⌥ is held over it)
  let altHeld = false;
  let gesture = false; // a drag is in progress: the lens stays on its row until it ends
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
  // ⇧-drag in an open row: a straight line from the press to the mouse, every note on it gets its point
  let ramp: { ti: number; id: string; si0: number; idx0: number; si1: number; idx1: number; orig: Uint8Array } | null = null;

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

  /** Aim the zoom (it glides there over a few frames), around `ax` px from the timeline's left edge. */
  function zoomBy(factor: number, ax = mouseX ?? scroller.clientWidth / 2) {
    // pin the song position under the cursor; mid-glide at the same spot the pin is already there
    if (CELL === cellTarget || ax !== zoomAt) zoomStep = (scroller.scrollLeft + ax) / CELL;
    zoomAt = ax;
    cellTarget = clamp(cellTarget * factor, CELL_MIN, CELL_MAX);
    setFollow(false); // otherwise the playhead would pull the view away from the cursor
  }

  /** Per frame: ease the step width toward the target, keeping the step under the anchor in place. */
  function animateZoom(dt: number) {
    if (CELL === cellTarget) return;
    const k = 1 - Math.exp(-dt / 0.05);
    const next = Math.abs(cellTarget / CELL - 1) < 0.002 ? cellTarget : CELL * Math.pow(cellTarget / CELL, k); // even in log space
    CELL = next;
    spacerEl.style.width = `${SONG_STEPS * CELL}px`;
    scroller.scrollLeft = zoomStep * CELL - zoomAt;
  }

  function setFollow(on: boolean) {
    follow = on;
    followBtn.classList.toggle('lit', on);
  }

  // ---- lane geometry ----------------------------------------------------
  // Each track has a main lane; the expanded track adds one bar row per lockable knob.

  const subRows = (ti: number) => (ti === expanded || ti === closing ? lockIds(ti) : []);
  const isHot = (ti: number, j: number) => !!hot && hot.ti === ti && hot.sub === j;
  /** A group's first row carries its caption gap on top; it folds with the row. */
  const gapH = (ti: number, j: number, anim = rowAnim.get(`${ti}:${j}`) ?? SUB_H) =>
    GROUP_AT[ti].has(j) ? GROUP_H * Math.min(1, anim / SUB_H) : 0;
  const rowH = (ti: number, j: number) => (rowAnim.get(`${ti}:${j}`) ?? SUB_H) + gapH(ti, j);
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
  /** The lens: centred on its row, kept inside the timeline. */
  const lensTop = (ti: number, j: number) =>
    clamp(subTop(ti, j) + gapH(ti, j) + SUB_H / 2 - HOT_H / 2, RULER_H, Math.max(RULER_H, totalH() - HOT_H));
  /** Where a row's bars are: in its own slot, or in the lens when magnified. Bars fill pad..bottom. */
  const rowGeom = (ti: number, j: number) => {
    if (isHot(ti, j)) {
      const top = lensTop(ti, j);
      return { top, height: HOT_H, pad: HOT_PAD_TOP, bottom: top + HOT_H - HOT_PAD_BOTTOM, span: HOT_H - HOT_PAD_TOP - HOT_PAD_BOTTOM };
    }
    const top = subTop(ti, j), height = rowH(ti, j), pad = gapH(ti, j) + 2;
    return { top, height, pad, bottom: top + height - 2, span: height - pad - 2 };
  };
  /** Mouse height → position (0..max) in a row, by the geometry it's drawn with. */
  const idxAt = (ti: number, j: number, y: number) => {
    const gm = rowGeom(ti, j);
    return Math.round(clamp(1 - (y - gm.top - gm.pad) / gm.span) * (PARAM_BY_ID[lockIds(ti)[j]].positions - 1));
  };
  const inLens = (y: number) => !!hot && y >= lensTop(hot.ti, hot.sub) && y < lensTop(hot.ti, hot.sub) + HOT_H;

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
   * Lanes share the panel's height, so the whole song fits without scrolling. An expanded track's
   * rows (and the room a hot row grows into) come off the top first; below ROW_MIN the panel scrolls.
   */
  function fitRows() {
    if (!tracksEl) return;
    const cs = getComputedStyle(tracksEl);
    const avail = tracksEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - RULER_H - 14; // 14: scrollbar
    const extra = expanded >= 0 ? lockIds(expanded).length * SUB_H + GROUP_AT[expanded].size * GROUP_H : 0;
    const next = clamp(Math.floor((avail - extra) / TRACKS.length), ROW_MIN, ROW_MAX);
    if (next === mainH) return;
    mainH = next;
    heads.forEach((el) => (el.style.height = `${mainH}px`));
  }

  const sameRow = (a: RowRef, b: RowRef) => a?.ti === b?.ti && a?.sub === b?.sub;

  /** ⌥ held: magnify the row under the mouse. Inside the lens it stays put; mid-drag it never moves. */
  function updateLens(y?: number) {
    if (gesture) return;
    if (!altHeld || !hover || hover.sub < 0) {
      if (!(altHeld && y !== undefined && inLens(y))) hot = null;
      return;
    }
    if (y !== undefined && inLens(y)) return;
    const r = { ti: hover.ti, sub: hover.sub };
    if (!sameRow(r, hot)) hot = r;
  }

  /** Per frame: ease every row's height toward its target. */
  function animateRows(_now: number, dt: number) {
    const k = 1 - Math.exp(-dt / 0.04); // ~120 ms to settle
    let changed = false;
    subLabels.forEach((labels, ti) => labels.forEach((el, j) => {
      const key = `${ti}:${j}`;
      const cur = rowAnim.get(key) ?? SUB_H;
      const target = ti === closing ? 0 : SUB_H;
      const next = Math.abs(target - cur) < 0.5 ? target : cur + (target - cur) * k;
      el.classList.toggle('hot', isHot(ti, j));
      if (next === cur) return;
      rowAnim.set(key, next);
      el.style.height = `${next + gapH(ti, j, next)}px`;
      el.style.paddingTop = `${gapH(ti, j, next)}px`;
      changed = true;
    }));
    if (changed) sizeCanvas();
    // the folding track has reached 0: drop its rows for good
    if (closing >= 0 && lockIds(closing).every((_, j) => (rowAnim.get(`${closing}:${j}`) ?? 0) === 0)) {
      closing = -1;
      build();
    }
  }

  /** Click a track name: its rows unfold from 0 (and the open one, if any, folds away). */
  function toggleTrack(ti: number) {
    const prev = expanded;
    const midFold = ti === closing; // reopened while folding: unfold from where it is
    expanded = expanded === ti ? -1 : ti;
    closing = prev >= 0 && prev !== expanded ? prev : -1;
    if (expanded >= 0 && !midFold) lockIds(expanded).forEach((_, j) => rowAnim.set(`${expanded}:${j}`, 0));
    build();
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

  /** A note's value differs from the default (unset, or set to the default, both count as default). */
  const shaped = (ti: number, id: string, si: number) => {
    const v = p.tracks[ti].locks[id][si];
    return v !== NO_LOCK && v !== toIndex(PARAM_BY_ID[id], PARAM_BY_ID[id].defN);
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
      if (y < RULER_H) return { si, ti: -1, sub: -1, rowTop: 0, ruler: true };
      if (hot && inLens(y)) return { si, ti: hot.ti, sub: hot.sub, rowTop: lensTop(hot.ti, hot.sub), ruler: false };
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
      if (ruler || (e.shiftKey && ti >= 0 && sub < 0)) {
        canvas.setPointerCapture(e.pointerId);
        selDrag = { ruler, t0: ti, s0: si, ti, moved: false };
        if (!ruler) updateSel(si, ti);
        return;
      }
      if (ti < 0) return;
      sel = null;
      pending = snapshot(p);
      const tr = p.tracks[ti];
      if (sub >= 0) {
        const id = subRows(ti)[sub];
        canvas.setPointerCapture(e.pointerId);
        gesture = true;
        if (e.shiftKey) {
          const idx = idxAt(ti, sub, e.offsetY);
          ramp = { ti, id, si0: si, idx0: idx, si1: si, idx1: idx, orig: tr.locks[id].slice() };
          drawRamp();
          return;
        }
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
      mouseX = e.offsetX;
      const h0 = hit(e);
      hover = h0.ti >= 0 ? { ti: h0.ti, si: h0.si, sub: h0.sub } : null;
      updateLens(e.offsetY);
      if (selDrag) {
        if (h0.si !== selDrag.s0 || h0.ti !== selDrag.t0) selDrag.moved = true;
        if (selDrag.moved || !selDrag.ruler) updateSel(h0.si, h0.ti);
        return;
      }
      if (ramp) {
        const r = ramp;
        r.si1 = h0.si;
        r.idx1 = idxAt(r.ti, subRows(r.ti).indexOf(r.id), e.offsetY);
        drawRamp();
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
          const idx = idxAt(b.ti, b.sub, e.offsetY);
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
    /** Put back what the last frame of the ramp overwrote, then lay the line over the notes it spans. */
    let rampLo = 0, rampHi = -1;
    const drawRamp = () => {
      const r = ramp!;
      const tr = p.tracks[r.ti];
      for (let i = rampLo; i <= rampHi; i++) setLock(r.ti, r.id, i, r.orig[i]);
      rampLo = Math.min(r.si0, r.si1);
      rampHi = Math.max(r.si0, r.si1);
      const len = r.si1 - r.si0;
      for (let i = rampLo; i <= rampHi; i++) {
        if (!tr.s[i]) continue;
        setLock(r.ti, r.id, i, Math.round(len ? r.idx0 + ((r.idx1 - r.idx0) * (i - r.si0)) / len : r.idx0));
      }
    };

    const end = () => {
      rampHi = -1;
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
      ramp = null;
      pending = null;
      gesture = false;
      updateLens(); // ⌥ let go mid-drag: close now
    };
    canvas.addEventListener('pointerleave', () => {
      hover = null;
      mouseX = null;
      updateLens();
    });
    // Safari sends trackpad pinch as gesture events, not ⌘-wheel
    let gestureScale = 1;
    scroller.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureScale = 1;
    });
    scroller.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const scale = (e as unknown as { scale: number }).scale;
      zoomBy(scale / gestureScale);
      gestureScale = scale;
    });
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // double-click a bar = back to the default value
    canvas.addEventListener('dblclick', (e) => {
      const { si, ti, sub } = hit(e);
      if (ti >= 0 && sub >= 0) {
        pending = snapshot(p);
        setLock(ti, subRows(ti)[sub], si, NO_LOCK);
        pending = null;
      }
    });

    // ⌘/Ctrl-wheel (and trackpad pinch) = smooth zoom around the mouse.
    // Vertical wheel over an active step = note. Otherwise wheel scrolls the timeline.
    scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // pinch sends many small deltas, a mouse wheel a few big ones: cap each so a notch ≈ ×1.6
        zoomBy(Math.exp(-clamp(e.deltaY, -50, 50) * 0.01), e.clientX - scroller.getBoundingClientRect().left);
        return;
      }
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
      setFollow(false);
      if (vertical) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    return scroller;
  }

  /** One value row of a track: a bar per note, in its slot or (magnified) in the lens. */
  function drawRow(ctx: CanvasRenderingContext2D, ti: number, j: number, first: number, last: number, x0: number, w: number) {
    const tr = p.tracks[ti];
    const g = TRACKS[ti].global;
    const id = lockIds(ti)[j];
    const d = PARAM_BY_ID[id];
    const gm = rowGeom(ti, j);
    const rowTop = gm.top, height = gm.height;
    // rows unfolding / folding are shorter than their bars: clip to the row
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rowTop, w, height);
    ctx.clip();
    const { pad, span, bottom } = gm;
    const showValues = isHot(ti, j) && CELL >= 16;
    const inset = CELL >= 11 ? 4 : CELL >= 4 ? 1 : 0;
    const gap = isHot(ti, j) ? 0 : gapH(ti, j);
    if (gap) {
      // group divider
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(0, rowTop, w, 1);
    }
    if (showValues) {
      ctx.fillStyle = COLORS.cell;
      ctx.fillRect(0, rowTop + gap, w, height - gap);
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
      // GLOBAL: set here = bright, held from earlier = dim · notes: every value looks the same
      ctx.fillStyle = !g ? COLORS.bar : locked ? COLORS.text : COLORS.line;
      if (d.bipolar) {
        // grows up/down from the centre line (e.g. Pan: up = right, down = left)
        const mid = rowTop + pad + span / 2;
        const bh = Math.max(2, Math.abs(n - 0.5) * span);
        ctx.fillRect(g ? x : x + inset, n >= 0.5 ? mid - bh : mid, g ? CELL : CELL - 2 * inset, bh);
      } else {
        const bh = Math.max(2, n * span);
        ctx.fillRect(g ? x : x + inset, bottom - bh, g ? CELL : CELL - 2 * inset, bh); // GLOBAL: one continuous fill
      }
      if (showValues && (!g || locked || si === first)) {
        // position as a number: 0–8, or −4…+4 around the centre for bipolar values
        const idx = toIndex(d, n);
        const half = (d.positions - 1) / 2;
        const label = d.steps ? d.steps[idx] : d.id === 'tempo' ? String(Math.round(toReal(d, n))) : d.bipolar ? (idx > half ? '+' : '') + (idx - half) : String(idx);
        ctx.fillStyle = !g || locked ? COLORS.text : COLORS.dim;
        ctx.fillText(label, x + CELL / 2, rowTop + 7);
      }
    }
    if (ramp && ramp.ti === ti && ramp.id === id) {
      // the line being drawn
      const max = d.positions - 1;
      const px = (si: number) => si * CELL - x0 + CELL / 2;
      const py = (idx: number) => bottom - (idx / max) * span;
      ctx.strokeStyle = COLORS.accent;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(px(ramp.si0), py(ramp.idx0));
      ctx.lineTo(px(ramp.si1), py(ramp.idx1));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawTimeline() {
    const ctx = canvas.getContext('2d')!;
    const w = scroller.clientWidth;
    const x0 = scroller.scrollLeft;
    const first = Math.floor(x0 / CELL);
    const last = Math.min(SONG_STEPS - 1, Math.ceil((x0 + w) / CELL));
    const H = totalH();
    ctx.clearRect(0, 0, w, H);

    // ruler: bar numbers + start marker
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    // zoomed out: a line and a number every 2, 4, 8… bars so they don't crowd
    let every = 1;
    while (every * STEPS_PER_BAR * CELL < 36) every *= 2;
    for (let b = Math.floor(first / STEPS_PER_BAR / every) * every; b * STEPS_PER_BAR <= last; b += every) {
      const x = b * STEPS_PER_BAR * CELL - x0;
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(String(b + 1), x + 4, RULER_H / 2);
    }
    if (loop) {
      // loop bracket on the ruler + a faint wash over the lanes
      const lx = loop.s0 * CELL - x0, lw = (loop.s1 - loop.s0) * CELL;
      ctx.fillStyle = 'rgba(232, 163, 61, 0.05)';
      ctx.fillRect(lx, RULER_H, lw, H - RULER_H);
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(lx, 0, lw, 3);
      ctx.fillRect(lx, 0, 2, RULER_H);
      ctx.fillRect(lx + lw - 2, 0, 2, RULER_H);
    }
    const sx = startStep * CELL - x0;
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(sx, RULER_H - 7);
    ctx.lineTo(sx + 7, RULER_H - 7);
    ctx.lineTo(sx, RULER_H);
    ctx.fill();

    // lanes
    ctx.textAlign = 'center';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    for (let ti = 0; ti < TRACKS.length; ti++) {
      const tr = p.tracks[ti];
      const top = laneTop(ti);
      const y = top + PAD;
      const hh = mainH - PAD * 2;
      const ids = lockIds(ti);
      ctx.globalAlpha = audible(p.tracks, ti) ? 1 : 0.3;
      const g = TRACKS[ti].global;
      if (g) {
        // GLOBAL has no notes: a thin line, with a marker + what changed wherever a value is set
        ctx.fillStyle = COLORS.cell;
        ctx.fillRect(0, y + hh / 2, w, 1);
        ctx.textAlign = 'left';
        for (let si = first; si <= last; si++) {
          const changed = ids.filter((id) => tr.locks[id][si] !== NO_LOCK);
          if (!changed.length) continue;
          const x = si * CELL - x0;
          ctx.fillStyle = COLORS.accent;
          ctx.fillRect(x, y, 2, hh);
          const text = changed
            .map((id) => {
              const d = PARAM_BY_ID[id], i = tr.locks[id][si];
              return id === 'scale' ? d.steps![i] : id === 'tempo' ? Math.round(toReal(d, fromIndex(d, i))) + ' bpm' : d.label;
            })
            .join(' · ');
          ctx.fillStyle = COLORS.text;
          if (CELL >= 6) ctx.fillText(text, x + 5, y + hh / 2 - 6);
        }
        ctx.textAlign = 'center';
      }
      // zoomed out: cells touch, and the small print goes
      const gap = CELL >= 6 ? 1 : 0;
      const detail = CELL >= 16;
      for (let si = first; si <= last && !g; si++) {
        const st = tr.s[si];
        const x = Math.round(si * CELL - x0) + gap; // whole pixels: crisp at any zoom
        ctx.fillStyle = st ? COLORS.accentDim : si % 4 === 0 && CELL >= 4 ? COLORS.beat : COLORS.cell;
        ctx.fillRect(x, y, Math.round((si + 1) * CELL - x0) - x - gap, hh);
        if (!st || CELL < 11) continue;
        if (tr.slide[si]) {
          // slide: a tie from this step into the next
          ctx.fillStyle = COLORS.text;
          ctx.fillRect(x + CELL / 2, y + hh - 4, CELL, 3);
        }
        if (tr.note[si] && detail) {
          ctx.fillStyle = COLORS.text;
          ctx.fillText((tr.note[si] > 0 ? '+' : '') + tr.note[si], x + (CELL - 2) / 2, y + hh / 2);
        }
        const rat = RATCHET[toReal(PARAM_BY_ID[mixId(ti, 'rat')], noteValue(ti, mixId(ti, 'rat'), si))];
        if (rat > 1) {
          // ratchet: one tick per hit along the bottom
          ctx.fillStyle = COLORS.text;
          const tw = (CELL - 6) / rat;
          for (let r = 0; r < rat; r++) ctx.fillRect(x + 2 + r * tw, y + hh - 4, Math.max(1, tw - 1), 2);
        }
        if (ids.some((id) => shaped(ti, id, si))) {
          // this note differs from the defaults somewhere
          ctx.fillStyle = COLORS.text;
          ctx.fillRect(x + CELL - 7, y + 2, 3, 3);
        }
      }

      // bar rows of the expanded track: one bar per note, height = value (the magnified one comes last, on top)
      subRows(ti).forEach((_, j) => {
        if (!isHot(ti, j) && rowH(ti, j) >= 1) drawRow(ctx, ti, j, first, last, x0, w);
      });
      ctx.globalAlpha = 1;
    }
    if (hot && hot.ti < TRACKS.length && hot.sub < subRows(hot.ti).length) {
      // the lens: a shadowed card over the neighbouring rows
      const top = lensTop(hot.ti, hot.sub);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, top + 3, w, HOT_H);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, top, w, HOT_H);
      drawRow(ctx, hot.ti, hot.sub, first, last, x0, w);
      ctx.strokeStyle = COLORS.line;
      ctx.strokeRect(0.5, top + 0.5, w - 1, HOT_H - 1);
    }
    ctx.textAlign = 'left';

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
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(t.phase * CELL - x0, 0, 2, H);
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
    playBtn.textContent = on ? '■ STOP' : '▶ PLAY';
  }

  /** Loop the selection, else the bar under the playhead; the same region again (or no selection) = off. */
  function toggleLoop() {
    const bar = Math.floor((t.playing ? t.phase : startStep) / STEPS_PER_BAR) * STEPS_PER_BAR;
    const want = sel ? { s0: sel.s0, s1: sel.s1 } : loop ? null : { s0: bar, s1: bar + STEPS_PER_BAR };
    loop = want && !(loop && sel && loop.s0 === want.s0 && loop.s1 === want.s1) ? want : null;
    sel = null;
    send({ t: 'loop', s0: loop?.s0 ?? 0, s1: loop?.s1 ?? 0 });
    loopBtn.classList.toggle('lit', !!loop);
    if (!loop) return;
    startStep = loop.s0;
    if (!t.playing) t.phase = startStep;
    // a loop behind the playhead would only come round after the song wraps: go there now
    else if (t.phase >= loop.s1) setPlaying(true);
  }

  function setRec(on: boolean) {
    t.rec = on;
    t.recStart = performance.now();
    if (on) startEngine(() => p).then(() => send({ t: 'rec', on: t.rec }));
    else send({ t: 'rec', on });
    recBtn.classList.toggle('lit', on);
    if (!on) recBtn.textContent = '● REC';
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

  function build() {
    const scrollLeft = scroller?.scrollLeft ?? 0;
    heads = [];
    subLabels = [];
    hot = null;
    names = [];
    root.innerHTML = '';

    // header
    const header = h('header');
    playBtn = button('▶ PLAY', 'btn', () => setPlaying(!t.playing));
    recBtn = button('● REC', 'btn rec', () => setRec(!t.rec));
    const fmtBtn = button(recorder.format.toUpperCase(), 'btn small', () => {
      recorder.setFormat(recorder.format === 'wav' ? 'mp3' : 'wav');
      fmtBtn.textContent = recorder.format.toUpperCase();
    });
    fmtBtn.title = 'REC saves as WAV (24-bit) or MP3 (320 kbps)';
    followBtn = button('FOLLOW', 'btn small lit', () => setFollow(!follow));
    followBtn.title = 'keep the playhead in view (F)';
    // fullscreen: the app fills the screen, no browser bars (Esc leaves)
    const fullBtn = button('⛶', 'btn small' + (document.fullscreenElement ? ' lit' : ''), () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    fullBtn.title = 'fullscreen';
    document.onfullscreenchange = () => fullBtn.classList.toggle('lit', !!document.fullscreenElement);
    loopBtn = button('LOOP', 'btn small' + (loop ? ' lit' : ''), toggleLoop);
    loopBtn.title = 'loop the selection, or the current bar (L)';
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
      h('div', 'logo', 'DUBBOX'),
      playBtn, recBtn, fmtBtn, followBtn, loopBtn,
      h('div', 'spacer'),
      fullBtn,
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
    const headCol = h('div', 'col');
    headCol.append(h('div', 'ruler-gap'));
    TRACKS.forEach((td, ti) => {
      const head = h('div', 'head');
      head.style.height = `${mainH}px`;
      const name = h('div', 'name', (ti === expanded ? '▾ ' : '▸ ') + td.name);
      name.title = td.global
        ? 'click = show the song-wide values (scale, key, tempo, FX)'
        : `click = show sound per note · hold ${THROW_KEYS[ti].slice(3)} = dub throw · ${ti + 1} = mute · shift+${ti + 1} = solo`;
      name.addEventListener('click', () => {
        toggleTrack(ti);
      });
      const toggles = h('div', 'toggles');
      if (!td.global) toggles.append(
        button('M', 'tog mute', () => { p.tracks[ti].mute = !p.tracks[ti].mute; flagsChanged(ti); }),
        button('S', 'tog solo', () => { p.tracks[ti].solo = !p.tracks[ti].solo; flagsChanged(ti); }),
      );
      head.append(name, toggles);
      headCol.append(head);
      heads.push(head);
      names.push(name);
      // each group: its name as vertical text down the left, its rows beside it
      let rows = headCol;
      subLabels[ti] = subRows(ti).map((id, j) => {
        const group = GROUP_AT[ti].get(j);
        if (group) {
          const box = h('div', 'subgroup');
          rows = h('div', 'subrows');
          box.append(h('div', 'groupname', group), rows);
          headCol.append(box);
        }
        const el = h('div', 'sublabel');
        el.append(h('div', 'subname', PARAM_BY_ID[id].label), h('div', 'subdesc', describe(id)));
        el.style.height = `${rowH(ti, j)}px`;
        el.style.paddingTop = `${gapH(ti, j)}px`;
        el.title = describe(id);
        rows.append(el);
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
    animateZoom(Math.min(0.1, (now - lastFrame) / 1000));
    lastFrame = now;
    if (t.playing) {
      const bpm = toReal(PARAM_BY_ID.tempo, noteValue(GLOBAL, 'tempo', Math.floor(t.phase)));
      t.phase = (t.enginePhase + (now - t.posAt) / 1000 / (60 / bpm / 4)) % SONG_STEPS;
      if (loop && t.enginePhase < loop.s1 && t.phase >= loop.s1) t.phase = loop.s0 + ((t.phase - loop.s1) % (loop.s1 - loop.s0));
      if (follow) scroller.scrollLeft = t.phase * CELL - scroller.clientWidth * 0.25;
    }
    drawTimeline();

    if (t.rec) {
      const s = Math.floor((now - t.recStart) / 1000);
      recBtn.textContent = `● ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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
    if (e.key === 'Alt') {
      e.preventDefault();
      altHeld = true;
      updateLens();
    }
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
    const digit = /^Digit([1-7])$/.exec(e.code);
    if (digit) {
      const i = +digit[1] - 1;
      if (e.shiftKey) p.tracks[i].solo = !p.tracks[i].solo;
      else p.tracks[i].mute = !p.tracks[i].mute;
      flagsChanged(i);
    }
    if (e.code === 'KeyF') setFollow(!follow);
    if (e.code === 'KeyL') toggleLoop();
    if (e.code === 'Minus') zoomBy(1 / 1.6);
    if (e.code === 'Equal') zoomBy(1.6);
    const ti = THROW_KEYS.indexOf(e.code);
    if (ti >= 0) setThrow(ti, true);
  });
  window.addEventListener('blur', () => {
    modHeld = false;
    altHeld = false;
    updateLens();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta' || e.key === 'Control') modHeld = false;
    if (e.key === 'Alt') {
      altHeld = false;
      updateLens();
    }
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
