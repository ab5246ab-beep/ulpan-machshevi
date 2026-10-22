export const MODEL_URL =
  "https://github.com/santiquiroz/port-bs-roformer-onnx/releases/download/models-v1.0/mel_band_roformer_kim_T801.onnx";

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag"];

/** @param {Request} request */
export async function fetchUpstream(request) {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetch(MODEL_URL, { headers, redirect: "follow" });
  const out = new Headers();
  for (const key of PASS) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  out.set("cache-control", "no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
