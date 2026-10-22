// @ts-nocheck
/** STFT / iSTFT shared by the worker and the main thread. MIT, adapted from elicwhite/bs-roformer-web. */
import { fftRadix2InPlace } from "./fft-radix2.js";

function makeHannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

function reflectIndex(i, len) {
  if (i >= 0 && i < len) return i;
  if (len === 1) return 0;
  const period = 2 * (len - 1);
  i = ((i % period) + period) % period;
  return i < len ? i : period - i;
}

export function stftStereo(planarAudio, { nFft, hopLength, winLength }) {
  const numSamples = planarAudio.length / 2;
  const window = makeHannWindow(winLength);
  const halfNFft = Math.floor(nFft / 2);
  const T = Math.floor(numSamples / hopLength) + 1;
  const F = halfNFft + 1;
  const real = new Float32Array(2 * F * T);
  const imag = new Float32Array(2 * F * T);
  const fftBuf = new Float32Array(nFft * 2);

  for (let c = 0; c < 2; c++) {
    const chanOffset = c * numSamples;
    for (let t = 0; t < T; t++) {
      const frameStart = t * hopLength - halfNFft;
      for (let i = 0; i < nFft; i++) {
        const srcIdx = reflectIndex(frameStart + i, numSamples);
        fftBuf[i * 2] = planarAudio[chanOffset + srcIdx] * window[i];
        fftBuf[i * 2 + 1] = 0;
      }
      fftRadix2InPlace(fftBuf, nFft);
      for (let k = 0; k < F; k++) {
        real[(c * F + k) * T + t] = fftBuf[k * 2];
        imag[(c * F + k) * T + t] = fftBuf[k * 2 + 1];
      }
    }
  }
  return { real, imag, F, T };
}

const cache = new Map();
function getCached(nFft, T, hopLength, winLength) {
  const key = `${nFft}-${T}-${hopLength}-${winLength}`;
  let entry = cache.get(key);
  if (entry) return entry;
  const window = makeHannWindow(winLength);
  const pad = Math.floor(nFft / 2);
  const paddedLen = (T - 1) * hopLength + nFft;
  const windowSum = new Float32Array(paddedLen);
  for (let t = 0; t < T; t++) {
    const frameStart = t * hopLength;
    for (let i = 0; i < nFft; i++) windowSum[frameStart + i] += window[i] * window[i];
  }
  const invN = 1 / nFft;
  const windowInvN = new Float32Array(nFft);
  for (let i = 0; i < nFft; i++) windowInvN[i] = window[i] * invN;
  const invWindowSum = new Float32Array(paddedLen);
  for (let i = 0; i < paddedLen; i++) {
    invWindowSum[i] = windowSum[i] > 1e-8 ? 1 / windowSum[i] : 0;
  }
  entry = { windowInvN, invWindowSum, paddedLen, pad };
  cache.set(key, entry);
  return entry;
}

export function istftBatch(msg) {
  const { realBuf, imagBuf, numStems, numChannels, F, T, length, nFft, hopLength, winLength } = msg;
  const real = new Float32Array(realBuf);
  const imag = new Float32Array(imagBuf);
  const { windowInvN, invWindowSum, paddedLen, pad } = getCached(nFft, T, hopLength, winLength);
  const audio = new Float32Array(numStems * numChannels * length);
  const fftBuf = new Float32Array(nFft * 2);
  const padded = new Float32Array(paddedLen);
  const sliceStride = F * T;
  const perStemStride = numChannels * sliceStride;

  for (let s = 0; s < numStems; s++) {
    for (let c = 0; c < numChannels; c++) {
      const inOff = s * perStemStride + c * sliceStride;
      padded.fill(0);
      for (let t = 0; t < T; t++) {
        fftBuf[0] = real[inOff + t];
        fftBuf[1] = -imag[inOff + t];
        fftBuf[(F - 1) * 2] = real[inOff + (F - 1) * T + t];
        fftBuf[(F - 1) * 2 + 1] = -imag[inOff + (F - 1) * T + t];
        for (let k = 1; k < F - 1; k++) {
          const idx = inOff + k * T + t;
          const re = real[idx];
          const im = -imag[idx];
          fftBuf[k * 2] = re;
          fftBuf[k * 2 + 1] = im;
          const mirror = nFft - k;
          fftBuf[mirror * 2] = re;
          fftBuf[mirror * 2 + 1] = -im;
        }
        fftBuf[F * 2] = 0;
        fftBuf[F * 2 + 1] = 0;
        fftRadix2InPlace(fftBuf, nFft);
        const frameStart = t * hopLength;
        for (let i = 0; i < nFft; i++) padded[frameStart + i] += fftBuf[i * 2] * windowInvN[i];
      }
      const outOff = s * numChannels * length + c * length;
      for (let i = 0; i < length; i++) audio[outOff + i] = padded[pad + i] * invWindowSum[pad + i];
    }
  }
  return { audio, numStems, numChannels, length };
}
