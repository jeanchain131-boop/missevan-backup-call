import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp, getPort } from "../src/server.js";

async function withServer(app, fn) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function createFetchResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

function createTestApp(options = {}) {
  return createApp({
    logger: () => {},
    ...options,
  });
}

test("healthz returns 204 without calling upstream", async () => {
  let called = false;
  const app = createTestApp({
    proxyToken: "secret",
    fetchImpl: async () => {
      called = true;
      return createFetchResponse("{}");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 204);
    assert.equal(called, false);
  });
});

test("default local port is 6333", () => {
  assert.equal(getPort({}), 6333);
  assert.equal(getPort({ LOCAL_PORT: "6444" }), 6444);
  assert.equal(getPort({ PORT: "7555", LOCAL_PORT: "6444" }), 7555);
});

test("missevan proxy requires x-proxy-token", async () => {
  const app = createTestApp({
    proxyToken: "secret",
    fetchImpl: async () => createFetchResponse("{}"),
  });

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/missevan/sound/getsound?soundid=1`);
    const wrong = await fetch(`${baseUrl}/missevan/sound/getsound?soundid=1`, {
      headers: { "x-proxy-token": "wrong" },
    });

    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "Unauthorized" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "Unauthorized" });
  });
});

test("missevan proxy forwards allowed JSON endpoints", async () => {
  const calls = [];
  const app = createTestApp({
    proxyToken: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createFetchResponse(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missevan/sound/getsound?soundid=1`, {
      headers: { "x-proxy-token": "secret" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.missevan.com/sound/getsound?soundid=1");
    assert.equal(calls[0].options.headers.Referer, "https://www.missevan.com/");
  });
});

test("missevan proxy allows getdm text endpoint", async () => {
  const calls = [];
  const app = createTestApp({
    proxyToken: "secret",
    fetchImpl: async (url) => {
      calls.push(url);
      return createFetchResponse("<i><d p=\"1,2,3,4,5,6,7\">hello</d></i>", {
        headers: { "content-type": "text/xml" },
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missevan/sound/getdm?soundid=1`, {
      headers: { "x-proxy-token": "secret" },
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<i><d p=\"1,2,3,4,5,6,7\">hello</d></i>");
    assert.equal(calls[0], "https://www.missevan.com/sound/getdm?soundid=1");
  });
});

test("missevan proxy blocks assets and unknown paths", async () => {
  let called = false;
  const app = createTestApp({
    proxyToken: "secret",
    fetchImpl: async () => {
      called = true;
      return createFetchResponse("{}");
    },
  });

  await withServer(app, async (baseUrl) => {
    const image = await fetch(`${baseUrl}/missevan/cover.jpg`, {
      headers: { "x-proxy-token": "secret" },
    });
    const audio = await fetch(`${baseUrl}/missevan/audio.mp3`, {
      headers: { "x-proxy-token": "secret" },
    });
    const unknown = await fetch(`${baseUrl}/missevan/unknown/path`, {
      headers: { "x-proxy-token": "secret" },
    });

    assert.equal(image.status, 403);
    assert.deepEqual(await image.json(), { error: "Asset proxy is blocked" });
    assert.equal(audio.status, 403);
    assert.deepEqual(await audio.json(), { error: "Asset proxy is blocked" });
    assert.equal(unknown.status, 403);
    assert.deepEqual(await unknown.json(), { error: "Path is not allowed" });
    assert.equal(called, false);
  });
});

test("missevan proxy normalizes upstream 418 as accessDenied", async () => {
  const app = createTestApp({
    proxyToken: "secret",
    fetchImpl: async () => createFetchResponse(JSON.stringify({ code: 418 }), {
      status: 418,
      headers: { "content-type": "application/json" },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missevan/dramaapi/getdrama?drama_id=1`, {
      headers: { "x-proxy-token": "secret" },
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "Upstream access denied",
      accessDenied: true,
      upstreamStatus: 418,
    });
  });
});

test("missevan proxy returns 504 on upstream timeout", async () => {
  const app = createTestApp({
    proxyToken: "secret",
    upstreamTimeoutMs: 20,
    fetchImpl: async (_url, options) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        });
      });
      return createFetchResponse("{}");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missevan/reward/drama-reward-detail?drama_id=1`, {
      headers: { "x-proxy-token": "secret" },
    });

    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: "Upstream timeout" });
  });
});

test("missevan proxy logs activated visits", async () => {
  const logs = [];
  const app = createTestApp({
    proxyToken: "secret",
    logger: (entry) => logs.push(entry),
    fetchImpl: async () => createFetchResponse(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json" },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missevan/dramaapi/search?s=test`, {
      headers: { "x-proxy-token": "secret" },
    });

    assert.equal(response.status, 200);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, "missevan_proxy_request");
    assert.equal(logs[0].path, "/dramaapi/search");
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].success, true);
    assert.equal(typeof logs[0].durationMs, "number");
    assert.equal(typeof logs[0].bytes, "number");
  });
});
