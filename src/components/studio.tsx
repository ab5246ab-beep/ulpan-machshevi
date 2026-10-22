import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AudioWaveform,
  Download,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { deleteCachedModel, hasWebGpu, modelState, subscribeModel, type ModelState } from "@/lib/separator/capability";
import { chooseGpu, detectGpus, gpuIsBound, selectedGpu, type GpuOption } from "@/lib/separator/gpus";
import type { SeparateProgress } from "@/lib/separator/engine";
import { decodeToStereo, encodeMp3, encodeWav, MAX_SECONDS, readDurationSeconds, toPlanar } from "@/lib/separator/audio";
import {
  addFile,
  addFolder,
  deleteNode,
  getFileBlob,
  getLibrarySnapshot,
  moveNode,
  refreshLibrary,
  renameNode,
  stemFileName,
  subscribeLibrary,
  type LibraryId,
  type LibraryNode,
} from "@/lib/library/db";

const EMPTY_LIBRARY: LibraryNode[] = [];
const EXPORT_KEY = "ulpan-machshevi-export";

function savedExportFormat(): "wav" | "mp3" {
  try {
    return localStorage.getItem(EXPORT_KEY) === "wav" ? "wav" : "mp3";
  } catch {
    return "mp3";
  }
}

function rememberExportFormat(format: "wav" | "mp3") {
  try {
    localStorage.setItem(EXPORT_KEY, format);
  } catch {
    /* private mode */
  }
}
const ACCEPT = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
const btn =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40";
const btnPrimary = `${btn} bg-primary text-primary-fg`;
const btnQuiet = `${btn} border border-line bg-raised text-fg`;
const iconBtn =
  "inline-flex size-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

type DialogState =
  | null
  | { type: "download" }
  | { type: "folder"; library: LibraryId; parentId: string | null }
  | { type: "rename"; id: string; name: string; kind: LibraryNode["kind"] }
  | { type: "move"; id: string }
  | { type: "delete"; id: string; name: string; kind: LibraryNode["kind"] }
  | { type: "export"; items: { name: string; blob: Blob }[]; format: "wav" | "mp3" };

type ResultFile = { library: LibraryId; name: string; blob: Blob; durationSec: number };
type Player = { name: string; url: string };

function humanError(error: unknown): string {
  if (!(error instanceof Error)) return `הפעולה נכשלה. סיבה: ${String(error)}`;
  if (error.message === "replace") return error.message;
  if (error.message === "timeout" || error.name === "TimeoutError") {
    return "ההפרדה עברה 45 דקות ונעצרה.";
  }
  if (error.message === "aborted" || (error.name === "AbortError" && error.message === "aborted")) {
    return "ההפרדה בוטלה.";
  }
  if (/[\u0590-\u05FF]/.test(error.message)) return error.message;
  const detail = error.message ? `${error.name}: ${error.message}` : error.name;
  return `הפעולה נכשלה. סיבה: ${detail}`;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} ק״ב`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} מ״ב`;
}

function progressView(progress: SeparateProgress | null): { text: string; fraction: number } {
  if (!progress) return { text: "המנוע פעיל", fraction: 0.08 };
  if (progress.phase === "download") {
    const fraction = progress.total ? progress.loaded / progress.total : 0.15;
    const percent = progress.total ? `${Math.round(fraction * 100)}%` : "";
    const loaded = (progress.loaded / (1024 * 1024)).toFixed(0);
    const total = progress.total ? ` מתוך ${(progress.total / (1024 * 1024)).toFixed(0)}` : "";
    return { text: `מוריד את המודל${percent ? `, ${percent}` : ""}, ${loaded}${total} מגה-בייט`, fraction };
  }
  if (progress.phase === "session") return { text: "טוען את המודל לכרטיס המסך, 100%", fraction: 1 };
  if (progress.phase === "decode") return { text: "קורא את השיר", fraction: 0.04 };
  const fraction = progress.totalSegments ? progress.segment / progress.totalSegments : 0;
  const percent = `${Math.round(fraction * 100)}%`;
  return {
    text:
      progress.etaSec > 1
        ? `מפריד, ${percent}, נשארו כ-${Math.ceil(progress.etaSec)} שניות`
        : `מפריד, ${percent}`,
    fraction,
  };
}

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isSupported(file: File): boolean {
  return ACCEPT.includes(extensionOf(file.name)) || file.type.startsWith("audio/");
}

async function blobToMp3(blob: Blob): Promise<Blob> {
  const file = new File([blob], "stem.wav", { type: blob.type || "audio/wav" });
  const stereo = await decodeToStereo(file);
  return encodeMp3(toPlanar(stereo));
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function Studio() {
  const nodes = useSyncExternalStore(subscribeLibrary, getLibrarySnapshot, () => EMPTY_LIBRARY);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SeparateProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [results, setResults] = useState<ResultFile[] | null>(null);
  const [gpu, setGpu] = useState<"unknown" | "yes" | "no">("unknown");
  const [modelPhase, setModelPhase] = useState<ModelState | "unknown">("unknown");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [draft, setDraft] = useState("");
  const [player, setPlayer] = useState<Player | null>(null);
  const [exporting, setExporting] = useState(false);
  const [gpuOpen, setGpuOpen] = useState(false);
  const [gpuOptions, setGpuOptions] = useState<GpuOption[]>([]);
  const [gpuId, setGpuId] = useState<string | null>(null);
  const [gpuDraft, setGpuDraft] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pullModel = () => {
      void modelState()
        .then((state) => {
          if (alive) setModelPhase(state);
        })
        .catch(() => {
          if (alive) setModelPhase("missing");
        });
    };
    void refreshLibrary().catch(() => setNotice("הספרייה בדפדפן לא נפתחה."));
    void hasWebGpu().then((ok) => {
      if (alive) setGpu(ok ? "yes" : "no");
    });
    void detectGpus()
      .then(async ({ options }) => {
        if (!alive) return;
        setGpuOptions(options);
        const selected = await selectedGpu();
        if (alive) setGpuId(selected?.id ?? null);
      })
      .catch(() => undefined);
    pullModel();
    const stop = subscribeModel(pullModel);
    return () => {
      alive = false;
      stop();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (player) URL.revokeObjectURL(player.url);
    };
  }, [player]);

  const fileCounts = useMemo(() => {
    return {
      vocals: nodes.filter((node) => node.library === "vocals" && node.kind === "file").length,
      playback: nodes.filter((node) => node.library === "playback" && node.kind === "file").length,
    };
  }, [nodes]);

  function playBlob(name: string, blob: Blob) {
    setPlayer((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return { name, url: URL.createObjectURL(blob) };
    });
  }

  async function choose(next: File | null) {
    if (!next) return;
    if (!isSupported(next)) {
      setNotice("הפורמט לא נתמך. אפשר MP3, WAV, FLAC, M4A או OGG.");
      return;
    }
    if (busy) abortRef.current?.abort("replace");
    setNotice("בודק את אורך השיר...");
    setSuccess(null);
    setResults(null);
    setFile(null);
    try {
      const seconds = await readDurationSeconds(next);
      if (seconds > MAX_SECONDS) {
        setNotice("השיר ארוך מ-10 דקות. ההפרדה לא התחילה.");
        return;
      }
    } catch {
      setNotice(null);
      setFile(next);
      return;
    }
    setNotice(null);
    setFile(next);
  }

  async function runSeparation() {
    if (!file || busy) return;
    setDialog(null);
    setNotice(null);
    setSuccess(null);
    setResults(null);
    setBusy(true);
    if (modelPhase !== "ready") setModelPhase("downloading");
    setProgress(modelPhase === "ready" ? { phase: "decode" } : { phase: "download", loaded: 0, total: 0 });
    const controller = new AbortController();
    const runId = runRef.current + 1;
    runRef.current = runId;
    abortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort("timeout"), 45 * 60 * 1000);
    try {
      const engine = await import("@/lib/separator/engine");
      const separated = await engine.separateFile(
        file,
        (next) => {
          setProgress(next);
          if (next.phase === "download") {
            setModelPhase(next.total > 0 && next.loaded >= next.total ? "ready" : "downloading");
          }
          if (next.phase === "session") setModelPhase("ready");
        },
        controller.signal,
      );
      const durationSec = separated.vocals.length / 2 / separated.sampleRate;
      const vocalsBlob = encodeWav(separated.vocals, separated.sampleRate);
      const playbackBlob = encodeWav(separated.playback, separated.sampleRate);
      const vocalsName = stemFileName(file.name, "vocals");
      const playbackName = stemFileName(file.name, "playback");
      try {
        const vocals = await addFile({
          library: "vocals",
          parentId: null,
          name: vocalsName,
          blob: vocalsBlob,
          durationSec,
        });
        const playback = await addFile({
          library: "playback",
          parentId: null,
          name: playbackName,
          blob: playbackBlob,
          durationSec,
        });
        setResults([
          { library: "vocals", name: vocals.name, blob: vocalsBlob, durationSec },
          { library: "playback", name: playback.name, blob: playbackBlob, durationSec },
        ]);
      } catch (error) {
        setResults([
          { library: "vocals", name: vocalsName, blob: vocalsBlob, durationSec },
          { library: "playback", name: playbackName, blob: playbackBlob, durationSec },
        ]);
        setNotice(humanError(error));
      }
      setModelPhase((await engine.cachedModel()) ? "ready" : "downloading");
      setSuccess("ההפרדה הושלמה ונשמרה בספריות.");
    } catch (error) {
      if (error instanceof Error && error.message === "replace") return;
      console.error(error);
      setModelPhase((phase) => (phase === "ready" ? phase : "missing"));
      setNotice(humanError(error));
    } finally {
      window.clearTimeout(timer);
      if (runRef.current === runId) {
        abortRef.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }

  async function requestStart() {
    if (!file || gpu === "no" || busy) return;
    const state = await modelState();
    setModelPhase(state);
    if (state === "missing") {
      setDialog({ type: "download" });
      return;
    }
    void runSeparation();
  }

  async function confirmExport() {
    if (!dialog || dialog.type !== "export") return;
    setExporting(true);
    try {
      rememberExportFormat(dialog.format);
      for (const item of dialog.items) {
        if (dialog.format === "wav") {
          downloadBlob(item.blob, item.name.endsWith(".wav") ? item.name : `${item.name}.wav`);
        } else {
          const mp3 = await blobToMp3(item.blob);
          const base = item.name.replace(/\.[^.]+$/, "");
          downloadBlob(mp3, `${base}.mp3`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      setDialog(null);
    } catch (error) {
      setNotice(humanError(error));
    } finally {
      setExporting(false);
    }
  }

  async function eraseModel() {
    if (busy) return;
    const engine = await import("@/lib/separator/engine");
    engine.forgetLoadedSession();
    await deleteCachedModel();
    setModelPhase("missing");
    setNotice("המודל נמחק מהדפדפן. ההפרדה הבאה תוריד אותו שוב.");
  }

  function openGpuPicker() {
    setGpuDraft(gpuId);
    setGpuOpen(true);
  }

  function saveGpu() {
    if (!gpuDraft || gpuDraft === gpuId) {
      setGpuOpen(false);
      return;
    }
    const reload = chooseGpu(gpuDraft);
    setGpuId(gpuDraft);
    setGpuOpen(false);
    if (reload) window.location.reload();
  }

  const gpuLabel = gpuOptions.find((item) => item.id === gpuId)?.label ?? (gpu === "no" ? "אין כרטיס" : "כרטיס מסך");
  const view = progressView(progress);
  const status =
    gpu === "no"
      ? "נדרש כרטיס מסך עם WebGPU"
      : modelPhase === "ready"
        ? "העיבוד מקומי"
        : modelPhase === "downloading"
          ? "המודל יורד ונשמר בדפדפן"
          : gpu === "unknown" || modelPhase === "unknown"
            ? "בודק את המחשב"
            : "נדרשת הורדת מודל פעם אחת";

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-fg">
              <AudioWaveform aria-hidden="true" />
            </span>
            <div>
              <p className="text-lg font-semibold leading-tight">אולפן מחשבי אישי</p>
              <p className="text-sm text-muted">הפרדת קול מקומית</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className={btnQuiet}
              onClick={() => void eraseModel()}
              disabled={busy || modelPhase !== "ready"}
            >
              מחק מודל
            </button>
            <button
              type="button"
              className={`${btnQuiet} max-w-64`}
              onClick={openGpuPicker}
              disabled={gpu === "no"}
            >
              <span className="max-w-40 truncate" dir="auto">
                {gpuLabel}
              </span>
            </button>
            <p className="flex items-center gap-2 text-sm text-muted">
              <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
              {status}
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        <LibraryPanel
            nodes={nodes}
            counts={fileCounts}
            onRefresh={() => void refreshLibrary().catch((error) => setNotice(humanError(error)))}
            onFolder={(library, parentId) => {
              setDraft("");
              setDialog({ type: "folder", library, parentId });
            }}
            onPlay={async (node) => {
              try {
                playBlob(node.name, await getFileBlob(node.id));
              } catch (error) {
                setNotice(humanError(error));
              }
            }}
            onExport={async (node) => {
              try {
                setDialog({
                  type: "export",
                  format: savedExportFormat(),
                  items: [{ name: node.name, blob: await getFileBlob(node.id) }],
                });
              } catch (error) {
                setNotice(humanError(error));
              }
            }}
            onExportMany={async (picked) => {
              try {
                const items = [];
                for (const node of picked) items.push({ name: node.name, blob: await getFileBlob(node.id) });
                setDialog({ type: "export", format: savedExportFormat(), items });
              } catch (error) {
                setNotice(humanError(error));
              }
            }}
            onDropMove={async (id, library, parentId) => {
              try {
                await moveNode(id, { library, parentId });
              } catch (error) {
                setNotice(humanError(error));
              }
            }}
            onRename={(node) => {
              setDraft(node.name.replace(/\.[^.]+$/, ""));
              setDialog({ type: "rename", id: node.id, name: node.name, kind: node.kind });
            }}
            onMove={(node) => setDialog({ type: "move", id: node.id })}
            onDelete={(node) =>
              setDialog({ type: "delete", id: node.id, name: node.name, kind: node.kind })
            }
          />

        <main className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="max-w-xl">
            <p className="text-sm font-medium text-primary">הפרדת stems באיכות AI</p>
            <h1 className="mt-2 text-balance text-3xl font-semibold leading-tight">
              הפרד את השיר שלך לקול ולפלייבאק
            </h1>
            <p className="mt-3 text-pretty text-muted">
              השיר לא יוצא מהמחשב. המודל יורד פעם אחת ונשמר בדפדפן, והתוצאות נכנסות אוטומטית
              לספריות.
            </p>
          </div>

          <button type="button" className={`${btnPrimary} self-start px-6`} onClick={() => inputRef.current?.click()}>
            <Plus aria-hidden="true" />
            הכנסת שיר
          </button>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,audio/*"
            onChange={(event) => {
              choose(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />

          {!file ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                choose(event.dataTransfer.files[0] ?? null);
              }}
              className={`flex min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center ${
                dragOver ? "border-primary bg-raised" : "border-line bg-surface"
              }`}
            >
              <AudioWaveform className="text-primary" aria-hidden="true" />
              <p className="text-lg font-medium">גרור לכאן שיר או בחר קובץ</p>
              <p className="text-sm text-muted">MP3, WAV, FLAC, M4A, OGG</p>
            </button>
          ) : (
            <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <Music className="shrink-0 text-primary" aria-hidden="true" />
                    <span className="break-words" dir="auto">
                      {file.name}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-muted">{formatBytes(file.size)} מהמחשב</p>
                </div>
                <button
                  type="button"
                  className={btnQuiet}
                  onClick={() => {
                    if (busy) abortRef.current?.abort();
                    else {
                      setFile(null);
                      setResults(null);
                      setSuccess(null);
                    }
                  }}
                >
                  <X aria-hidden="true" />
                  {busy ? "ביטול" : "ניקוי"}
                </button>
              </div>

              {busy && (
                <div>
                  <div className="h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                    <div className="h-full bg-primary" style={{ width: `${Math.round(view.fraction * 100)}%` }} />
                  </div>
                  <p className="mt-2 text-sm text-muted" role="status">
                    {view.text}
                  </p>
                  <button
                    type="button"
                    className={`${btnQuiet} mt-3 w-full`}
                    onClick={() => abortRef.current?.abort()}
                  >
                    ביטול ההפרדה
                  </button>
                </div>
              )}

              {!busy && (
                <button
                  type="button"
                  className={`${btnPrimary} self-start`}
                  disabled={gpu === "no"}
                  onClick={requestStart}
                >
                  התחל הפרדה
                </button>
              )}

              {gpu === "no" && (
                <p className="text-sm text-danger">
                  ההפרדה צריכה Chrome או Edge במחשב עם כרטיס מסך שתומך ב-WebGPU.
                </p>
              )}
              {notice && <p className="text-sm text-pretty break-words text-danger">{notice}</p>}
              {success && <p className="text-sm text-primary">{success}</p>}

              {results && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {results.map((result) => (
                    <article key={result.library} className="rounded-xl border border-line bg-raised p-4">
                      <p className="text-sm text-muted">
                        {result.library === "vocals" ? "קולות הזמר" : "פלייבאק"}
                      </p>
                      <p className="mt-1 break-words font-medium" dir="auto">
                        {result.name}
                      </p>
                      <p className="mt-1 text-sm tabular-nums text-muted">{formatClock(result.durationSec)}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" className={btnQuiet} onClick={() => playBlob(result.name, result.blob)}>
                          <Play aria-hidden="true" />
                          השמעה
                        </button>
                        <button
                          type="button"
                          className={btnQuiet}
                          onClick={() =>
                            setDialog({
                              type: "export",
                              format: savedExportFormat(),
                              items: [{ name: result.name, blob: result.blob }],
                            })
                          }
                        >
                          <Download aria-hidden="true" />
                          ייצוא
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {player && (
            <div className="rounded-2xl border border-line bg-raised p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="truncate text-sm" dir="auto">
                  {player.name}
                </p>
                <button
                  type="button"
                  className={iconBtn}
                  aria-label="סגור נגן"
                  onClick={() => setPlayer(null)}
                >
                  <Pause aria-hidden="true" />
                </button>
              </div>
              <audio className="w-full" controls autoPlay src={player.url} />
            </div>
          )}

          <p className="text-sm text-muted">
            המודל הוא Kim Vocal 2 של Kimberley Jensen, ברישיון MIT. איכות ההפרדה תלויה בשיר, והיא לא
            מושלמת בכל הקלטה. עד 10 דקות לשיר.
          </p>
        </main>
      </div>

      <StudioDialog
        dialog={dialog}
        draft={draft}
        nodes={nodes}
        exporting={exporting}
        onDraft={setDraft}
        onClose={() => setDialog(null)}
        onDownload={() => void runSeparation()}
        onExport={() => void confirmExport()}
        onFormat={(format) =>
          setDialog((current) => (current?.type === "export" ? { ...current, format } : current))
        }
        onSubmit={async () => {
          try {
            if (!dialog) return;
            if (dialog.type === "folder") await addFolder(dialog.library, dialog.parentId, draft);
            if (dialog.type === "rename") await renameNode(dialog.id, draft);
            setDialog(null);
          } catch (error) {
            setNotice(humanError(error));
          }
        }}
        onMove={async (library, parentId) => {
          if (!dialog || dialog.type !== "move") return;
          try {
            await moveNode(dialog.id, { library, parentId });
            setDialog(null);
          } catch (error) {
            setNotice(humanError(error));
          }
        }}
        onDelete={async () => {
          if (!dialog || dialog.type !== "delete") return;
          try {
            await deleteNode(dialog.id);
            setDialog(null);
          } catch (error) {
            setNotice(humanError(error));
          }
        }}
      />
      <GpuDialog
        open={gpuOpen}
        options={gpuOptions}
        draft={gpuDraft}
        bound={gpuIsBound()}
        onDraft={setGpuDraft}
        onClose={() => setGpuOpen(false)}
        onSave={saveGpu}
      />
    </div>
  );
}

function GpuDialog({
  open,
  options,
  draft,
  bound,
  onDraft,
  onClose,
  onSave,
}: {
  open: boolean;
  options: GpuOption[];
  draft: string | null;
  bound: boolean;
  onDraft: (id: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg/80" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 text-fg">
          <Dialog.Title className="text-lg font-semibold">בחירת כרטיס מסך</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-pretty text-muted">
            ההפרדה רצה על הכרטיס שנבחר. ברירת המחדל היא הכרטיס החזק יותר שהדפדפן חושף.
          </Dialog.Description>
          <div className="mt-4 flex flex-col gap-2">
            {options.length === 0 ? (
              <p className="text-sm text-muted">עדיין לא נמצא כרטיס עם WebGPU.</p>
            ) : (
              options.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-bg p-3"
                >
                  <input
                    className="mt-1"
                    type="radio"
                    name="gpu"
                    checked={draft === option.id}
                    onChange={() => onDraft(option.id)}
                  />
                  <span>
                    <span className="block font-medium" dir="auto">
                      {option.label}
                    </span>
                    <span className="block text-sm text-muted">{option.hint}</span>
                  </span>
                </label>
              ))
            )}
          </div>
          {options.length < 2 && (
            <p className="mt-3 text-sm text-pretty text-muted">
              אם כרטיס ה-NVIDIA לא מופיע, Windows עדיין שולח את הדפדפן לאינטל. בהגדרות התצוגה צריך
              לסמן את Chrome או Edge כביצועים גבוהים, לסגור את הדפדפן לגמרי ולפתוח שוב.
            </p>
          )}
          {bound && (
            <p className="mt-3 text-sm text-muted">החלפה עכשיו תרענן את הדף ותעצור הפרדה שרצה.</p>
          )}
          <div className="mt-5 flex gap-2">
            <button type="button" className={btnPrimary} disabled={!draft} onClick={onSave}>
              {bound ? "שמור ורענן" : "שמירה"}
            </button>
            <button type="button" className={btnQuiet} onClick={onClose}>
              ביטול
            </button>
          </div>
          <Dialog.Close className={`${iconBtn} absolute top-3 left-3`} aria-label="סגירה">
            <X aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const rowBtn =
  "inline-flex h-8 items-center justify-center rounded-lg border border-line bg-bg px-2.5 text-xs font-medium text-fg transition-colors hover:border-primary";

function LibraryPanel({
  nodes,
  counts,
  onRefresh,
  onFolder,
  onPlay,
  onExport,
  onExportMany,
  onRename,
  onMove,
  onDropMove,
  onDelete,
}: {
  nodes: LibraryNode[];
  counts: { vocals: number; playback: number };
  onRefresh: () => void;
  onFolder: (library: LibraryId, parentId: string | null) => void;
  onPlay: (node: LibraryNode) => void;
  onExport: (node: LibraryNode) => void;
  onExportMany: (nodes: LibraryNode[]) => void;
  onRename: (node: LibraryNode) => void;
  onMove: (node: LibraryNode) => void;
  onDropMove: (id: string, library: LibraryId, parentId: string | null) => void;
  onDelete: (node: LibraryNode) => void;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">הספריות שלי</h2>
        <button type="button" className={iconBtn} aria-label="רענון" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">השירים מופיעים כאן מיד. גרור שיר אל תיקייה כדי להעביר אותו.</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {(["vocals", "playback"] as const).map((library) => (
          <LibraryColumn
            key={library}
            title={library === "vocals" ? "קולות הזמר" : "פלייבאק"}
            library={library}
            count={library === "vocals" ? counts.vocals : counts.playback}
            nodes={nodes}
            onFolder={onFolder}
            onPlay={onPlay}
            onExport={onExport}
            onExportMany={onExportMany}
            onRename={onRename}
            onMove={onMove}
            onDropMove={onDropMove}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  );
}

function LibraryColumn(props: {
  title: string;
  library: LibraryId;
  count: number;
  nodes: LibraryNode[];
  onFolder: (library: LibraryId, parentId: string | null) => void;
  onPlay: (node: LibraryNode) => void;
  onExport: (node: LibraryNode) => void;
  onExportMany: (nodes: LibraryNode[]) => void;
  onRename: (node: LibraryNode) => void;
  onMove: (node: LibraryNode) => void;
  onDropMove: (id: string, library: LibraryId, parentId: string | null) => void;
  onDelete: (node: LibraryNode) => void;
}) {
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const folder = folderId ? props.nodes.find((node) => node.id === folderId && node.kind === "folder") : undefined;
  const parentId = folder?.id ?? null;
  const needle = query.trim().toLowerCase();
  const visible = props.nodes.filter((node) => {
    if (node.library !== props.library) return false;
    if (needle) return node.name.toLowerCase().includes(needle);
    return node.parentId === parentId;
  });
  const folders = visible.filter((node) => node.kind === "folder");
  const files = visible.filter((node) => node.kind === "file");
  const pickedNodes = files.filter((node) => picked.includes(node.id));

  function takeDrop(event: DragEvent, nextParent: string | null) {
    event.preventDefault();
    setDropOver(null);
    const id = event.dataTransfer.getData("text/ulpan-id");
    if (id) props.onDropMove(id, props.library, nextParent);
  }

  return (
    <div
      className={`rounded-xl border bg-bg p-3 ${dropOver === "root" ? "border-primary" : "border-line"}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropOver("root");
      }}
      onDragLeave={() => setDropOver(null)}
      onDrop={(event) => takeDrop(event, parentId)}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">
          {props.title}
          <span className="ms-2 text-sm text-muted">{props.count}</span>
        </h3>
        <button type="button" className={rowBtn} onClick={() => props.onFolder(props.library, parentId)}>
          תיקייה חדשה
        </button>
      </div>
      <input
        className="mt-3 h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm"
        value={query}
        placeholder={`חיפוש ב${props.title}`}
        onChange={(event) => setQuery(event.target.value)}
      />
      {folder && !needle && (
        <button type="button" className="mt-2 text-sm text-primary" onClick={() => setFolderId(folder.parentId)}>
          חזרה אל {folder.parentId ? "התיקייה הקודמת" : props.title}
        </button>
      )}
      {pickedNodes.length > 0 && (
        <button type="button" className={`${rowBtn} mt-2`} onClick={() => props.onExportMany(pickedNodes)}>
          ייצוא {pickedNodes.length} נבחרים
        </button>
      )}
      {folders.length === 0 && files.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{needle ? "אין תוצאות." : "עדיין אין שירים."}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {folders.map((node) => (
            <li
              key={node.id}
              className={`rounded-lg border p-3 ${dropOver === node.id ? "border-primary" : "border-line"}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDropOver(node.id);
              }}
              onDrop={(event) => {
                event.stopPropagation();
                takeDrop(event, node.id);
              }}
            >
              <p className="break-words text-sm leading-6" dir="auto">
                תיקייה: {node.name}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                <button type="button" className={rowBtn} onClick={() => { setFolderId(node.id); setQuery(""); }}>
                  פתח
                </button>
                <button type="button" className={rowBtn} onClick={() => props.onRename(node)}>שם</button>
                <button type="button" className={rowBtn} onClick={() => props.onMove(node)}>העבר</button>
                <button type="button" className={rowBtn} onClick={() => props.onDelete(node)}>מחק</button>
              </div>
            </li>
          ))}
          {files.map((node) => (
            <li
              key={node.id}
              className="rounded-lg border border-line p-3"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("text/ulpan-id", node.id);
                event.dataTransfer.effectAllowed = "move";
              }}
            >
              <label className="flex items-start gap-2">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={picked.includes(node.id)}
                  onChange={(event) =>
                    setPicked((current) =>
                      event.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id),
                    )
                  }
                />
                <span className="block min-w-0 flex-1 whitespace-normal break-words text-sm leading-6" dir="auto">
                  {node.name}
                  {typeof node.durationSec === "number" ? ` · ${formatClock(node.durationSec)}` : ""}
                </span>
              </label>
              <div className="mt-2 flex flex-wrap gap-1">
                <button type="button" className={rowBtn} onClick={() => props.onPlay(node)}>נגן</button>
                <button type="button" className={rowBtn} onClick={() => props.onExport(node)}>ייצוא</button>
                <button type="button" className={rowBtn} onClick={() => props.onRename(node)}>שם</button>
                <button type="button" className={rowBtn} onClick={() => props.onMove(node)}>העבר</button>
                <button type="button" className={rowBtn} onClick={() => props.onDelete(node)}>מחק</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StudioDialog({
  dialog,
  draft,
  nodes,
  exporting,
  onDraft,
  onClose,
  onDownload,
  onExport,
  onFormat,
  onSubmit,
  onMove,
  onDelete,
}: {
  dialog: DialogState;
  draft: string;
  nodes: LibraryNode[];
  exporting: boolean;
  onDraft: (value: string) => void;
  onClose: () => void;
  onDownload: () => void;
  onExport: () => void;
  onFormat: (format: "wav" | "mp3") => void;
  onSubmit: () => void;
  onMove: (library: LibraryId, parentId: string | null) => void;
  onDelete: () => void;
}) {
  const open = dialog !== null;
  const folders = nodes.filter((node) => node.kind === "folder");
  const moving = dialog?.type === "move" ? nodes.find((node) => node.id === dialog.id) : undefined;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg/80" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 text-fg">
          {dialog?.type === "download" && (
            <>
              <Dialog.Title className="text-lg font-semibold">הורדת המודל פעם אחת</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-pretty text-muted">
                כ-336 מגה-בייט יישמרו בדפדפן הזה. השיר עצמו לא עולה לרשת. אחר כך ההפרדה רצה על
                כרטיס המסך.
              </Dialog.Description>
              <div className="mt-5 flex flex-wrap gap-2">
                <button type="button" className={btnPrimary} onClick={onDownload}>
                  הורד והפרד
                </button>
                <button type="button" className={btnQuiet} onClick={onClose}>
                  ביטול
                </button>
              </div>
            </>
          )}
          {(dialog?.type === "folder" || dialog?.type === "rename") && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <Dialog.Title className="text-lg font-semibold">
                {dialog.type === "folder" ? "תיקייה חדשה" : "שינוי שם"}
              </Dialog.Title>
              <input
                className="mt-4 h-11 w-full rounded-xl border border-line bg-bg px-3 text-fg"
                value={draft}
                onChange={(event) => onDraft(event.target.value)}
                autoFocus
              />
              <div className="mt-5 flex gap-2">
                <button type="submit" className={btnPrimary}>
                  שמירה
                </button>
                <button type="button" className={btnQuiet} onClick={onClose}>
                  ביטול
                </button>
              </div>
            </form>
          )}
          {dialog?.type === "delete" && (
            <>
              <Dialog.Title className="text-lg font-semibold">למחוק את {dialog.name}?</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">
                {dialog.kind === "folder" ? "התיקייה וכל מה שבתוכה יימחקו." : "הקובץ יימחק מהספרייה."}
              </Dialog.Description>
              <div className="mt-5 flex gap-2">
                <button type="button" className={`${btn} bg-danger text-bg`} onClick={onDelete}>
                  מחיקה
                </button>
                <button type="button" className={btnQuiet} onClick={onClose}>
                  ביטול
                </button>
              </div>
            </>
          )}
          {dialog?.type === "export" && (
            <>
              <Dialog.Title className="text-lg font-semibold">ייצוא</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">
                {dialog.items.length === 1 ? dialog.items[0].name : `${dialog.items.length} קבצים`}
              </Dialog.Description>
              <div className="mt-4 flex flex-col gap-2">
                {(["mp3", "wav"] as const).map((format) => (
                  <label key={format} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="export-format"
                      checked={dialog.format === format}
                      onChange={() => onFormat(format)}
                    />
                    {format === "mp3" ? "MP3" : "WAV"}
                    {savedExportFormat() === format ? " · הייצוא האחרון" : ""}
                  </label>
                ))}
              </div>
              <div className="mt-5 flex gap-2">
                <button type="button" className={btnPrimary} disabled={exporting} onClick={onExport}>
                  {exporting ? "מייצא..." : "ייצוא"}
                </button>
                <button type="button" className={btnQuiet} onClick={onClose}>
                  ביטול
                </button>
              </div>
            </>
          )}
          {dialog?.type === "move" && moving && (
            <>
              <Dialog.Title className="text-lg font-semibold">העברה</Dialog.Title>
              <div className="mt-4 flex flex-col gap-2">
                <DestButton label="שורש קולות הזמר" onClick={() => onMove("vocals", null)} />
                <DestButton label="שורש הפלייבאק" onClick={() => onMove("playback", null)} />
                {folders.map((folder) => (
                  <DestButton
                    key={folder.id}
                    label={`${folder.library === "vocals" ? "קולות" : "פלייבאק"} / ${folder.name}`}
                    onClick={() => onMove(folder.library, folder.id)}
                  />
                ))}
              </div>
            </>
          )}
          <Dialog.Close className={`${iconBtn} absolute top-3 left-3`} aria-label="סגירה">
            <X aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DestButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={`${btnQuiet} justify-start`} onClick={onClick}>
      {label}
    </button>
  );
}
