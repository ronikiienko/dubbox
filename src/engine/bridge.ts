// Main thread <-> worklet. Audio starts lazily on the first user gesture (Play / REC).

import type { Project } from '../state';
import workletUrl from './worklet.ts?worker&url';

export type ToEngine =
  | { t: 'init'; project: Project }
  | { t: 'param'; id: string; v: number } // normalized 0..1 base value
  | { t: 'step'; i: number; si: number; s: number; note: number; slide: number }
  | { t: 'lock'; i: number; id: string; si: number; v: number } // v = detent index or NO_LOCK
  | { t: 'flags'; i: number; mute: boolean; solo: boolean }
  | { t: 'throw'; i: number; on: boolean }
  | { t: 'play'; on: boolean; from: number } // from = song step
  | { t: 'loop'; s0: number; s1: number } // loop steps s0..s1 (exclusive); s1 = 0 = off
  | { t: 'rec'; on: boolean };

export type FromEngine =
  | { t: 'pos'; phase: number } // song position in 16th steps
  | { t: 'audio'; l: Float32Array; r: Float32Array }
  | { t: 'recEnd'; sampleRate: number };

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let starting: Promise<void> | null = null;
const listeners: ((m: FromEngine) => void)[] = [];

export function onEngine(cb: (m: FromEngine) => void) {
  listeners.push(cb);
}

/** Create the AudioContext + worklet (once), push full project state, resume. Call from a user gesture. */
export function startEngine(getProject: () => Project): Promise<void> {
  starting ??= (async () => {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(ctx, 'dubbox', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<FromEngine>) => listeners.forEach((l) => l(e.data));
    node.connect(ctx.destination);
    node.port.postMessage({ t: 'init', project: getProject() } satisfies ToEngine);
  })();
  return starting.then(() => ctx!.resume());
}

let tap: MediaStreamAudioDestinationNode | null = null;

/** The engine's output as a MediaStream (for video recording). Call after startEngine resolves. */
export function audioStream(): MediaStream {
  if (!tap) {
    tap = ctx!.createMediaStreamDestination();
    node!.connect(tap);
  }
  return tap.stream;
}

/** Dropped silently until the engine exists; `init` carries the full state when it starts. */
export function send(msg: ToEngine) {
  node?.port.postMessage(msg);
}
