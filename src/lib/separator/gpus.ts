const STORAGE_KEY = "ulpan-machshevi-gpu";

export type GpuOption = {
  id: string;
  preference: "high-performance" | "low-power";
  label: string;
  hint: string;
  strong: boolean;
};

type AdapterInfo = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
};

type Adapter = {
  info?: AdapterInfo;
  requestAdapterInfo?: () => Promise<AdapterInfo>;
};

type Detection = { options: GpuOption[] };

const adapters = new Map<string, Adapter>();
let detected: Promise<Detection> | null = null;
let bound = false;

function readSavedId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSavedId(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode */
  }
}

async function readInfo(adapter: Adapter): Promise<AdapterInfo> {
  const info = adapter.info;
  if (info && (info.description || info.vendor || info.device)) return info;
  if (typeof adapter.requestAdapterInfo === "function") {
    try {
      return await adapter.requestAdapterInfo();
    } catch {
      /* older browsers hide the name */
    }
  }
  return info ?? {};
}

function describe(info: AdapterInfo, preference: GpuOption["preference"]): { id: string; label: string } {
  const label = info.description || info.device || info.vendor;
  const id = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join("|");
  return {
    id: id || preference,
    label: label || (preference === "high-performance" ? "הכרטיס החזק" : "הכרטיס החסכוני"),
  };
}

function strength(info: AdapterInfo, preference: GpuOption["preference"]): number {
  const text = `${info.vendor ?? ""} ${info.architecture ?? ""} ${info.device ?? ""} ${info.description ?? ""}`.toLowerCase();
  let score = preference === "high-performance" ? 50 : 10;
  if (/nvidia|geforce|rtx|gtx|quadro/.test(text)) score += 100;
  else if (/amd|radeon/.test(text)) score += 80;
  else if (/\barc\b/.test(text)) score += 60;
  else if (/intel|uhd|iris/.test(text)) score += 15;
  return score;
}

async function probe(): Promise<Detection> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: (options?: { powerPreference?: string }) => Promise<Adapter | null> } }).gpu;
  if (!gpu) return { options: [] };
  const found: Array<GpuOption & { score: number }> = [];
  for (const preference of ["high-performance", "low-power"] as const) {
    let adapter: Adapter | null = null;
    try {
      adapter = await gpu.requestAdapter({ powerPreference: preference });
    } catch {
      adapter = null;
    }
    if (!adapter) continue;
    const info = await readInfo(adapter);
    const named = Boolean(info.description || info.device || info.vendor);
    const described = describe(info, preference);
    if (!named && found.length > 0) continue;
    if (found.some((item) => item.id === described.id)) continue;
    adapters.set(described.id, adapter);
    found.push({
      id: described.id,
      preference,
      label: described.label,
      hint: "",
      strong: false,
      score: strength(info, preference),
    });
  }
  found.sort((a, b) => b.score - a.score);
  const best = found[0]?.id;
  const options = found.map((item) => ({
    id: item.id,
    preference: item.preference,
    label: item.label,
    strong: item.id === best,
    hint: item.id === best ? "החזק יותר, נבחר כברירת מחדל" : "כרטיס נוסף שהדפדפן חושף",
  }));
  const saved = readSavedId();
  if (!saved || !options.some((item) => item.id === saved)) {
    if (best) writeSavedId(best);
  }
  return { options };
}

export function detectGpus(): Promise<Detection> {
  if (!detected) detected = probe();
  return detected;
}

export async function selectedGpu(): Promise<GpuOption | null> {
  const { options } = await detectGpus();
  const saved = readSavedId();
  return options.find((item) => item.id === saved) ?? options[0] ?? null;
}

export function markGpuBound() {
  bound = true;
}

export function gpuIsBound(): boolean {
  return bound;
}

export function chooseGpu(id: string): boolean {
  writeSavedId(id);
  return bound;
}

export async function applyActiveGpu(ort: { env: { webgpu: { powerPreference?: "high-performance" | "low-power"; adapter?: unknown } } }) {
  const selected = await selectedGpu();
  if (!selected) return;
  ort.env.webgpu.powerPreference = selected.preference;
  const adapter = adapters.get(selected.id);
  if (adapter) ort.env.webgpu.adapter = adapter;
}
