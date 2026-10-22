// Video recording: the browser's screen capture (this tab, picked in its prompt) + the engine's own
// audio, straight from the graph (clean, no mic), through MediaRecorder. MP4 where the browser can
// encode it, WebM otherwise.

import { download } from './wav';

const TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

export class VideoRecorder {
  private rec: MediaRecorder | null = null;
  private screen: MediaStream | null = null;

  /**
   * Ask for the screen (must run inside the click), then record it with `audio` once both are ready.
   * Resolves false if the user cancels. `onEnd` fires if recording stops from the browser's own
   * "Stop sharing" button.
   */
  async start(audio: Promise<MediaStream>, onEnd: () => void): Promise<boolean> {
    const opts = {
      video: { frameRate: 60 },
      audio: false,
      preferCurrentTab: true, // Chrome: offer this tab first
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions;
    let screen: MediaStream;
    let sound: MediaStream;
    try {
      [screen, sound] = await Promise.all([navigator.mediaDevices.getDisplayMedia(opts), audio]);
    } catch {
      return false;
    }
    this.screen = screen;
    const stream = new MediaStream([...screen.getVideoTracks(), ...sound.getAudioTracks()]);
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 256_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || 'video/webm';
      download(chunks, type.split(';')[0], type.includes('mp4') ? 'mp4' : 'webm');
    };
    screen.getVideoTracks()[0].addEventListener('ended', () => {
      if (this.rec) {
        this.stop();
        onEnd();
      }
    });
    rec.start(1000);
    this.rec = rec;
    return true;
  }

  stop() {
    this.rec?.stop();
    this.rec = null;
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
  }
}
