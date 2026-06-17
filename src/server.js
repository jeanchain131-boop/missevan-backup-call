import express from "express";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM_ORIGIN = "https://www.missevan.com";
const DEFAULT_LOCAL_PORT = 6333;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10000;

const MISSEVAN_BROWSER_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Referer": "https://www.missevan.com/",
  "Origin": "https://www.missevan.com",
});

const BLOCKED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".mp4",
  ".m3u8",
  ".ts",
];

const ALLOWED_ENDPOINTS = [
  "/dramaapi/search",
  "/sound/getsound",
  "/dramaapi/getdramabysound",
  "/dramaapi/getdrama",
  "/reward/user-reward-rank",
  "/reward/drama-reward-detail",
  "/sound/getdm",
];

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

export function getPort(env = process.env) {
  return toPositiveInt(env.PORT || env.LOCAL_PORT, DEFAULT_LOCAL_PORT);
}

function normalizeOrigin(origin) {
  const fallback = DEFAULT_UPSTREAM_ORIGIN;

  try {
    const url = new URL(origin || fallback);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function sendJson(res, status, body) {
  res.status(status).type("application/json; charset=utf-8").send(JSON.stringify(body));
}

function isBlockedAsset(pathname) {
  const lowerPathname = String(pathname || "").toLowerCase();
  return BLOCKED_EXTENSIONS.some((extension) => lowerPathname.endsWith(extension));
}

function isAllowedEndpoint(pathname) {
  return ALLOWED_ENDPOINTS.includes(pathname);
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Upstream timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function copySafeHeaders(upstreamResponse, res) {
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) {
    res.setHeader("content-type", contentType);
  }

  const cacheControl = upstreamResponse.headers.get("cache-control");
  res.setHeader("cache-control", cacheControl || "public, max-age=120");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-proxy-token");
}

function getResponseByteLength(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.byteLength : 0;
}

function buildProxyLog({
  req,
  status,
  durationMs,
  bytes,
  success,
  accessDenied = false,
  upstreamStatus = "",
}) {
  return {
    timestamp: new Date().toISOString(),
    action: "missevan_proxy_request",
    method: req.method,
    path: req.proxyPathname || "",
    status,
    upstreamStatus,
    durationMs: Math.max(0, Math.round(durationMs)),
    bytes: Math.max(0, Number(bytes) || 0),
    success: Boolean(success),
    accessDenied: Boolean(accessDenied),
  };
}

function defaultLogger(entry) {
  console.log("[missevan-proxy]", JSON.stringify(entry));
}

export function createApp(options = {}) {
  const app = express();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || defaultLogger;
  const proxyToken = options.proxyToken ?? process.env.PROXY_TOKEN ?? "";
  const upstreamOrigin = normalizeOrigin(
    options.upstreamOrigin ?? process.env.MISSEVAN_UPSTREAM_ORIGIN
  );
  const upstreamTimeoutMs = toPositiveInt(
    options.upstreamTimeoutMs ?? process.env.UPSTREAM_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS
  );

  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.status(204).end();
  });

  app.options("*", (_req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-proxy-token");
    res.status(204).end();
  });

  app.get("/missevan/*", async (req, res) => {
    const startedAt = Date.now();
    let upstreamStatus = "";
    let bytes = 0;
    let logged = false;

    const finishWithLog = (status, body, details = {}) => {
      if (logged) {
        return;
      }
      logged = true;
      const payload = body == null ? "" : JSON.stringify(body);
      logger(buildProxyLog({
        req,
        status,
        upstreamStatus: details.upstreamStatus ?? upstreamStatus,
        durationMs: Date.now() - startedAt,
        bytes: details.bytes ?? Buffer.byteLength(payload),
        success: details.success ?? (status >= 200 && status < 400),
        accessDenied: details.accessDenied,
      }));
    };

    const proxyPathname = `/${String(req.params[0] || "").replace(/^\/+/, "")}`;
    req.proxyPathname = proxyPathname;

    if (proxyToken) {
      const incomingToken = req.get("x-proxy-token") || "";
      if (incomingToken !== proxyToken) {
        const body = { error: "Unauthorized" };
        finishWithLog(401, body, { success: false });
        return sendJson(res, 401, body);
      }
    }

    if (isBlockedAsset(proxyPathname)) {
      const body = { error: "Asset proxy is blocked" };
      finishWithLog(403, body, { success: false });
      return sendJson(res, 403, body);
    }

    if (!isAllowedEndpoint(proxyPathname)) {
      const body = { error: "Path is not allowed" };
      finishWithLog(403, body, { success: false });
      return sendJson(res, 403, body);
    }

    const upstreamUrl = new URL(proxyPathname, upstreamOrigin);
    const queryIndex = req.originalUrl.indexOf("?");
    if (queryIndex >= 0) {
      upstreamUrl.search = req.originalUrl.slice(queryIndex);
    }

    const timeout = createTimeoutSignal(upstreamTimeoutMs);

    try {
      const upstreamResponse = await fetchImpl(upstreamUrl.toString(), {
        method: "GET",
        headers: MISSEVAN_BROWSER_HEADERS,
        signal: timeout.signal,
      });

      upstreamStatus = upstreamResponse.status;

      if (upstreamResponse.status === 418) {
        const body = {
          error: "Upstream access denied",
          accessDenied: true,
          upstreamStatus: upstreamResponse.status,
        };
        finishWithLog(502, body, {
          upstreamStatus: upstreamResponse.status,
          success: false,
          accessDenied: true,
        });
        return sendJson(res, 502, body);
      }

      const arrayBuffer = await upstreamResponse.arrayBuffer();
      const responseBuffer = Buffer.from(arrayBuffer);
      bytes = getResponseByteLength(responseBuffer);

      copySafeHeaders(upstreamResponse, res);
      res.status(upstreamResponse.status).send(responseBuffer);
      finishWithLog(upstreamResponse.status, null, {
        upstreamStatus: upstreamResponse.status,
        bytes,
        success: upstreamResponse.ok,
        accessDenied: false,
      });
    } catch (error) {
      if (timeout.signal.aborted) {
        const body = { error: "Upstream timeout" };
        finishWithLog(504, body, { success: false });
        return sendJson(res, 504, body);
      }

      const body = { error: "Upstream request failed" };
      finishWithLog(502, body, { success: false });
      return sendJson(res, 502, body);
    } finally {
      timeout.cleanup();
    }
  });

  app.use((_req, res) => {
    sendJson(res, 404, { error: "Not found" });
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp();
  const port = getPort();

  app.listen(port, () => {
    console.log(`[missevan-proxy] listening on ${port}`);
  });
}
