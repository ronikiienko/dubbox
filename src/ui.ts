import { GLOBAL, PARAM_BY_ID, isLane, RATCHET, TRACKS, rowGroups, mixId, describe, pitchRange, fromIndex, lockIds, toIndex, toReal } from './params';
import {
  SONG_STEPS, STEPS_PER_BAR,
  type Project, type StepState, NO_LOCK, TRACK_VOL, audible,
  emptyProject,
} from './state';
import { UNTITLED, add, currentMeta, open, scheduleSave } from './library';
import { okToLeave, projectsOpen, showProjects } from './projects';
import { audioStream, onEngine, send, startEngine } from './engine/bridge';
import { Recorder, download } from './wav';
import type { FromExport, ToExport } from './offline/worker';
import { VideoRecorder } from './video';
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
  ['drag a note sideways', 'move it (all its values go with it)'],
  ['drag inside a selection', 'move the selection'],
  ['drag from an empty step', 'paint notes · right-drag = erase'],
  ['drag ↕ / wheel on step', 'pitch'],
  ['⌥-click step', 'slide: hold into the next note, glide to it'],
  ['⌥-drag →', 'held note (synths): from here to there'],
  ['click track name', 'per-note values (GLOBAL: tempo, FX…)'],
  ['drag in a value row', 'set · across = draw'],
  ['drag in a value row, then hold ⇧', 'ramp: a straight line from that note to the mouse'],
  ['dbl-click value', 'back to default'],
  ['click ruler', 'play from bar'],
  ['drag ruler / ⇧-drag', 'select bars / area'],
  ['L', 'loop selection / bar · again = off'],
  ['⌘C ⌘X ⌘V', 'copy / cut / paste at mouse'],
  ['⌘D', 'duplicate'],
  ['delete', 'clear selection'],
  ['D', 'dice selection / hovered'],
  ['⌘Z / ⇧⌘Z', 'undo / redo'],
  ['⌘O', 'projects'],
  ['trackpad swipe', 'scroll (up/down = tracks, sideways = song)'],
  ['mouse wheel', 'scroll the song · over a note = pitch'],
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
const SUB_H = 22; // per-note bar rows of an expanded track (dragging pops out a tall slider)
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

/** Blend two #rrggbb colours: k = 0 → a, 1 → b. */
function mix(a: string, b: string, k: number): string {
  const ch = (c: string, i: number) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k)).join(',')})`;
}

const GLOW_STEPS = 2; // a played note lights up, then fades over this many steps

// ---- UI -----------------------------------------------------------------

export function mountUI(root: HTMLElement, initial: Project) {
  let p = initial;

  // Transport mirror: the engine reports its phase ~30x/s, the UI extrapolates between reports.
  const t = { playing: false, phase: 0, enginePhase: 0, posAt: 0, rec: false, recStart: 0 };
  const recorder = new Recorder();
  const video = new VideoRecorder();
  const throws = new Set<number>();

  let heads: HTMLElement[] = [];
  let names: HTMLElement[] = [];
  let playBtn: HTMLButtonElement, recBtn: HTMLButtonElement, followBtn: HTMLButtonElement, loopBtn: HTMLButtonElement;
  let scroller: HTMLElement, canvas: HTMLCanvasElement;
  let startStep = 0; // where Play starts (set by clicking the ruler)
  let follow = localStorage.getItem('dubbox.follow') !== '0'; // keep the playhead in view while playing (only you turn it on)
  let CELL = CELL_MAX; // step width now: zoom glides it toward cellTarget
  let cellTarget = CELL_MAX;
  let zoomAt = 0; // px from the timeline's left edge that stays put while zooming…
  let zoomStep = 0; // …and the song position (in steps) pinned there
  let twoAxis = localStorage.getItem('dubbox.twoAxis') === '1'; // a trackpad was seen: wheel events scroll both ways
  let mouseX: number | null = null; // pointer over the timeline (px from its left edge)
  let loop: { s0: number; s1: number } | null = null; // playback repeats steps s0..s1 (exclusive)
  let expanded = -1; // track showing its per-note bar rows
  let closing = -1; // track whose rows are folding away (still drawn until they reach 0)
  let resizeObs: ResizeObserver | undefined;
  let help: HTMLElement, helpBtn: HTMLButtonElement, projectBtn: HTMLButtonElement;
  let helpOpen = false;
  let tracksEl: HTMLElement;
  let mainH = 52; // height of a track's main lane, fitted to the window
  let spacerEl: HTMLElement;
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
  // pressing in a value row pops a tall slider out of that note for as long as the drag lasts
  let slider: { ti: number; id: string; si: number; y0: number; idx0: number; cur: number; max: number; H: number; top: number } | null = null;
  let editRow: { ti: number; id: string; si: number } | null = null; // dragging in a value row: the note being set shows its number
  let ramp: { ti: number; id: string; si0: number; idx0: number; si1: number; idx1: number; orig: Uint8Array } | null = null;

  // ---- timeline ---------------------------------------------------------
  // One canvas for all lanes, virtualized: only the visible steps are drawn.

  /** Inside a held note (between a slid note and the next): a note added there keeps the hold going. */
  function heldAt(ti: number, si: number): 0 | 1 {
    const tr = p.tracks[ti];
    if (!TRACKS[ti].slide) return 0;
    let a = si - 1;
    while (a >= 0 && !tr.s[a]) a--;
    if (a < 0 || !tr.slide[a]) return 0;
    let b = si + 1;
    while (b < SONG_STEPS && !tr.s[b]) b++;
    return b < SONG_STEPS ? 1 : 0;
  }

  function setStep(ti: number, si: number, st: StepState, note: number, slide = st ? (p.tracks[ti].s[si] ? p.tracks[ti].slide[si] : heldAt(ti, si)) : 0) {
    const tr = p.tracks[ti];
    if (tr.s[si] === st && tr.note[si] === note && tr.slide[si] === slide) return;
    commitPending();
    if (st && !tr.s[si]) inheritLocks(ti, si);
    tr.s[si] = st;
    tr.note[si] = note;
    tr.slide[si] = slide;
    send({ t: 'step', i: ti, si, s: st, note, slide });
    // a removed note takes its locked values with it
    if (!st) for (const id of lockIds(ti)) if (!isLane(ti, id)) setLock(ti, id, si, NO_LOCK); // lanes aren't the note's
    scheduleSave(p);
  }

  function flagsChanged(i: number) {
    const tr = p.tracks[i];
    send({ t: 'flags', i, mute: tr.mute, solo: tr.solo, vol: tr.vol });
    p.tracks.forEach((_, j) => renderHead(j));
    scheduleSave(p);
  }

  function renderHead(ti: number) {
    const tr = p.tracks[ti];
    if (TRACKS[ti].global) return;
    heads[ti].classList.toggle('muted', !audible(p.tracks, ti));
    heads[ti].querySelector('.solo')!.classList.toggle('lit', tr.solo);
    heads[ti].querySelector('.mute')!.classList.toggle('lit', tr.mute);
    const fader = heads[ti].querySelector<HTMLElement>('.fader')!;
    fader.textContent = tr.vol > 0 ? '+' + tr.vol : tr.vol < 0 ? '−' + -tr.vol : '0';
    fader.classList.toggle('set', tr.vol !== 0);
    fader.style.setProperty('--f', String((tr.vol - TRACK_VOL.min) / (TRACK_VOL.max - TRACK_VOL.min)));
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
      case 'KeyO':
        openProjects();
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
        // a note's own values (lanes only when their row is hovered)
        const ids = onlyRow ? lockIds(ti).filter((id) => id === onlyRow) : lockIds(ti).filter((id) => TRACKS[ti].global || !isLane(ti, id));
        const single = region.s1 - region.s0 === 1;
        for (let si = region.s0; si < region.s1; si++) {
          for (const id of ids) {
            const lane = isLane(ti, id);
            if (!lane && (!tr.s[si] || ignored(ti, id, si))) continue;
            if (lane && !single && tr.locks[id][si] === NO_LOCK) continue;
            const d = PARAM_BY_ID[id];
            const step = Math.floor(Math.random() * 3) - 1;
            tr.locks[id][si] = clamp(toIndex(d, noteValue(ti, id, si)) + step, 0, d.positions - 1);
          }
        }
      }
    });
  }

  /**
   * Aim the zoom (it glides there over a few frames), around `ax` px from the timeline's left edge.
   * While following the playhead, it zooms around the playhead instead (follow keeps it in place).
   */
  function zoomBy(factor: number, ax = mouseX ?? scroller.clientWidth / 2) {
    if (follow && t.playing) ax = scroller.clientWidth * 0.25;
    // pin the song position under the anchor; mid-glide at the same spot the pin is already there
    if (CELL === cellTarget || ax !== zoomAt) zoomStep = (scroller.scrollLeft + ax) / CELL;
    zoomAt = ax;
    cellTarget = clamp(cellTarget * factor, CELL_MIN, CELL_MAX);
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

  /** The button / F: your choice is remembered; scrolling only switches it off for now. */
  function toggleFollow() {
    setFollow(!follow);
    localStorage.setItem('dubbox.follow', follow ? '1' : '0');
  }

  // ---- lane geometry ----------------------------------------------------
  // Each track has a main lane; the expanded track adds one bar row per lockable knob.

  const subRows = (ti: number) => (ti === expanded || ti === closing ? lockIds(ti) : []);
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
  /** Where a row's bars are. Bars fill pad..bottom. */
  const rowGeom = (ti: number, j: number) => {
    const top = subTop(ti, j), height = rowH(ti, j), pad = gapH(ti, j) + 2;
    return { top, height, pad, bottom: top + height - 2, span: height - pad - 2 };
  };
  const SLIDER_STEP = 12, SLIDER_MAX_H = 180, SLIDER_W = 28, SLIDER_LABEL = 16;
  /** Pop the slider out at note `si`, its value `idx` right at the mouse height `y`. */
  function openSlider(ti: number, id: string, si: number, y: number, idx: number) {
    const max = PARAM_BY_ID[id].positions - 1;
    const H = Math.min(SLIDER_MAX_H, max * SLIDER_STEP);
    // inside the part of the timeline you can see (the panel scrolls vertically)
    const view = tracksEl.getBoundingClientRect(), cv = canvas.getBoundingClientRect();
    const lo = Math.max(RULER_H, view.top - cv.top) + SLIDER_LABEL + 6;
    const hi = Math.min(totalH(), view.bottom - cv.top) - H - 8;
    const top = clamp(y - (1 - idx / max) * H, lo, Math.max(lo, hi));
    slider = { ti, id, si, y0: y, idx0: idx, cur: idx, max, H, top };
  }
  /** Mouse height → value on the slider: moves from where it was pressed, SLIDER_STEP px per position. */
  const sliderIdx = (y: number) => {
    const sl = slider!;
    return (sl.cur = clamp(Math.round(sl.idx0 + ((sl.y0 - y) * sl.max) / sl.H), 0, sl.max));
  };
  /** A value as the rows print it: 0–8, −4…+4 around the centre, a step's name, or bpm. */
  const valueLabel = (id: string, idx: number) => {
    const d = PARAM_BY_ID[id];
    const half = (d.positions - 1) / 2;
    return d.steps ? d.steps[idx] : d.id === 'tempo' ? String(Math.round(toReal(d, fromIndex(d, idx)))) : d.bipolar ? (idx > half ? '+' : '') + (idx - half) : String(idx);
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
   * Lanes share the panel's height, so the whole song fits without scrolling. An expanded track's
   * rows come off the top first; below ROW_MIN the panel scrolls.
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



  /** Per frame: ease every row's height toward its target. */
  function animateRows(_now: number, dt: number) {
    const k = 1 - Math.exp(-dt / 0.04); // ~120 ms to settle
    let changed = false;
    subLabels.forEach((labels, ti) => labels.forEach((el, j) => {
      const key = `${ti}:${j}`;
      const cur = rowAnim.get(key) ?? SUB_H;
      const target = ti === closing ? 0 : SUB_H;
      const next = Math.abs(target - cur) < 0.5 ? target : cur + (target - cur) * k;
      el.classList.toggle('hot', !!hover && hover.ti === ti && hover.sub === j); // the row under the mouse
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
    if (!isLane(ti, id)) return putLock(ti, id, si, v);
    // held rows store only changes: a value equal to the one already in force isn't one…
    let j = si - 1;
    while (j >= 0 && arr[j] === NO_LOCK) j--;
    let held = j >= 0 ? arr[j] : toIndex(PARAM_BY_ID[id], p.params[id]);
    putLock(ti, id, si, v === held ? NO_LOCK : v);
    if (arr[si] !== NO_LOCK) held = arr[si];
    // …and the next change after it may now repeat what's held: then it goes too
    for (let k = si + 1; k < SONG_STEPS; k++) {
      if (arr[k] === NO_LOCK) continue;
      if (arr[k] !== held) break;
      putLock(ti, id, k, NO_LOCK);
    }
  }

  function putLock(ti: number, id: string, si: number, v: number) {
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
    for (const id of lockIds(ti)) if (!isLane(ti, id)) setLock(ti, id, si, tr.locks[id][j]);
  }

  /**
   * Normalized value a note plays with for `id`: its lock, else the default.
   * GLOBAL and lanes aren't per note: a set value holds until the next set one.
   */
  const noteValue = (ti: number, id: string, si: number) => {
    const arr = p.tracks[ti].locks[id];
    let j = si;
    if (isLane(ti, id)) while (j > 0 && arr[j] === NO_LOCK) j--;
    const v = j >= 0 ? arr[j] : NO_LOCK;
    return v === NO_LOCK ? p.params[id] : fromIndex(PARAM_BY_ID[id], v);
  };

  /** A value the slide makes do nothing, so it's locked (gray, not editable, kept for when the slide goes):
   *  Decay of a note that slides on into a later note, Attack of a note slid into. */
  const ignored = (ti: number, id: string, si: number) => {
    const tr = p.tracks[ti];
    if (!TRACKS[ti].slide || !tr.s[si]) return false;
    if (id.endsWith('.atk')) {
      let k = si - 1;
      while (k >= 0 && !tr.s[k]) k--;
      return k >= 0 && !!tr.slide[k];
    }
    if (id.endsWith('.decay') && tr.slide[si]) {
      let e = si + 1;
      while (e < SONG_STEPS && !tr.s[e]) e++;
      return e < SONG_STEPS;
    }
    return false;
  };

  /** A note's value differs from the default (unset, or set to the default, both count as default). */
  const shaped = (ti: number, id: string, si: number) => {
    if (isLane(ti, id)) return false; // not the note's
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

    // main lane: click = toggle on/off · drag a note sideways = move it (with all its values) ·
    // drag from an empty step = paint · right-drag = erase · drag vertically = pitch
    let drag: { ti: number; si0: number; last: number; y: number; note: number; mode: 'pending' | 'paint' | 'note' | 'move'; paint: StepState; at: number; orig: Snapshot[number] | null } | null = null;
    // ⌥ on a synth lane: click = toggle slide · drag right = a held note (slid start → end note)
    // drag inside the selection = move it sideways (whole bars when it spans every track)
    let selMove: { ti: number; si0: number; base: Snapshot; region: Region; clip: Clip; delta: number; moved: boolean; bars: boolean } | null = null;
    let hold: { ti: number; si0: number; hi: number; orig: { s: Uint8Array; note: Int8Array; slide: Uint8Array } } | null = null;
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

    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right button erases
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        const { si, ti, sub } = hit(e);
        if (ti < 0 || sub >= 0 || TRACKS[ti].global) return;
        canvas.setPointerCapture(e.pointerId);
        sel = null;
        pending = snapshot(p);
        drag = { ti, si0: si, last: si, y: e.clientY, note: 0, mode: 'paint', paint: 0, at: si, orig: null };
        setStep(ti, si, 0, p.tracks[ti].note[si]);
        return;
      }
      if (e.button !== 0) return;
      const { si, ti, sub, rowTop, ruler } = hit(e);
      if (ruler || (e.shiftKey && ti >= 0 && sub < 0)) {
        canvas.setPointerCapture(e.pointerId);
        selDrag = { ruler, t0: ti, s0: si, ti, moved: false };
        if (!ruler) updateSel(si, ti);
        return;
      }
      if (ti < 0) return;
      if (sel && sub < 0 && !e.altKey && ti >= sel.t0 && ti <= sel.t1 && si >= sel.s0 && si < sel.s1) {
        canvas.setPointerCapture(e.pointerId);
        selMove = { ti, si0: si, base: snapshot(p), region: sel, clip: copy(p, sel), delta: 0, moved: false, bars: sel.t0 === 0 && sel.t1 === TRACKS.length - 1 };
        return;
      }
      sel = null;
      pending = snapshot(p);
      const tr = p.tracks[ti];
      if (sub >= 0) {
        const id = subRows(ti)[sub];
        if (ignored(ti, id, si)) {
          pending = null; // locked by the slide
          return;
        }
        canvas.setPointerCapture(e.pointerId);
        bars = { ti, sub, id, si0: si, last: si, y: e.clientY, idx0: toIndex(PARAM_BY_ID[id], noteValue(ti, id, si)), rowTop, mode: 'pending' };
        editRow = { ti, id, si };
        openSlider(ti, id, si, e.offsetY, bars.idx0);
        return;
      }
      if (TRACKS[ti].global) {
        // no notes on GLOBAL: its values are edited in its rows
        pending = null;
        return;
      }
      if (e.altKey) {
        if (!TRACKS[ti].slide) return;
        canvas.setPointerCapture(e.pointerId);
        hold = { ti, si0: si, hi: si, orig: { s: tr.s.slice(), note: tr.note.slice(), slide: tr.slide.slice() } };
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      drag = { ti, si0: si, last: si, y: e.clientY, note: tr.note[si], mode: 'pending', paint: (tr.s[si] ? 0 : 1) as StepState, at: si, orig: null };
    });
    canvas.addEventListener('pointermove', (e) => {
      mouseX = e.offsetX;
      const h0 = hit(e);
      // while the slider is out, nothing under it reacts: hover stays on the row being dragged in
      if (!slider) hover = h0.ti >= 0 ? { ti: h0.ti, si: h0.si, sub: h0.sub } : null;
      // over the selection: it can be picked up
      const overSel = !!sel && h0.sub < 0 && h0.ti >= sel.t0 && h0.ti <= sel.t1 && h0.si >= sel.s0 && h0.si < sel.s1;
      const locked = !slider && h0.ti >= 0 && h0.sub >= 0 && ignored(h0.ti, subRows(h0.ti)[h0.sub], h0.si);
      canvas.style.cursor = selMove?.moved ? 'grabbing' : overSel ? 'grab' : locked ? 'not-allowed' : '';
      if (selDrag) {
        if (h0.si !== selDrag.s0 || h0.ti !== selDrag.t0) selDrag.moved = true;
        if (selDrag.moved || !selDrag.ruler) updateSel(h0.si, h0.ti);
        return;
      }
      if (selMove) {
        const m = selMove;
        let delta = h0.si - m.si0;
        if (m.bars) delta = Math.round(delta / STEPS_PER_BAR) * STEPS_PER_BAR;
        delta = clamp(delta, -m.region.s0, SONG_STEPS - m.region.s1);
        if (delta === m.delta) return;
        if (!m.moved) pushUndo(m.base); // the whole move is one undo step
        m.moved = true;
        m.delta = delta;
        // from the song as it was: lift the selection out, put it down `delta` steps on
        restore(p, snapshot({ tracks: m.base } as unknown as Project));
        clear(p, m.region);
        sel = paste(p, m.clip, m.region.t0, m.region.s0 + delta);
        bulkChanged();
        return;
      }
      if (hold) {
        const to = Math.max(hold.si0, h0.si);
        if (to !== hold.hi) drawHold(to);
        return;
      }
      if (ramp) {
        const r = ramp;
        r.si1 = h0.si;
        if (editRow) editRow.si = h0.si; // the ramp's moving end
        r.idx1 = sliderIdx(e.offsetY);
        slider!.si = h0.si; // the slider rides the ramp's moving end
        drawRamp();
        return;
      }
      if (bars) {
        const b = bars;
        const { si } = hit(e);
        const tr = p.tracks[b.ti];
        if (e.shiftKey) {
          // ⇧ during the drag: a straight line from the pressed note, at the value set there, to the mouse
          ramp = { ti: b.ti, id: b.id, si0: b.si0, idx0: slider!.cur, si1: si, idx1: sliderIdx(e.offsetY), orig: tr.locks[b.id].slice() };
          slider!.si = si;
          bars = null;
          drawRamp();
          return;
        }
        if (b.mode === 'pending') {
          if (si !== b.si0) b.mode = 'draw';
          else if (Math.abs(b.y - e.clientY) > 4) b.mode = 'nudge';
        }
        if (b.mode === 'nudge' && (tr.s[b.si0] || isLane(b.ti, b.id))) {
          setLock(b.ti, b.id, b.si0, sliderIdx(e.offsetY));
        } else if (b.mode === 'draw') {
          const idx = sliderIdx(e.offsetY);
          slider!.si = si; // it follows the pen
          const lo = Math.min(b.last, si), hi = Math.max(b.last, si);
          for (let i = lo; i <= hi; i++) if ((tr.s[i] && !ignored(b.ti, b.id, i)) || isLane(b.ti, b.id)) setLock(b.ti, b.id, i, idx);
          b.last = si;
          if (editRow) editRow.si = si; // drawing: the note under the pen (a nudge keeps its own note)
        }
        return;
      }
      if (!drag) return;
      const { si } = hit(e);
      const d = drag;
      const tr = p.tracks[d.ti];
      if (d.mode === 'pending') {
        if (si !== d.si0 && tr.s[d.si0]) {
          // started on a note: pick it up
          d.mode = 'move';
          d.orig = { s: tr.s.slice(), note: tr.note.slice(), slide: tr.slide.slice(), locks: Object.fromEntries(Object.entries(tr.locks).map(([id, a]) => [id, a.slice()])) };
        } else if (si !== d.si0) {
          d.mode = 'paint';
          setStep(d.ti, d.si0, d.paint, tr.note[d.si0]);
        } else if (Math.abs(d.y - e.clientY) > 5) {
          d.mode = 'note';
        }
      }
      if (d.mode === 'move') {
        const to = clamp(si, 0, SONG_STEPS - 1);
        if (to !== d.at) moveNote(to);
      } else if (d.mode === 'paint' && si !== d.last) {
        const dir = si > d.last ? 1 : -1;
        for (let i = d.last + dir; i !== si + dir; i += dir) setStep(d.ti, i, d.paint, tr.note[i]);
        d.last = si;
      } else if (d.mode === 'note') {
        const note = clamp(d.note + Math.round((d.y - e.clientY) / 8), -pitchRange(d.ti), pitchRange(d.ti));
        setStep(d.ti, d.si0, (tr.s[d.si0] || 1) as StepState, note);
      }
    });
    /** Carry the picked-up note to `to`: notes it passes over come back, the one it lands on is replaced. */
    const moveNote = (to: number) => {
      const d = drag!;
      const o = d.orig!;
      const put = (k: number, from: number) => {
        setStep(d.ti, k, o.s[from] as StepState, o.note[from], o.slide[from]);
        for (const id of lockIds(d.ti)) if (!isLane(d.ti, id)) setLock(d.ti, id, k, o.locks[id][from]); // lane points stay put
      };
      put(d.at, d.at); // the step it was over gets its own note back (or stays empty)
      if (d.at !== d.si0) put(d.si0, d.si0);
      d.at = to;
      if (to === d.si0) return;
      setStep(d.ti, d.si0, 0, 0);
      put(to, d.si0);
    };

    /** Put back what the last frame of the held-note drag changed, then hold from the start to `to`. */
    const drawHold = (to: number) => {
      const d = hold!;
      const o = d.orig;
      for (let i = d.si0; i <= d.hi; i++) setStep(d.ti, i, o.s[i] as StepState, o.note[i], o.slide[i]);
      d.hi = to;
      if (to === d.si0) return;
      const note = o.note[d.si0];
      setStep(d.ti, d.si0, 1, note, 1);
      // notes it passes over become points of the hold: their values are where it glides through
      for (let i = d.si0 + 1; i < to; i++) if (o.s[i]) setStep(d.ti, i, 1, o.note[i], 1);
      setStep(d.ti, to, 1, o.s[to] ? o.note[to] : note, o.s[to] ? o.slide[to] : 0);
    };

    /** Put back what the last frame of the ramp overwrote, then lay the line over the notes it spans. */
    let rampLo = 0, rampHi = -1;
    const drawRamp = () => {
      const r = ramp!;
      const tr = p.tracks[r.ti];
      for (let i = rampLo; i <= rampHi; i++) setLock(r.ti, r.id, i, r.orig[i]);
      rampLo = Math.min(r.si0, r.si1);
      rampHi = Math.max(r.si0, r.si1);
      const len = r.si1 - r.si0;
      const lane = isLane(r.ti, r.id); // lanes: every step on the line gets its point
      for (let i = rampLo; i <= rampHi; i++) {
        if ((!tr.s[i] || ignored(r.ti, r.id, i)) && !lane) continue;
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
      if (selMove && !selMove.moved) {
        // a click inside the selection: drop it and click the step as usual
        const { ti, si0 } = selMove;
        const tr = p.tracks[ti];
        sel = null;
        if (!TRACKS[ti].global) {
          pending = snapshot(p);
          setStep(ti, si0, (tr.s[si0] ? 0 : 1) as StepState, tr.note[si0]);
        }
      }
      selMove = null;
      if (hold && hold.hi === hold.si0) {
        // ⌥-click: toggle slide (turns the step on if needed)
        const tr = p.tracks[hold.ti];
        setStep(hold.ti, hold.si0, (tr.s[hold.si0] || 1) as StepState, tr.note[hold.si0], tr.slide[hold.si0] ? 0 : 1);
      }
      hold = null;
      if (drag?.mode === 'pending') {
        const tr = p.tracks[drag.ti];
        setStep(drag.ti, drag.si0, drag.paint, tr.note[drag.si0]);
      }
      drag = null;
      bars = null;
      ramp = null;
      editRow = null;
      slider = null;
      pending = null;
    };
    canvas.addEventListener('pointerleave', () => {
      hover = null;
      mouseX = null;
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
      if (ti >= 0 && sub >= 0 && !ignored(ti, subRows(ti)[sub], si)) {
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
      // A trackpad scrolls in two directions: up/down = the panel, sideways = the song. Its first
      // sideways scroll without ⇧ gives it away (remembered). A plain mouse wheel scrolls the song.
      if (e.deltaX !== 0 && !e.shiftKey && !twoAxis) {
        twoAxis = true;
        localStorage.setItem('dubbox.twoAxis', '1');
      }
      e.preventDefault();
      if (twoAxis) {
        // both directions at once, like a native view
        if (e.deltaX !== 0) {
          setFollow(false);
          scroller.scrollLeft += e.deltaX;
        }
        tracksEl.scrollTop += e.deltaY;
        return;
      }
      const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey;
      if (vertical && e.target === canvas) {
        // mouse wheel over a note = its pitch
        const { si, ti, sub } = hit(e);
        const tr = ti >= 0 ? p.tracks[ti] : null;
        if (tr && sub < 0 && tr.s[si] && !TRACKS[ti].global) {
          setStep(ti, si, tr.s[si] as StepState, clamp(tr.note[si] + (e.deltaY < 0 ? 1 : -1), -pitchRange(ti), pitchRange(ti)));
          return;
        }
      }
      setFollow(false);
      scroller.scrollLeft += vertical ? e.deltaY : e.deltaX;
    }, { passive: false });

    return scroller;
  }

  /** How lit a note at step `si` is right now: 1 the moment the playhead hits it, fading to 0. */
  const glow = (ti: number, si: number) => {
    if (!t.playing || !audible(p.tracks, ti)) return 0;
    const d = t.phase - si;
    return d >= 0 && d < GLOW_STEPS ? (1 - d / GLOW_STEPS) ** 2 : 0;
  };

  /** One value row of a track: a bar per note, in its slot or (magnified) in the lens. */
  function drawRow(ctx: CanvasRenderingContext2D, ti: number, j: number, first: number, last: number, x0: number, w: number) {
    const tr = p.tracks[ti];
    const id = lockIds(ti)[j];
    const g = isLane(ti, id); // GLOBAL and lanes: values on any step, held (drawn as one continuous fill)
    const d = PARAM_BY_ID[id];
    const gm = rowGeom(ti, j);
    const rowTop = gm.top, height = gm.height;
    // rows unfolding / folding are shorter than their bars: clip to the row
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rowTop, w, height);
    ctx.clip();
    const { pad, span, bottom } = gm;
    // one number: the note under the mouse, in the row under it (or the row being dragged in)
    const showValues = editRow ? editRow.ti === ti && editRow.id === id : !!hover && hover.ti === ti && hover.sub === j;
    const shownAt = slider ? -1 : editRow ? editRow.si : hover?.si ?? -1; // dragging: the slider shows it
    const labels: [string, number, boolean][] = [];
    const inset = CELL >= 11 ? 4 : CELL >= 4 ? 1 : 0;
    const gap = gapH(ti, j);
    if (j % 2 === 0) {
      // every other row a shade lighter: each row reads as its own band, its bars inside it
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(0, rowTop + gap, w, height - gap);
    }
    if (gap) {
      // group divider
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(0, rowTop, w, 1);
    }
    ctx.fillStyle = COLORS.cell;
    ctx.fillRect(0, rowTop + height - 1, w, 1);
    const arr = tr.locks[id];
    let held = g ? noteValue(ti, id, first) : 0;
    // slides make some values do nothing: Decay of a note that slides on, Attack of a note slid into
    const isDecay = id.endsWith('.decay') && TRACKS[ti].slide, isAtk = id.endsWith('.atk');
    let prev = first - 1;
    while (isAtk && prev >= 0 && !tr.s[prev]) prev--;
    let slidInto = isAtk && prev >= 0 && !!tr.slide[prev];
    // notes: a bar whose value differs from the previous note's (the first note: from the default) is amber
    let lastIdx = toIndex(d, d.defN);
    if (!g) for (let k = first - 1; k >= 0; k--) if (tr.s[k]) { lastIdx = toIndex(d, noteValue(ti, id, k)); break; }
    for (let si = first; si <= last; si++) {
      if (!g && !tr.s[si]) continue; // notes only (GLOBAL and lanes: every step)
      let unused = false;
      if (isAtk) {
        unused = slidInto;
        slidInto = !!tr.slide[si];
      } else if (isDecay && tr.slide[si]) {
        let e = si + 1;
        while (e < SONG_STEPS && !tr.s[e]) e++;
        unused = e < SONG_STEPS; // it holds into a later note
      }
      const locked = arr[si] !== NO_LOCK;
      if (g && locked) held = fromIndex(d, arr[si]);
      const n = g ? held : noteValue(ti, id, si);
      const x = si * CELL - x0;
      // GLOBAL: set here = bright, held from earlier = dim · notes: every value looks the same
      const lit = g ? 0 : glow(ti, si);
      ctx.fillStyle = !g ? (unused ? COLORS.line : lit ? mix(COLORS.bar, '#ffffff', lit) : COLORS.bar) : locked ? COLORS.text : COLORS.line;
      if (!g) {
        // a different value from the previous note's: the whole bar amber
        const idx = toIndex(d, n);
        if (idx !== lastIdx && !unused) ctx.fillStyle = lit ? mix(COLORS.accent, '#ffffff', lit) : COLORS.accent;
        lastIdx = idx;
      }
      if (d.bipolar) {
        // grows up/down from the centre line (e.g. Pan: up = right, down = left)
        const mid = rowTop + pad + span / 2;
        const bh = Math.max(2, Math.abs(n - 0.5) * span);
        ctx.fillRect(g ? x : x + inset, n >= 0.5 ? mid - bh : mid, g ? CELL : CELL - 2 * inset, bh);
      } else {
        const bh = Math.max(2, n * span);
        if (unused && CELL - 2 * inset >= 4) {
          // locked by the slide: an empty outline, the value kept for when the slide goes
          ctx.strokeStyle = COLORS.dim;
          ctx.strokeRect(x + inset + 0.5, bottom - bh + 0.5, CELL - 2 * inset - 1, bh - 1);
        } else ctx.fillRect(g ? x : x + inset, bottom - bh, g ? CELL : CELL - 2 * inset, bh); // GLOBAL: one continuous fill
      }
      if (showValues && si === shownAt) {
        // position as a number: 0–8, or −4…+4 around the centre for bipolar values
        const label = unused ? (isAtk ? 'locked: slid into' : 'locked: slides on') : valueLabel(id, toIndex(d, n));
        labels.push([label, si, (!g && !unused) || locked]);
      }
    }
    // on a small dark tag along the top, over the bars
    for (const [label, si, bright] of labels) {
      const tw = ctx.measureText(label).width;
      // centred on its note, but kept fully on screen at the edges
      const cx = clamp(si * CELL - x0 + CELL / 2, tw / 2 + 3, w - tw / 2 - 3);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(cx - tw / 2 - 2, rowTop + gap + 1, tw + 4, 12);
      ctx.fillStyle = bright ? COLORS.text : COLORS.dim;
      ctx.fillText(label, cx, rowTop + gap + 7);
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
        const lit = st ? glow(ti, si) : 0;
        ctx.fillStyle = lit ? mix(COLORS.accentDim, '#ffc566', lit) : st ? COLORS.accentDim : si % 4 === 0 && CELL >= 4 ? COLORS.beat : COLORS.cell;
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

      // held notes: a slid note draws a band to the next note, where it glides; lit while it sounds
      let si = first;
      while (si > 0 && !tr.s[si]) si--; // a hold may start off-screen to the left
      for (; TRACKS[ti].slide && si <= last; si++) {
        if (!tr.s[si] || !tr.slide[si]) continue;
        let e = si + 1;
        while (e < SONG_STEPS && !tr.s[e]) e++;
        if (e >= SONG_STEPS || e === si + 1) continue; // nothing to hold into / next step (its tie mark shows it)
        const held = t.playing && audible(p.tracks, ti) && t.phase >= si && t.phase < e;
        ctx.fillStyle = held ? mix(COLORS.accentDim, '#ffc566', 0.4) : COLORS.accentDim;
        const xa = Math.round((si + 1) * CELL - x0), xb = Math.round(e * CELL - x0) - (CELL >= 6 ? 1 : 0);
        ctx.fillRect(xa - (CELL >= 6 ? 1 : 0), y + hh * 0.3, xb - xa + (CELL >= 6 ? 1 : 0), hh * 0.4);
        si = e - 1;
      }

      // bar rows of the expanded track: one bar per note, height = value
      subRows(ti).forEach((_, j) => {
        if (rowH(ti, j) >= 1) drawRow(ctx, ti, j, first, last, x0, w);
      });
      ctx.globalAlpha = 1;
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
    if (slider) drawSlider(ctx, x0, w);
  }

  /** The popped-out slider: a tall rail with a tick per position, the value as a bar, its number on top. */
  function drawSlider(ctx: CanvasRenderingContext2D, x0: number, w: number) {
    const sl = slider!;
    const d = PARAM_BY_ID[sl.id];
    const cx = clamp(sl.si * CELL - x0 + CELL / 2, SLIDER_W / 2 + 2, w - SLIDER_W / 2 - 2);
    const left = cx - SLIDER_W / 2, top = sl.top, bottom = sl.top + sl.H;
    const yOf = (idx: number) => top + (1 - idx / sl.max) * sl.H;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(left + 3, top - 6 + 4, SLIDER_W, sl.H + 12);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(left, top - 6, SLIDER_W, sl.H + 12);
    ctx.strokeStyle = COLORS.dim;
    ctx.strokeRect(left + 0.5, top - 6 + 0.5, SLIDER_W - 1, sl.H + 11);
    if (sl.max <= 16) {
      ctx.fillStyle = COLORS.line;
      for (let k = 0; k <= sl.max; k++) ctx.fillRect(left + 3, Math.round(yOf(k)), SLIDER_W - 6, 1);
    }
    ctx.fillStyle = COLORS.bar;
    const yv = yOf(sl.cur);
    if (d.bipolar) {
      const mid = yOf(sl.max / 2);
      ctx.fillRect(left + 7, Math.min(yv, mid) - 1, SLIDER_W - 14, Math.max(2, Math.abs(mid - yv) + 2));
    } else {
      ctx.fillRect(left + 7, yv - 1, SLIDER_W - 14, Math.max(2, bottom - yv + 2));
    }
    // the number, on a tag above the rail
    const label = valueLabel(sl.id, sl.cur);
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(label).width;
    const lx = clamp(cx, tw / 2 + 3, w - tw / 2 - 3);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(lx - tw / 2 - 3, top - 6 - SLIDER_LABEL + 1, tw + 6, SLIDER_LABEL - 2);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(label, lx, top - 6 - SLIDER_LABEL / 2 + 1);
    ctx.textAlign = 'left';
  }

  // ---- transport --------------------------------------------------------

  function setPlaying(on: boolean) {
    t.playing = on;
    t.phase = t.enginePhase = startStep;
    t.posAt = performance.now();
    if (on) {
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
    if (recorder.format === 'video') return setVideoRec(on);
    recLit(on);
    if (on) startEngine(() => p).then(() => send({ t: 'rec', on: t.rec }));
    else send({ t: 'rec', on });
  }

  function recLit(on: boolean) {
    t.rec = on;
    t.recStart = performance.now();
    recBtn.classList.toggle('lit', on);
    if (!on) recBtn.textContent = '● REC';
  }

  /** VIDEO: the browser asks which screen/tab to share (pick this tab), then it records with the app's sound. */
  async function setVideoRec(on: boolean) {
    if (!on) {
      video.stop();
      recLit(false);
      return;
    }
    // both asked for inside the click: the share prompt and the audio engine need the gesture
    const ok = await video.start(startEngine(() => p).then(audioStream), () => recLit(false));
    if (ok) recLit(true);
  }

  function setThrow(i: number, on: boolean) {
    if (on) throws.add(i);
    else throws.delete(i);
    names[i].classList.toggle('throw', on);
    send({ t: 'throw', i, on });
  }

  // ---- layout -----------------------------------------------------------

  /** Track fader: drag up/down (1 dB per 4 px), wheel ±1 dB, double-click = 0 dB. */
  function fader(ti: number) {
    const el = h('div', 'fader');
    el.title = 'track volume, dB: the whole track with its echoes · drag up/down · double-click = 0';
    const set = (db: number) => {
      const v = clamp(Math.round(db), TRACK_VOL.min, TRACK_VOL.max);
      if (v === p.tracks[ti].vol) return;
      p.tracks[ti].vol = v;
      flagsChanged(ti);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY, v0 = p.tracks[ti].vol;
      const move = (ev: PointerEvent) => set(v0 + (y0 - ev.clientY) / 4);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => set(0));
    let acc = 0; // trackpads send many small deltas: 1 dB per ~30 px of scroll
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      acc -= e.deltaY;
      if (Math.abs(acc) < 30 && Math.abs(e.deltaY) < 30) return;
      set(p.tracks[ti].vol + Math.sign(acc));
      acc = 0;
    }, { passive: false });
    return el;
  }

  function button(label: string, cls: string, onClick: () => void) {
    const b = h('button', cls, label);
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- projects ---------------------------------------------------------

  /** Show another song: stop, forget this one's undo history, selection and loop. */
  function switchTo(next: Project) {
    if (t.playing) setPlaying(false);
    p = next;
    undoStack.length = 0;
    redoStack = [];
    pending = null;
    sel = null;
    loop = null;
    startStep = 0;
    t.phase = t.enginePhase = 0;
    send({ t: 'init', project: p });
    send({ t: 'loop', s0: 0, s1: 0 });
    build();
    scroller.scrollLeft = 0;
  }

  function openProjects() {
    showProjects({
      open: async (id) => {
        if (await okToLeave()) switchTo(await open(id));
      },
      create: async () => {
        if (await okToLeave()) switchTo(await open((await add(UNTITLED, emptyProject(), Date.now(), true)).id));
      },
      renamed: () => (projectBtn.textContent = currentMeta().name),
    });
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
    names = [];
    root.innerHTML = '';

    // header
    const header = h('header');
    playBtn = button('▶ PLAY', 'btn', () => setPlaying(!t.playing));
    recBtn = button('● REC', 'btn rec', () => setRec(!t.rec));
    const fmtBtn = button(recorder.format.toUpperCase(), 'btn small', () => {
      if (t.rec) return; // not mid-recording
      recorder.setFormat(recorder.format === 'wav' ? 'mp3' : recorder.format === 'mp3' ? 'video' : 'wav');
      fmtBtn.textContent = recorder.format.toUpperCase();
    });
    fmtBtn.title = 'REC saves as WAV (24-bit), MP3 (320 kbps) or VIDEO (screen + the app\'s sound; pick this tab when asked)';
    // EXPORT: the whole song rendered offline (faster than realtime, nothing has to play)
    const exportBtn = button('EXPORT', 'btn small', () => {
      if (exportBtn.classList.contains('lit')) return; // already rendering
      const format = recorder.format === 'mp3' ? 'mp3' : 'wav';
      const w = new Worker(new URL('./offline/worker.ts', import.meta.url), { type: 'module' });
      exportBtn.classList.add('lit');
      w.onmessage = (e: MessageEvent<FromExport>) => {
        const m = e.data;
        if (m.t === 'progress') exportBtn.textContent = m.f >= 1 ? 'ENCODING' : `EXPORT ${Math.floor(m.f * 100)}%`;
        else {
          download(m.data, m.type, m.ext);
          w.terminate();
          exportBtn.classList.remove('lit');
          exportBtn.textContent = 'EXPORT';
        }
      };
      w.postMessage({ project: p, format } satisfies ToExport);
    });
    exportBtn.title = 'render the whole song to a file without playing it (MP3 when the REC format is MP3, else WAV)';
    followBtn = button('FOLLOW', follow ? 'btn small lit' : 'btn small', () => toggleFollow());
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
    projectBtn = button(currentMeta().name, 'btn small project-btn', openProjects);
    projectBtn.title = 'projects: open, rename, copy, export (⌘O)';
    header.append(
      h('div', 'logo', 'DUBBOX'),
      playBtn, recBtn, fmtBtn, exportBtn, followBtn, loopBtn,
      h('div', 'spacer'),
      fullBtn,
      helpBtn = button('?', 'btn small help-btn', () => setHelp(!helpOpen)),
      projectBtn,
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
        fader(ti),
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
    if (projectsOpen()) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) setPlaying(!t.playing);
      return;
    }
    if (e.key === 'Meta' || e.key === 'Control') modHeld = true;
    if (e.key === 'Alt') e.preventDefault(); // no browser menu focus: ⌥ is for slides
    if ((e.metaKey || e.ctrlKey) && editKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape') {
      sel = null;
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
    if (e.code === 'KeyF') toggleFollow();
    if (e.code === 'KeyL') toggleLoop();
    if (e.code === 'Minus') zoomBy(1 / 1.6);
    if (e.code === 'Equal') zoomBy(1.6);
    const ti = THROW_KEYS.indexOf(e.code);
    if (ti >= 0) setThrow(ti, true);
  });
  window.addEventListener('blur', () => {
    modHeld = false;
  });
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
