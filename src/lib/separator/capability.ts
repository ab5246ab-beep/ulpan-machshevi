import {
  deleteCachedModel,
  modelIsCached,
  modelState as readModelState,
  subscribeModel as subscribeModelState,
} from "./model-cache.js";

type WebGpuNavigator = Navigator & {
  gpu?: { requestAdapter: (options?: { powerPreference?: string }) => Promise<unknown> };
};

export type ModelState = "ready" | "downloading" | "missing";

export async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as WebGpuNavigator).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter({ powerPreference: "high-performance" }));
  } catch {
    return false;
  }
}

export function cachedModel(): Promise<boolean> {
  return modelIsCached();
}

export async function modelState(): Promise<ModelState> {
  const state = await readModelState();
  if (state === "ready" || state === "downloading") return state;
  return "missing";
}

export function subscribeModel(listener: () => void): () => void {
  return subscribeModelState(listener);
}

export { deleteCachedModel };
