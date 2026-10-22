// @ts-nocheck
/** Chunked STFT front-end for Kim Vocal 2. MIT driver math from port-bs-roformer-onnx. */
import { irfft } from "./fft-radix2.js";
import { stftStereo } from "./stft-core.js";

const CHUNK = 352800;
const N_FFT = 2048;
const HOP = 441;
const F = N_FFT / 2 + 1;
const T = Math.floor(CHUNK / HOP) + 1;
const WINDOW = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));

function reflectIndex(index, length) {
  if (length <= 1) return 0;
  let i = index;
  for (let guard = 0; guard < 12 && (i < 0 || i >= length); guard++) {
    if (i < 0) i = -i;
    else i = 2 * (length - 1) - i;
  }
  if (i < 0 || i >= length) return 0;
  return i;
}

function istftChannel(masked, channel, length) {
  const expected = N_FFT + HOP * (T - 1);
  const signal = new Float32Array(expected);
  const envelope = new Float32Array(expected);
  const re = new Float32Array(F);
  const im = new Float32Array(F);
  for (let t = 0; t < T; t++) {
    for (let f = 0; f < F; f++) {
      const o = ((f * 2 + channel) * T + t) * 2;
      re[f] = masked[o];
      im[f] = masked[o + 1];
    }
    const frame = irfft(re, im, N_FFT);
    const start = t * HOP;
    for (let i = 0; i < N_FFT; i++) {
      const weight = WINDOW[i];
      signal[start + i] += frame[i] * weight;
      envelope[start + i] += weight * weight;
    }
  }
  const out = new Float32Array(length);
  const skip = N_FFT >> 1;
  for (let i = 0; i < length; i++) {
    const env = envelope[skip + i];
    out[i] = env ? signal[skip + i] / env : 0;
  }
  return out;
}

function specFromPlanar(planar) {
  const { real, imag } = stftStereo(planar, { nFft: N_FFT, hopLength: HOP, winLength: N_FFT });
  const spec = new Float32Array(F * 2 * T * 2);
  for (let f = 0; f < F; f++) {
    for (let c = 0; c < 2; c++) {
      const src = (c * F + f) * T;
      const row = (f * 2 + c) * T;
      for (let t = 0; t < T; t++) {
        const o = (row + t) * 2;
        spec[o] = real[src + t];
        spec[o + 1] = imag[src + t];
      }
    }
  }
  return spec;
}

function applyMask(spec, mask) {
  const out = new Float32Array(spec.length);
  const n = Math.min(spec.length, mask.length);
  for (let i = 0; i < n; i += 2) {
    const ar = spec[i];
    const ai = spec[i + 1];
    const br = mask[i];
    const bi = mask[i + 1];
    out[i] = ar * br - ai * bi;
    out[i + 1] = ar * bi + ai * br;
  }
  out.fill(0, 0, 2 * T * 2);
  return out;
}

export async function separateMix(audio, runGraph, onProgress, signal) {
  const n = audio.left.length;
  const fade = Math.floor(CHUNK / 10);
  const step = Math.floor(CHUNK / 2);
  const border = CHUNK - step;
  const wasPadded = n > border * 2 && border > 0;
  const paddedLen = wasPadded ? n + border * 2 : n;
  const vocalsL = new Float32Array(paddedLen);
  const vocalsR = new Float32Array(paddedLen);
  const counter = new Float32Array(paddedLen);
  const starts = [];
  for (let start = 0; start < paddedLen; start += step) starts.push(start);
  const denom = Math.max(1, fade - 1);
  let avgMs = 0;

  function sample(channel, paddedIndex) {
    const data = channel === 0 ? audio.left : audio.right;
    const src = wasPadded ? paddedIndex - border : paddedIndex;
    if (!wasPadded) return src >= 0 && src < n ? data[src] : 0;
    return data[reflectIndex(src, n)];
  }

  function chunkValue(channel, index, start, segLen) {
    if (index < segLen) return sample(channel, start + index);
    if (segLen <= CHUNK / 2) return 0;
    return sample(channel, start + reflectIndex(segLen - 2 - (index - segLen), segLen));
  }

  for (let seg = 0; seg < starts.length; seg++) {
    if (signal?.aborted) {
      const err = new Error(signal.reason === "timeout" || signal.reason === "replace" ? signal.reason : "aborted");
      err.name = "AbortError";
      throw err;
    }
    const start = starts[seg];
    const segLen = Math.min(CHUNK, paddedLen - start);
    const planar = new Float32Array(CHUNK * 2);
    for (let i = 0; i < CHUNK; i++) {
      planar[i] = chunkValue(0, i, start, segLen);
      planar[CHUNK + i] = chunkValue(1, i, start, segLen);
    }
    const spec = specFromPlanar(planar);
    const t0 = performance.now();
    const mask = await runGraph(spec);
    const inferMs = performance.now() - t0;
    avgMs = avgMs === 0 ? inferMs : avgMs * 0.8 + inferMs * 0.2;
    const vocals = applyMask(spec, mask);
    const left = istftChannel(vocals, 0, CHUNK);
    const right = istftChannel(vocals, 1, CHUNK);
    const win = new Float32Array(CHUNK);
    win.fill(1);
    for (let i = 0; i < fade; i++) {
      win[i] = i / denom;
      win[CHUNK - fade + i] = 1 - i / denom;
    }
    const next = start + step;
    if (start === 0) for (let i = 0; i < fade; i++) win[i] = 1;
    else if (next >= paddedLen) for (let i = 0; i < fade; i++) win[CHUNK - fade + i] = 1;
    for (let i = 0; i < segLen; i++) {
      vocalsL[start + i] += left[i] * win[i];
      vocalsR[start + i] += right[i] * win[i];
      counter[start + i] += win[i];
    }
    onProgress?.({
      segment: seg + 1,
      totalSegments: starts.length,
      etaSec: (starts.length - seg - 1) * (avgMs / 1000),
    });
  }

  const crop = wasPadded ? border : 0;
  const vocalsOut = new Float32Array(n * 2);
  const playback = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const weight = counter[crop + i] || 1;
    const l = vocalsL[crop + i] / weight;
    const r = vocalsR[crop + i] / weight;
    vocalsOut[i] = l;
    vocalsOut[n + i] = r;
    playback[i] = audio.left[i] - l;
    playback[n + i] = audio.right[i] - r;
  }
  return { vocals: vocalsOut, playback };
}
