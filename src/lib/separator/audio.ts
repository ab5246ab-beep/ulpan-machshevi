import { Mp3Encoder } from "@breezystack/lamejs";

const RATE = 44100;
export const MAX_SECONDS = 10 * 60;

export async function readDurationSeconds(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const duration = await new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("timeout")), 8000);
      audio.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve(audio.duration);
      };
      audio.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("read"));
      };
      audio.src = url;
    });
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch {
    /* some files only report length after a full decode */
  } finally {
    URL.revokeObjectURL(url);
  }
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    return decoded.duration;
  } finally {
    await ctx.close();
  }
}

export type Stereo = { left: Float32Array; right: Float32Array };

export async function decodeToStereo(file: File): Promise<Stereo> {
  const buf = await file.arrayBuffer();
  const probe = new OfflineAudioContext(2, RATE, RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(buf.slice(0));
  } catch {
    throw new Error("הדפדפן לא הצליח לקרוא את קובץ השמע. נסה MP3, WAV, FLAC, M4A או OGG.");
  }
  if (decoded.duration > MAX_SECONDS) {
    throw new Error("השיר ארוך מדי לדפדפן. אפשר עד 10 דקות.");
  }
  if (decoded.duration < 0.4) throw new Error("הקובץ קצר מדי.");
  const length = Math.max(1, Math.ceil(decoded.duration * RATE));
  const ctx = new OfflineAudioContext(2, length, RATE);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return {
    left: out.getChannelData(0).slice(),
    right: out.getChannelData(1).slice(),
  };
}

export function toPlanar(audio: Stereo): Float32Array {
  const n = audio.left.length;
  const planar = new Float32Array(n * 2);
  planar.set(audio.left, 0);
  planar.set(audio.right, n);
  return planar;
}

function clampPeak(planar: Float32Array) {
  let peak = 0;
  for (let i = 0; i < planar.length; i++) {
    const v = Math.abs(planar[i]);
    if (v > peak) peak = v;
  }
  if (peak > 1) {
    const gain = 0.98 / peak;
    for (let i = 0; i < planar.length; i++) planar[i] *= gain;
  }
}

export function prepareStem(planar: Float32Array): Float32Array {
  const copy = planar.slice();
  clampPeak(copy);
  return copy;
}

export function encodeWav(planar: Float32Array, sampleRate = RATE): Blob {
  const n = planar.length / 2;
  const buf = new ArrayBuffer(44 + n * 4);
  const view = new DataView(buf);
  let p = 0;
  const ws = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  const w32 = (v: number) => {
    view.setUint32(p, v, true);
    p += 4;
  };
  const w16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  ws("RIFF");
  w32(36 + n * 4);
  ws("WAVE");
  ws("fmt ");
  w32(16);
  w16(1);
  w16(2);
  w32(sampleRate);
  w32(sampleRate * 4);
  w16(4);
  w16(16);
  ws("data");
  w32(n * 4);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, planar[i]));
    const r = Math.max(-1, Math.min(1, planar[n + i]));
    view.setInt16(p, l * 0x7fff, true);
    p += 2;
    view.setInt16(p, r * 0x7fff, true);
    p += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

export function encodeMp3(planar: Float32Array, sampleRate = RATE, kbps = 320): Blob {
  const n = planar.length / 2;
  const encoder = new Mp3Encoder(2, sampleRate, kbps);
  const block = 1152;
  const left = new Int16Array(block);
  const right = new Int16Array(block);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i += block) {
    const count = Math.min(block, n - i);
    for (let j = 0; j < count; j++) {
      left[j] = Math.max(-1, Math.min(1, planar[i + j])) * 0x7fff;
      right[j] = Math.max(-1, Math.min(1, planar[n + i + j])) * 0x7fff;
    }
    const buf = encoder.encodeBuffer(left.subarray(0, count), right.subarray(0, count));
    if (buf.length) parts.push(buf);
  }
  const end = encoder.flush();
  if (end.length) parts.push(end);
  return new Blob(parts as BlobPart[], { type: "audio/mpeg" });
}

export function rms(planar: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < planar.length; i++) sum += planar[i] * planar[i];
  return Math.sqrt(sum / Math.max(1, planar.length));
}

export function almostIdentical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 32) {
    if (Math.abs(a[i] - b[i]) > 1e-4) return false;
  }
  return true;
}
