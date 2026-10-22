import { PARAM_BY_ID, TRACKS, formatParam, fromIndex, lockIds, mixId, snap, toIndex, toReal } from './params';
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

// Knob arc: 270° sweep, angle measured clockwise from 12 o'clock.
const R = 15, C = 20;
const angle = (n: number) => ((-135 + 270 * n) * Math.PI) / 180;
const pt = (n: number) => [C + R * Math.sin(angle(n)), C - R * Math.cos(angle(n))];
function arc(from: number, to: number): string {
  if (to - from < 0.002) return '';
  const [x0, y0] = pt(from), [x1, y1] = pt(to);
  return `M${x0},${y0} A${R},${R} 0 ${(to - from) * 270 > 180 ? 1 : 0} 1 ${x1},${y1}`;
}

const THROW_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT'];

// timeline geometry (px)
const CELL = 22;
const ROW_H = 52;
const RULER_H = 20;
const PAD = 9;
const SUB_H = 22; // per-note bar rows of an expanded track
const COLORS = {
  bg: '#0d0d0c',
  cell: '#1f1e1b',
  beat: '#292824',
  line: '#3a3833',
  dim: '#5d5a53',
  text: '#d9d4c7',
  accent: '#e8a33d',
  accentDim: '#6b4d22',
};

// ---- UI -----------------------------------------------------------------

interface KnobView {
  id: string;
  el: HTMLElement;
  val: SVGPathElement;
  dot: SVGCircleElement;
  label: HTMLElement;
  hover: boolean;
  active: boolean;
}

export function mountUI(root: HTMLElement, initial: Project) {
  let p = initial;

  // Transport mirror: the engine reports its phase ~30x/s, the UI extrapolates between reports.
  const t = { playing: false, phase: 0, enginePhase: 0, posAt: 0, rec: false, recStart: 0 };
  const recorder = new Recorder();
  const throws = new Set<number>();

  let knobs: KnobView[] = [];
  let heads: HTMLElement[] = [];
  let names: HTMLElement[] = [];
  let playBtn: HTMLButtonElement, recBtn: HTMLButtonElement, followBtn: HTMLButtonElement;
  let scroller: HTMLElement, canvas: HTMLCanvasElement;
  let startStep = 0; // where Play starts (set by clicking the ruler)
  let follow = true; // keep the playhead in view while playing
  let expanded = -1; // track showing its per-note bar rows
  let resizeObs: ResizeObserver | undefined;

  // selection, clipboard, undo
  let sel: Region | null = null;
  let clip: Clip | null = null;
  let hover: { ti: number; si: number; sub: number } | null = null; // step (and bar row) under the mouse
  let modHeld = false; // ⌘/Ctrl down: show where a paste would land
  const undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let pending: Snapshot | null = null; // taken at gesture start, committed on its first real change

  // Value the engine hears right now: the knob value, overridden by dub throws.
  function live(id: string): number {
    if (throws.size && [...throws].some((i) => mixId(i, 'dly') === id)) return 1;
    return p.params[id];
  }

  function setParam(id: string, n: number) {
    p.params[id] = n;
    send({ t: 'param', id, v: n });
    scheduleSave(p);
  }

  // ---- knob -------------------------------------------------------------

  function knob(id: string): HTMLElement {
    const def = PARAM_BY_ID[id];
    const el = h('div', 'knob');
    el.innerHTML =
      `<svg viewBox="0 0 40 40"><path class="track" d="${arc(0, 1)}"/><path class="val"/>` +
      `<circle class="dot" r="2.6"/></svg><div class="klabel"></div>`;
    const kv: KnobView = {
      id, el,
      val: el.querySelector('.val')!,
      dot: el.querySelector('.dot')!,
      label: el.querySelector('.klabel')!,
      hover: false,
      active: false,
    };
    knobs.push(kv);

    let lastY = 0, n = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      lastY = e.clientY;
      kv.active = true;
      n = p.params[id];
    });
    el.addEventListener('pointermove', (e) => {
      if (!kv.active) return;
      n = clamp(n + (lastY - e.clientY) / (e.shiftKey ? 900 : 180));
      lastY = e.clientY;
      setParam(id, snap(def, n));
    });
    const end = () => (kv.active = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => setParam(id, def.defN));
    el.addEventListener('pointerenter', () => (kv.hover = true));
    el.addEventListener('pointerleave', () => (kv.hover = false));
    el.title = `${def.label} · drag (shift = fine) · dbl-click reset`;
    return el;
  }

  function renderKnob(kv: KnobView) {
    const def = PARAM_BY_ID[kv.id];
    const base = p.params[kv.id];
    const v = live(kv.id);
    kv.val.setAttribute('d', def.bipolar ? arc(Math.min(base, 0.5), Math.max(base, 0.5)) : arc(0, base));
    const [x, y] = pt(v);
    kv.dot.setAttribute('cx', String(x));
    kv.dot.setAttribute('cy', String(y));
    kv.el.classList.toggle('moving', v !== base);
    kv.label.textContent = kv.hover || kv.active ? formatParam(def, v) : def.label;
  }

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
        for (let si = region.s0; si < region.s1; si++) {
          if (!tr.s[si]) continue;
          for (const id of ids) {
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
  // Each track has a main lane; the expanded track adds one bar row per lockable knob.

  const subRows = (ti: number) => (ti === expanded ? lockIds(ti) : []);
  const laneH = (ti: number) => ROW_H + subRows(ti).length * SUB_H;
  const laneTop = (ti: number) => {
    let y = RULER_H;
    for (let i = 0; i < ti; i++) y += laneH(i);
    return y;
  };
  const totalH = () => laneTop(TRACKS.length);

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

  /** Normalized value a note plays with for `id`: its lock, else the default. */
  const noteValue = (ti: number, id: string, si: number) => {
    const v = p.tracks[ti].locks[id][si];
    return v === NO_LOCK ? p.params[id] : fromIndex(PARAM_BY_ID[id], v);
  };

  function timeline(): HTMLElement {
    scroller = h('div', 'scroller');
    const spacer = h('div', 'spacer');
    spacer.style.width = `${SONG_STEPS * CELL}px`;
    spacer.style.height = `${totalH()}px`;
    canvas = h('canvas');
    spacer.append(canvas);
    scroller.append(spacer);

    resizeObs?.disconnect();
    resizeObs = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = scroller.clientWidth, hh = totalH();
      canvas.width = w * dpr;
      canvas.height = hh * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hh}px`;
      canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    resizeObs.observe(scroller);

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
        if (y < top + ROW_H) return { si, ti, sub: -1, rowTop: top, ruler: false };
        const rows = subRows(ti).length;
        if (y < top + ROW_H + rows * SUB_H) {
          const sub = Math.floor((y - top - ROW_H) / SUB_H);
          return { si, ti, sub, rowTop: top + ROW_H + sub * SUB_H, ruler: false };
        }
      }
      return { si, ti: -1, sub: -1, rowTop: 0, ruler: false };
    };

    // main lane: click = toggle on/off · drag sideways = paint · drag vertically = pitch
    let drag: { ti: number; si0: number; last: number; y: number; note: number; mode: 'pending' | 'paint' | 'note'; paint: StepState } | null = null;
    // bar rows: drag up/down = that note's value · drag sideways = draw across notes (absolute height)
    let bars: { ti: number; id: string; si0: number; last: number; y: number; idx0: number; rowTop: number; mode: 'pending' | 'nudge' | 'draw' } | null = null;

    const idxFromY = (id: string, y: number, rowTop: number) => {
      const d = PARAM_BY_ID[id];
      const n = clamp(1 - (y - rowTop - 2) / (SUB_H - 4));
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
      if (sub >= 0) {
        const id = subRows(ti)[sub];
        canvas.setPointerCapture(e.pointerId);
        bars = { ti, id, si0: si, last: si, y: e.clientY, idx0: toIndex(PARAM_BY_ID[id], noteValue(ti, id, si)), rowTop, mode: 'pending' };
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
          const idx = idxFromY(b.id, e.offsetY, b.rowTop);
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
        const note = clamp(d.note + Math.round((d.y - e.clientY) / 8), -12, 12);
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
      if (ti >= 0 && sub >= 0) {
        pending = snapshot(p);
        setLock(ti, subRows(ti)[sub], si, NO_LOCK);
        pending = null;
      }
    });

    // Vertical wheel over an active step = note. Otherwise wheel scrolls the timeline.
    scroller.addEventListener('wheel', (e) => {
      const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey;
      if (vertical && e.target === canvas) {
        const { si, ti, sub } = hit(e);
        const tr = ti >= 0 ? p.tracks[ti] : null;
        if (tr && sub < 0 && tr.s[si]) {
          e.preventDefault();
          setStep(ti, si, tr.s[si] as StepState, clamp(tr.note[si] + (e.deltaY < 0 ? 1 : -1), -12, 12));
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

  function drawTimeline() {
    const ctx = canvas.getContext('2d')!;
    const w = scroller.clientWidth;
    const x0 = scroller.scrollLeft;
    const first = Math.floor(x0 / CELL);
    const last = Math.min(SONG_STEPS - 1, Math.ceil((x0 + w) / CELL));
    const H = totalH();
    ctx.clearRect(0, 0, w, H);

    // ruler: bar numbers + start marker
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let b = Math.floor(first / STEPS_PER_BAR); b * STEPS_PER_BAR <= last; b++) {
      const x = b * STEPS_PER_BAR * CELL - x0;
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(String(b + 1), x + 4, RULER_H / 2);
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
    ctx.font = '9px ui-monospace, Menlo, monospace';
    for (let ti = 0; ti < TRACKS.length; ti++) {
      const tr = p.tracks[ti];
      const top = laneTop(ti);
      const y = top + PAD;
      const hh = ROW_H - PAD * 2;
      const ids = lockIds(ti);
      ctx.globalAlpha = audible(p.tracks, ti) ? 1 : 0.3;
      for (let si = first; si <= last; si++) {
        const st = tr.s[si];
        const x = si * CELL - x0 + 1;
        ctx.fillStyle = st ? COLORS.accentDim : si % 4 === 0 ? COLORS.beat : COLORS.cell;
        ctx.fillRect(x, y, CELL - 2, hh);
        if (!st) continue;
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

      // bar rows of the expanded track: one bar per note, height = value
      subRows(ti).forEach((id, j) => {
        const rowTop = top + ROW_H + j * SUB_H;
        ctx.fillStyle = COLORS.cell;
        ctx.fillRect(0, rowTop + SUB_H - 1, w, 1);
        const arr = tr.locks[id];
        for (let si = first; si <= last; si++) {
          if (!tr.s[si]) continue;
          const locked = arr[si] !== NO_LOCK;
          const n = noteValue(ti, id, si);
          const span = SUB_H - 4;
          ctx.fillStyle = locked ? COLORS.text : COLORS.line;
          if (PARAM_BY_ID[id].bipolar) {
            // grows up/down from the centre line (e.g. Pan: up = right, down = left)
            const mid = rowTop + 2 + span / 2;
            const bh = Math.max(2, Math.abs(n - 0.5) * span);
            ctx.fillRect(si * CELL - x0 + 4, n >= 0.5 ? mid - bh : mid, CELL - 8, bh);
          } else {
            const bh = Math.max(2, n * span);
            ctx.fillRect(si * CELL - x0 + 4, rowTop + SUB_H - 2 - bh, CELL - 8, bh);
          }
        }
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

  function section(title: string, ...children: HTMLElement[]) {
    const s = h('div', 'section');
    s.append(h('div', 'stitle', title), ...children);
    return s;
  }

  function knobs_(...ids: string[]) {
    const g = h('div', 'knobs');
    g.append(...ids.map(knob));
    return g;
  }

  function button(label: string, cls: string, onClick: () => void) {
    const b = h('button', cls, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function build() {
    const scrollLeft = scroller?.scrollLeft ?? 0;
    knobs = [];
    heads = [];
    names = [];
    root.innerHTML = '';

    // header
    const header = h('header');
    playBtn = button('▶ PLAY', 'btn', () => setPlaying(!t.playing));
    recBtn = button('● REC', 'btn rec', () => setRec(!t.rec));
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
      h('div', 'logo', 'DUBBOX'),
      playBtn, recBtn, followBtn,
      knobs_('tempo', 'swing', 'root', 'volume'),
      h('div', 'spacer'),
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
    const headCol = h('div', 'col');
    headCol.append(h('div', 'ruler-gap'));
    TRACKS.forEach((td, ti) => {
      const head = h('div', 'head');
      const name = h('div', 'name', (ti === expanded ? '▾ ' : '▸ ') + td.name);
      name.title = `click = show sound per note · hold ${THROW_KEYS[ti].slice(3)} = dub throw · ${ti + 1} = mute · shift+${ti + 1} = solo`;
      name.addEventListener('click', () => {
        expanded = expanded === ti ? -1 : ti;
        build();
      });
      const toggles = h('div', 'toggles');
      toggles.append(
        button('M', 'tog mute', () => { p.tracks[ti].mute = !p.tracks[ti].mute; flagsChanged(ti); }),
        button('S', 'tog solo', () => { p.tracks[ti].solo = !p.tracks[ti].solo; flagsChanged(ti); }),
      );
      head.append(name, toggles);
      headCol.append(head);
      heads.push(head);
      names.push(name);
      for (const id of subRows(ti)) headCol.append(h('div', 'sublabel', PARAM_BY_ID[id].label));
    });
    tracks.append(headCol, timeline());

    const fx = h('footer', 'fx');
    fx.append(
      section('DELAY', knobs_('delay.time', 'delay.fbk', 'delay.tone')),
      section('REVERB', knobs_('reverb.size')),
      section('TAPE', knobs_('tape.age')),
    );

    const help = h('div', 'help',
      'space play · 1–5 mute · shift+1–5 solo · hold Q W E R T = dub throw · ' +
      'click step = on/off · drag sideways = paint · drag up/down or wheel on a step = pitch · click track name = sound per note · alt-click (bass/chord) = slide · ' +
      'click ruler = play from bar · drag ruler = select bars · shift-drag = select · ⌘C/X/V copy/cut/paste at mouse · ⌘D duplicate · D dice selection/hovered note · ⌘Z undo · wheel = scroll · F = follow');

    root.append(header, tracks, fx, help);
    p.tracks.forEach((_, i) => renderHead(i));
    scroller.scrollLeft = scrollLeft;
  }

  // ---- frame loop -------------------------------------------------------

  function frame(now: number) {
    if (t.playing) {
      const bpm = toReal(PARAM_BY_ID.tempo, p.params.tempo);
      t.phase = (t.enginePhase + (now - t.posAt) / 1000 / (60 / bpm / 4)) % SONG_STEPS;
      if (follow) scroller.scrollLeft = t.phase * CELL - scroller.clientWidth * 0.25;
    }
    drawTimeline();
    knobs.forEach(renderKnob);

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
    if ((e.metaKey || e.ctrlKey) && editKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape') sel = null;
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
    const digit = /^Digit([1-5])$/.exec(e.code);
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
