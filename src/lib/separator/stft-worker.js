// @ts-nocheck
/** STFT worker entry. The math lives in stft-core.js so the page can run it if workers are blocked. */
import { istftBatch, stftStereo } from "./stft-core.js";

self.addEventListener("message", (e) => {
  const msg = e.data;
  try {
    if (msg.type === "istft-batch") {
      const result = istftBatch(msg);
      const reply = {
        id: msg.id,
        type: "istft-batch",
        audioBuf: result.audio.buffer,
        numStems: result.numStems,
        numChannels: result.numChannels,
        length: result.length,
      };
      self.postMessage(reply, [reply.audioBuf]);
    } else if (msg.type === "stft") {
      const planar = new Float32Array(msg.planarBuf);
      const { real, imag, F, T } = stftStereo(planar, {
        nFft: msg.nFft,
        hopLength: msg.hopLength,
        winLength: msg.winLength,
      });
      self.postMessage(
        { id: msg.id, type: "stft", realBuf: real.buffer, imagBuf: imag.buffer, F, T },
        [real.buffer, imag.buffer],
      );
    }
  } catch (error) {
    self.postMessage({
      id: msg?.id,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
  }
});
