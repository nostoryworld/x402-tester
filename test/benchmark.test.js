import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProbes,
  percentile,
  summarizeLatencies,
  runBenchmark,
  formatBenchmarkReport,
} from "../src/benchmark.js";

test("normalizeProbes accepts the default and valid counts", () => {
  assert.equal(normalizeProbes(), 10);
  assert.equal(normalizeProbes(1), 1);
  assert.equal(normalizeProbes(100), 100);
});

test("normalizeProbes rejects out-of-range counts", () => {
  for (const probes of [0, 101, 2.5, "10", null]) {
    assert.throws(() => normalizeProbes(probes), /probes/);
  }
});

test("percentile uses nearest-rank on sorted samples", () => {
  const sorted = [10, 20, 30, 40];
  assert.equal(percentile(sorted, 50), 20);
  assert.equal(percentile(sorted, 95), 40);
  assert.equal(percentile(sorted, 100), 40);
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([], 50), null);
});

test("summarizeLatencies sorts, and reports null stats with no samples", () => {
  assert.deepEqual(summarizeLatencies([]), {
    count: 0,
    minMs: null,
    meanMs: null,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
  const stats = summarizeLatencies([40, 10, 30, 20]);
  assert.equal(stats.count, 4);
  assert.equal(stats.minMs, 10);
  assert.equal(stats.meanMs, 25);
  assert.equal(stats.p50Ms, 20);
  assert.equal(stats.p95Ms, 40);
  assert.equal(stats.maxMs, 40);
});

test("runBenchmark probes sequentially and counts only successful latencies", async () => {
  const seen = [];
  const probe = async (url, opts) => {
    seen.push(opts.method);
    const n = seen.length;
    // probe 2 fails: its latency must not enter the percentiles
    if (n === 2) return { ok: false, error: "expected 402, got 503" };
    return { ok: true, latencyMs: n * 10 };
  };
  const report = await runBenchmark("https://example.com/paid-api", {
    probes: 4,
    method: "POST",
    probe,
  });
  assert.equal(report.probes, 4);
  assert.equal(report.succeeded, 3);
  assert.equal(report.failed, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.latencies, [10, 30, 40]);
  assert.deepEqual(seen, ["POST", "POST", "POST", "POST"]);
  assert.equal(report.p50Ms, 30);
  assert.equal(report.p95Ms, 40);
  assert.deepEqual(report.failures, [
    { probe: 2, error: "expected 402, got 503" },
  ]);
});

test("runBenchmark passes method, retries and timeoutMs through to the probe", async () => {
  let received = null;
  const report = await runBenchmark("https://example.com/paid-api", {
    probes: 1,
    retries: 2,
    timeoutMs: 500,
    probe: async (_url, opts) => {
      received = opts;
      return { ok: true, latencyMs: 12 };
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(received, { method: "GET", retries: 2, timeoutMs: 500 });
});

test("runBenchmark with all probes failing reports null stats, not invented ones", async () => {
  const report = await runBenchmark("https://example.com/paid-api", {
    probes: 2,
    probe: async () => ({ ok: false, error: "request failed: down" }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.succeeded, 0);
  assert.deepEqual(report.latencies, []);
  assert.equal(report.p50Ms, null);
  assert.equal(report.p95Ms, null);
  assert.equal(report.failures.length, 2);
});

test("runBenchmark rejects an invalid probe count before probing", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runBenchmark("https://example.com/paid-api", {
        probes: 0,
        probe: async () => {
          calls += 1;
          return { ok: true, latencyMs: 1 };
        },
      }),
    /probes/
  );
  assert.equal(calls, 0);
});

test("formatBenchmarkReport shows stats and failures in human text", () => {
  const text = formatBenchmarkReport({
    url: "https://example.com/paid-api",
    probes: 3,
    succeeded: 2,
    failed: 1,
    latencies: [10, 30],
    minMs: 10,
    meanMs: 20,
    p50Ms: 10,
    p95Ms: 30,
    maxMs: 30,
    failures: [{ probe: 2, error: "expected 402, got 503" }],
  });
  assert.match(text, /probes: 3 \(2 succeeded, 1 failed\)/);
  assert.match(text, /p50: 10ms \| p95: 30ms/);
  assert.match(text, /probe 2 failed: expected 402, got 503/);
});
