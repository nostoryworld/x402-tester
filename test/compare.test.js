import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffHandshakes,
  compareEndpoints,
  formatCompareReport,
} from "../src/compare.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

// Fabricated handshake reports shaped like checkHandshake's output.
function handshake(overrides = {}) {
  return {
    url: "https://example.com/paid-api",
    ok: true,
    status: 402,
    method: "GET",
    latencyMs: 42,
    attempts: 1,
    version: 2,
    requirements: {
      scheme: "exact",
      network: "base",
      payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amount: "20000",
      maxTimeoutSeconds: 60,
      resource: "https://example.com/paid-api",
      description: "Paid API access",
      mimeType: "application/json",
      extra: null,
      version: 2,
    },
    price: "0.02 USDC",
    options: 1,
    warnings: [],
    ...overrides,
  };
}

test("diffHandshakes reports no differences for identical handshakes", () => {
  assert.deepEqual(diffHandshakes(handshake(), handshake()), []);
});

test("diffHandshakes flags a price difference", () => {
  const a = handshake();
  const b = handshake({ price: "0.05 USDC" });
  assert.deepEqual(diffHandshakes(a, b), [
    { field: "price", a: "0.02 USDC", b: "0.05 USDC" },
  ]);
});

test("diffHandshakes flags network, payTo, scheme and version differences", () => {
  const a = handshake();
  const b = handshake({
    version: 1,
    requirements: {
      ...handshake().requirements,
      scheme: "upto",
      network: "ethereum",
      payTo: "0x0000000000000000000000000000000000000001",
    },
  });
  const fields = diffHandshakes(a, b).map((d) => d.field);
  assert.deepEqual(fields, ["version", "scheme", "network", "payTo"]);
});

test("diffHandshakes flags asset, timeout, resource, description, mimeType and options", () => {
  const a = handshake();
  const b = handshake({
    options: 2,
    requirements: {
      ...handshake().requirements,
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      maxTimeoutSeconds: 120,
      resource: "https://example.com/other",
      description: "Other access",
      mimeType: "text/plain",
    },
  });
  const fields = diffHandshakes(a, b).map((d) => d.field);
  assert.deepEqual(fields, [
    "asset",
    "maxTimeoutSeconds",
    "resource",
    "description",
    "mimeType",
    "options",
  ]);
});

test("diffHandshakes treats a missing field on one side as a difference, not a crash", () => {
  const a = handshake();
  const b = handshake({
    requirements: { ...handshake().requirements, description: undefined },
  });
  assert.deepEqual(diffHandshakes(a, b), [
    { field: "description", a: "Paid API access", b: null },
  ]);
});

test("diffHandshakes does not flag latency or warnings as differences", () => {
  const a = handshake({ latencyMs: 10, warnings: [] });
  const b = handshake({ latencyMs: 900, warnings: ["slow"] });
  assert.deepEqual(diffHandshakes(a, b), []);
});

test("compareEndpoints reports identical for matching handshakes", async () => {
  const seen = [];
  const report = await compareEndpoints("https://a.example/paid", "https://b.example/paid", {
    method: "POST",
    retries: 2,
    timeoutMs: 500,
    check: async (url, opts) => {
      seen.push([url, opts]);
      return handshake({ url });
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.identical, true);
  assert.deepEqual(report.differences, []);
  assert.equal(report.urlA, "https://a.example/paid");
  assert.equal(report.urlB, "https://b.example/paid");
  assert.deepEqual(seen, [
    ["https://a.example/paid", { method: "POST", retries: 2, timeoutMs: 500 }],
    ["https://b.example/paid", { method: "POST", retries: 2, timeoutMs: 500 }],
  ]);
});

test("compareEndpoints reports differences without failing the run", async () => {
  const report = await compareEndpoints("https://a.example/paid", "https://b.example/paid", {
    check: async (url) =>
      url.includes("://a.")
        ? handshake({ url })
        : handshake({ url, price: "0.05 USDC" }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.identical, false);
  assert.deepEqual(report.differences, [
    { field: "price", a: "0.02 USDC", b: "0.05 USDC" },
  ]);
});

test("compareEndpoints reports the failure itself when one handshake fails", async () => {
  const report = await compareEndpoints("https://a.example/paid", "https://b.example/paid", {
    check: async (url) =>
      url.includes("://a.")
        ? handshake({ url })
        : { url, ok: false, error: "expected HTTP 402 Payment Required, got 200", latencyMs: 5 },
  });
  assert.equal(report.ok, false);
  assert.equal(report.identical, false);
  assert.deepEqual(report.differences, [
    {
      field: "handshake",
      a: "ok",
      b: "expected HTTP 402 Payment Required, got 200",
    },
  ]);
});

test("compareEndpoints reports both failures when neither handshake passes", async () => {
  const report = await compareEndpoints("https://a.example/paid", "https://b.example/paid", {
    check: async (url) => ({
      url,
      ok: false,
      error: "request failed: down",
      latencyMs: 1,
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.identical, false);
  assert.deepEqual(report.differences, [
    { field: "handshake", a: "request failed: down", b: "request failed: down" },
  ]);
});

test("formatCompareReport shows both sides and the differences", () => {
  const text = formatCompareReport({
    urlA: "https://a.example/paid",
    urlB: "https://b.example/paid",
    ok: true,
    identical: false,
    differences: [
      { field: "price", a: "0.02 USDC", b: "0.05 USDC" },
      { field: "network", a: "base", b: "ethereum" },
    ],
    a: handshake({ url: "https://a.example/paid", latencyMs: 40 }),
    b: handshake({ url: "https://b.example/paid", latencyMs: 120, price: "0.05 USDC" }),
  });
  assert.match(text, /x402 handshake compare: https:\/\/a\.example\/paid vs https:\/\/b\.example\/paid/);
  assert.match(text, /status: OK \(both handshakes valid\)/);
  assert.match(text, /A: https:\/\/a\.example\/paid/);
  assert.match(text, /B: https:\/\/b\.example\/paid/);
  assert.match(text, /latency: 40ms \(A\) vs 120ms \(B\)/);
  assert.match(text, /identical: no — 2 differences:/);
  assert.match(text, /- price: 0\.02 USDC vs 0\.05 USDC/);
  assert.match(text, /- network: base vs ethereum/);
});

test("formatCompareReport says identical when the terms match", () => {
  const text = formatCompareReport({
    urlA: "https://a.example/paid",
    urlB: "https://b.example/paid",
    ok: true,
    identical: true,
    differences: [],
    a: handshake({ url: "https://a.example/paid" }),
    b: handshake({ url: "https://b.example/paid" }),
  });
  assert.match(text, /identical: yes — the handshakes offer the same payment terms/);
  assert.doesNotMatch(text, /difference/);
});

test("formatCompareReport shows the failing side when a handshake fails", () => {
  const text = formatCompareReport({
    urlA: "https://a.example/paid",
    urlB: "https://b.example/paid",
    ok: false,
    identical: false,
    differences: [
      { field: "handshake", a: "ok", b: "expected HTTP 402 Payment Required, got 200" },
    ],
    a: handshake({ url: "https://a.example/paid" }),
    b: {
      url: "https://b.example/paid",
      ok: false,
      error: "expected HTTP 402 Payment Required, got 200",
      latencyMs: 5,
    },
  });
  assert.match(text, /status: FAIL \(one or both handshakes failed\)/);
  assert.match(text, /B: https:\/\/b\.example\/paid — FAIL: expected HTTP 402/);
  assert.match(text, /- handshake: ok vs expected HTTP 402 Payment Required, got 200/);
  assert.doesNotMatch(text, /latency:/);
});

// End-to-end over real local servers: two endpoints offering different
// prices must diff on price only; two identical ones must be identical.
function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

function bodyFor(amount) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount,
        maxTimeoutSeconds: 60,
      },
    ],
  };
}

test("compareEndpoints over real servers diffs price only", async () => {
  const srvA = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyFor("20000")));
  });
  const srvB = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyFor("50000")));
  });
  try {
    const report = await compareEndpoints(addr(srvA), addr(srvB));
    assert.equal(report.ok, true);
    assert.equal(report.identical, false);
    assert.deepEqual(report.differences, [
      { field: "price", a: "0.02 USDC", b: "0.05 USDC" },
    ]);
  } finally {
    srvA.close();
    srvB.close();
  }
});

test("compareEndpoints over real servers reports identical for matching 402s", async () => {
  const handler = (req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyFor("20000")));
  };
  const srvA = await startServer(handler);
  const srvB = await startServer(handler);
  try {
    const report = await compareEndpoints(addr(srvA), addr(srvB));
    assert.equal(report.ok, true);
    assert.equal(report.identical, true);
    assert.deepEqual(report.differences, []);
  } finally {
    srvA.close();
    srvB.close();
  }
});

test("CLI compare finds both URLs when flags come first and last", async () => {
  const srvA = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyFor("20000")));
  });
  const srvB = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyFor("50000")));
  });
  try {
    // Flags before the URLs and a value flag (--report md) after them:
    // the --report value must not be read as a third URL.
    // spawn (not execFileSync): a blocking spawn would freeze this
    // process's event loop, so its own servers could never answer
    // the CLI's fetches — a deadlock, not a CLI bug.
    const { code, stdout } = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cli, "compare", "--method", "POST", addr(srvA), addr(srvB), "--report", "md"],
        { timeout: 20000 }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ code: status, stdout: out, stderr: err }));
    });
    assert.equal(code, 0);
    // --report md renders the differences as a table, not the
    // human-text "- price: … vs …" line.
    assert.match(stdout, /\| field \| `price` \|/);
    assert.match(stdout, /\| a \| `0\.02 USDC` \|/);
    assert.match(stdout, /\| b \| `0\.05 USDC` \|/);
  } finally {
    srvA.close();
    srvB.close();
  }
});

test("CLI compare with one URL fails with a usage error", async () => {
  const srvA = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(bodyFor("20000")));
  });
  try {
    let stderr = "";
    let status = null;
    try {
      execFileSync(process.execPath, [cli, "compare", addr(srvA)], {
        encoding: "utf8",
        timeout: 20000,
      });
    } catch (err) {
      stderr = err.stderr;
      status = err.status;
    }
    assert.match(stderr, /compare needs exactly two URLs/);
    assert.equal(status, 1);
  } finally {
    srvA.close();
  }
});
