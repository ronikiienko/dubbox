// Stand-ins for the AudioWorklet globals so the real engine (worklet.ts) runs in a plain worker.
// Imported before the engine: modules evaluate in import order.

export const SAMPLE_RATE = 48000;
export let Engine: (new () => EngineLike) | null = null;

export interface EngineLike {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

const g = globalThis as Record<string, unknown>;
g.sampleRate = SAMPLE_RATE;
g.AudioWorkletProcessor = class {
  port = { postMessage() {}, onmessage: null };
};
g.registerProcessor = (_name: string, ctor: new () => EngineLike) => (Engine = ctor);
