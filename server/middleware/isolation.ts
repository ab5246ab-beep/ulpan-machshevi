/** Lets the page use WASM threads inside an embedded preview (Chrome). */
const ISOLATION: Record<string, string> = {
  "Document-Isolation-Policy": "isolate-and-credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default async function isolationMiddleware(
  _event: unknown,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const result = await next();
  if (result instanceof Response) {
    const headers = new Headers(result.headers);
    for (const [key, value] of Object.entries(ISOLATION)) headers.set(key, value);
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers,
    });
  }
  return result;
}
