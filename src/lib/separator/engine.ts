import { almostIdentical, decodeToStereo, prepareStem, rms } from "./audio";
import { hasWebGpu } from "./capability";
import { applyActiveGpu, markGpuBound } from "./gpus";
import { getModelBytes, modelIsCached } from "./model-cache.js";
import { separateStems } from "./pipeline.js";

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";

export type SeparateProgress =
  | { phase: "download"; loaded: number; total: number; etaSec?: number }
  | { phase: "session" }
  | { phase: "decode" }
  | { phase: "separate"; segment: number; totalSegments: number; etaSec: number };

type Session = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dispose: () => void }>>;
};

let sessionPromise: Promise<Session> | null = null;
const sessionListeners = new Set<(progress: SeparateProgress) => void>();

function emitSession(progress: SeparateProgress) {
  for (const listener of sessionListeners) listener(progress);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason === "timeout" || signal.reason === "replace" ? signal.reason : "aborted";
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function forgetLoadedSession() {
  sessionPromise = null;
}

export async function cachedModel(): Promise<boolean> {
  return modelIsCached();
}

async function loadSession(onProgress: (progress: SeparateProgress) => void): Promise<Session> {
  sessionListeners.add(onProgress);
  try {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const ort = await import("onnxruntime-web/webgpu");
        ort.env.wasm.wasmPaths = WASM_ROOT;
        ort.env.wasm.numThreads = 1;
        ort.env.logLevel = "warning";
        const { bytes } = await getModelBytes({ onProgress: emitSession });
        await applyActiveGpu(ort);
        markGpuBound();
        emitSession({ phase: "session" });
        const created = await ort.InferenceSession.create(bytes, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "disabled",
        });
        return created as unknown as Session;
      })().catch((error: unknown) => {
        sessionPromise = null;
        throw error;
      });
    }
    return await sessionPromise;
  } finally {
    sessionListeners.delete(onProgress);
  }
}

export async function separateFile(
  file: File,
  onProgress: (progress: SeparateProgress) => void,
  signal: AbortSignal,
): Promise<{ vocals: Float32Array; playback: Float32Array; sampleRate: number }> {
  if (!(await hasWebGpu())) {
    throw new Error("נדרש Chrome או Edge במחשב עם כרטיס מסך שתומך ב-WebGPU.");
  }
  if (signal.aborted) throw abortError(signal);
  const ready = await cachedModel();
  const sessionTask = loadSession(onProgress);
  if (ready) onProgress({ phase: "decode" });
  const audio = await decodeToStereo(file);
  if (signal.aborted) throw abortError(signal);
  const session = await withAbort(sessionTask, signal);
  if (signal.aborted) throw abortError(signal);
  const separated = (await separateStems({
    audio,
    session,
    signal,
    onProgress: (progress: { segment: number; totalSegments: number; etaSec: number }) => {
      onProgress({ phase: "separate", ...progress });
    },
  })) as { vocals: Float32Array; playback: Float32Array };

  const vocals = prepareStem(separated.vocals);
  const playback = prepareStem(separated.playback);
  if (rms(vocals) < 1e-4 || rms(playback) < 1e-4) {
    throw new Error("אחד הפלטים יצא ריק, אז הם לא נשמרו.");
  }
  if (almostIdentical(vocals, playback)) {
    throw new Error("שני הפלטים יצאו זהים, אז הם לא נשמרו.");
  }
  return { vocals, playback, sampleRate: 44100 };
}
