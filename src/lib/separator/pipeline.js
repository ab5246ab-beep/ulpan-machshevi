// @ts-nocheck
/** Kim Vocal 2 separation. The graph is MIT weights by Kimberley Jensen. */
import * as ort from "onnxruntime-web/webgpu";
import { separateMix } from "./kim-dsp.js";

const FREQS = 2050;
const FRAMES = 801;

export async function separateStems({ audio, session, onProgress, signal }) {
  return separateMix(
    audio,
    async (spec) => {
      const input = new ort.Tensor("float32", spec, [1, FREQS, FRAMES, 2]);
      const out = await session.run({ spec: input });
      const mask = Object.values(out)[0];
      const copy = mask.data.slice();
      input.dispose();
      mask.dispose();
      return copy;
    },
    onProgress,
    signal,
  );
}
