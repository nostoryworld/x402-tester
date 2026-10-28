/**
 * Latency benchmark mode: p50/p95 over N probes.
 *
 * A single handshake latency tells you almost nothing — one cold
 * start, one slow hop, and the number is meaningless. Benchmark mode
 * probes the same endpoint N times in a row and summarises the
 * successful handshake latencies: min, mean, p50, p95, max.
 *
 * Probes run sequentially, not in parallel: firing N requests at once
 * would measure the endpoint under self-inflicted load, not its
 * ordinary response time. Only successful handshakes count as
 * latency samples — a failed probe (wrong status, bad body, transport
 * error) is reported as a failure, never folded into the percentiles,
 * so a flaky endpoint cannot hide behind a fast-looking p50.
 *
 * Percentiles use the nearest-rank method on the sorted samples:
 * p50 of [10, 20, 30, 40] is 20 (the 2nd of 4). `probe` defaults to
 * checkHandshake and is injectable for tests.
 */

import { checkHandshake } from "./handshake.js";
import { DEFAULT_TIMEOUT_MS } from "./retry.js";

export const DEFAULT_PROBES = 10;
export const MAX_PROBES = 100;

/**
 * Validate a probe count. Returns it unchanged. Throws on anything
 * out of range so a typo cannot turn one benchmark into a
 * hundred-request hammering run.
 */
export function normalizeProbes(probes = DEFAULT_PROBES) {
  if (!Number.isInteger(probes) || probes < 1 || probes > MAX_PROBES) {
    throw new Error(
      `'probes' must be an integer between 1 and ${MAX_PROBES}`
    );
  }
  return probes;
}

/**
 * Nearest-rank percentile of a sorted (ascending) array of numbers.
 * Returns null for an empty array. Callers sort first; this function
 * does not re-sort, so the contract is explicit.
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Summarise raw latency samples (milliseconds). Returns null stats
 * when there are no samples — callers must not invent a p50 from
 * zero successful probes.
 */
export function summarizeLatencies(latencies) {
  const samples = [...latencies].sort((a, b) => a - b);
  if (samples.length === 0) {
    return {
      count: 0,
      minMs: null,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }
  const sum = samples.reduce((total, ms) => total + ms, 0);
  return {
    count: samples.length,
    minMs: samples[0],
    meanMs: sum / samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: samples[samples.length - 1],
  };
}

/**
 * Probe `url` N times and summarise the successful handshake
 * latencies. `ok` is true only when every probe succeeded, matching
 * batch mode's all-or-nothing gate — a partial run still reports its
 * stats, but does not exit clean.
 */
export async function runBenchmark(
  url,
  {
    probes = DEFAULT_PROBES,
    method = "GET",
    retries = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    probe = checkHandshake,
  } = {}
) {
  const count = normalizeProbes(probes);
  const latencies = [];
  const failures = [];
  for (let i = 0; i < count; i++) {
    const result = await probe(url, { method, retries, timeoutMs });
    if (result.ok && typeof result.latencyMs === "number") {
      latencies.push(result.latencyMs);
    } else {
      failures.push({
        probe: i + 1,
        error: result.error || "probe failed without an error message",
      });
    }
  }
  const stats = summarizeLatencies(latencies);
  return {
    url,
    ok: failures.length === 0,
    method: String(method || "GET").toUpperCase(),
    probes: count,
    succeeded: latencies.length,
    failed: failures.length,
    latencies,
    ...stats,
    failures,
  };
}

function formatMs(value) {
  if (value === null || value === undefined) return "n/a";
  return `${Math.round(value * 10) / 10}ms`;
}

export function formatBenchmarkReport(report) {
  const lines = [
    `x402 latency benchmark: ${report.url}`,
    `probes: ${report.probes} (${report.succeeded} succeeded, ${report.failed} failed)`,
  ];
  if (report.succeeded > 0) {
    lines.push(
      `min: ${formatMs(report.minMs)} | mean: ${formatMs(report.meanMs)} | ` +
        `p50: ${formatMs(report.p50Ms)} | p95: ${formatMs(report.p95Ms)} | ` +
        `max: ${formatMs(report.maxMs)}`
    );
    lines.push(`latencies: ${report.latencies.join("ms, ")}ms`);
  } else {
    lines.push("no successful probes — no latency stats to report");
  }
  for (const failure of report.failures || []) {
    lines.push(`probe ${failure.probe} failed: ${failure.error}`);
  }
  return lines.join("\n");
}
