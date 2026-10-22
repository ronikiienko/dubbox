// Collects recorded chunks from the engine and downloads a 24-bit stereo WAV.

export class Recorder {
  private l: Float32Array[] = [];
  private r: Float32Array[] = [];

  push(l: Float32Array, r: Float32Array) {
    this.l.push(l);
    this.r.push(r);
  }

  finish(sampleRate: number) {
    const frames = this.l.reduce((n, c) => n + c.length, 0);
    const l = this.l, r = this.r;
    this.l = [];
    this.r = [];
    if (frames === 0) return;

    const bytes = 44 + frames * 6;
    const buf = new ArrayBuffer(bytes);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, bytes - 8, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 2, true); // stereo
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 6, true);
    v.setUint16(32, 6, true);
    v.setUint16(34, 24, true);
    str(36, 'data');
    v.setUint32(40, frames * 6, true);

    let o = 44;
    const put = (x: number) => {
      const s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607);
      v.setUint8(o, s & 0xff);
      v.setUint8(o + 1, (s >> 8) & 0xff);
      v.setUint8(o + 2, (s >> 16) & 0xff);
      o += 3;
    };
    for (let c = 0; c < l.length; c++) {
      for (let i = 0; i < l[c].length; i++) {
        put(l[c][i]);
        put(r[c][i]);
      }
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    a.download = `dubbox-${new Date().toISOString().slice(0, 16).replace(':', '')}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
