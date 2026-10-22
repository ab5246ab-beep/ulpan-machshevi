import { fetchUpstream } from "../../scripts/model-proxy.mjs";

interface ModelProxyEvent {
  url: URL;
  req: { method?: string; headers: Headers };
}

export default async function modelProxyMiddleware(
  event: ModelProxyEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  if (event.url.pathname !== "/api/model") return next();
  if ((event.req.method ?? "GET").toUpperCase() !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    return await fetchUpstream(new Request(event.url, { headers: event.req.headers }));
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new Response(message, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
