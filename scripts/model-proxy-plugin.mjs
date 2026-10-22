import { MODEL_URL } from "./model-proxy.mjs";

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag"];

function attach(server) {
  server.middlewares.use(async (req, res, next) => {
    const path = (req.url ?? "").split("?", 1)[0];
    if (path !== "/api/model") {
      next();
      return;
    }
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }
    try {
      const headers = new Headers();
      if (req.headers.range) headers.set("range", String(req.headers.range));
      const upstream = await fetch(MODEL_URL, { headers, redirect: "follow" });
      res.statusCode = upstream.status;
      for (const key of PASS) {
        const value = upstream.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      res.setHeader("cache-control", "no-store");
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  });
}

export function modelProxyPlugin() {
  return {
    name: "app-builder:model-proxy",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
