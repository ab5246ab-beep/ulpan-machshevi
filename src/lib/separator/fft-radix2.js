// @ts-nocheck
/**
 * In-place radix-2 FFT. MIT, adapted from elicwhite/bs-roformer-web.
 * Buffer is interleaved [re, im, ...] of length 2*n. Forward only.
 */
const _twiddleCache = new Map();

function getTwiddles(n) {
  let entry = _twiddleCache.get(n);
  if (entry) return entry;
  const wr = new Float64Array(n);
  const wi = new Float64Array(n);
  let off = 0;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let k = 0; k < half; k++) {
      wr[off + k] = Math.cos(step * k);
      wi[off + k] = Math.sin(step * k);
    }
    off += half;
  }
  entry = { wr, wi };
  _twiddleCache.set(n, entry);
  return entry;
}

/** Inverse real FFT matching numpy.fft.irfft: length n/2+1 complex bins -> n real samples. */
export function irfft(realBins, imagBins, n) {
  const buf = new Float32Array(n * 2);
  const half = n >> 1;
  buf[0] = realBins[0];
  buf[n] = realBins[half];
  for (let k = 1; k < half; k++) {
    const re = realBins[k];
    const im = imagBins[k];
    buf[k * 2] = re;
    buf[k * 2 + 1] = im;
    buf[(n - k) * 2] = re;
    buf[(n - k) * 2 + 1] = -im;
  }
  for (let i = 0; i < n; i++) buf[i * 2 + 1] = -buf[i * 2 + 1];
  fftRadix2InPlace(buf, n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf[i * 2] / n;
  return out;
}

export function fftRadix2InPlace(buf, n) {
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const a = i << 1;
      const b = j << 1;
      let tr = buf[a];
      buf[a] = buf[b];
      buf[b] = tr;
      tr = buf[a + 1];
      buf[a + 1] = buf[b + 1];
      buf[b + 1] = tr;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  const { wr, wi } = getTwiddles(n);
  let off = 0;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wrk = wr[off + k];
        const wik = wi[off + k];
        const aIdx = (i + k) << 1;
        const bIdx = (i + k + half) << 1;
        const tr = buf[bIdx] * wrk - buf[bIdx + 1] * wik;
        const ti = buf[bIdx] * wik + buf[bIdx + 1] * wrk;
        buf[bIdx] = buf[aIdx] - tr;
        buf[bIdx + 1] = buf[aIdx + 1] - ti;
        buf[aIdx] = buf[aIdx] + tr;
        buf[aIdx + 1] = buf[aIdx + 1] + ti;
      }
    }
    off += half;
  }
}
