import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithRetry,
  normalizeRetryPolicy,
  isRetryableStatus,
} from "../src/retry.js";

const okResponse = (status = 200) => ({ status });
const neverSleep = () => Promise.resolve();

test("normalizeRetryPolicy accepts the defaults and valid values", () => {
  assert.deepEqual(normalizeRetryPolicy(), { retries: 0, timeoutMs: 15000 });
  assert.deepEqual(normalizeRetryPolicy({ retries: 3, timeoutMs: 500 }), {
    retries: 3,
    timeoutMs: 500,
  });
});

test("normalizeRetryPolicy rejects out-of-range policies", () => {
  for (const policy of [
    { retries: -1 },
    { retries: 11 },
    { retries: 1.5 },
    { retries: "2" },
    { timeoutMs: 0 },
    { timeoutMs: 600001 },
    { timeoutMs: 1.5 },
  ]) {
    assert.throws(() => normalizeRetryPolicy(policy), /retries|timeoutMs/);
  }
});

test("isRetryableStatus covers only transient statuses", () => {
  for (const status of [429, 502, 503, 504]) assert.equal(isRetryableStatus(status), true);
  for (const status of [200, 402, 400, 404, 500]) assert.equal(isRetryableStatus(status), false);
});

test("single attempt on success, no sleep", async () => {
  let calls = 0;
  const sleeps = [];
  const { response, attempts } = await fetchWithRetry("https://example.com", {}, {
    fetchImpl: async () => {
      calls += 1;
      return okResponse(402);
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(response.status, 402);
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("retries a 503 then succeeds, reporting the attempt count", async () => {
  let calls = 0;
  const { response, attempts } = await fetchWithRetry("https://example.com", {}, {
    retries: 2,
    fetchImpl: async () => {
      calls += 1;
      return okResponse(calls === 1 ? 503 : 402);
    },
    sleep: neverSleep,
  });
  assert.equal(response.status, 402);
  assert.equal(attempts, 2);
  assert.equal(calls, 2);
});

test("does not retry a definitive 402 or 404", async () => {
  for (const status of [402, 404]) {
    let calls = 0;
    const { response, attempts } = await fetchWithRetry("https://example.com", {}, {
      retries: 3,
      fetchImpl: async () => {
        calls += 1;
        return okResponse(status);
      },
      sleep: neverSleep,
    });
    assert.equal(response.status, status);
    assert.equal(attempts, 1);
    assert.equal(calls, 1);
  }
});

test("retries a thrown transport error then succeeds", async () => {
  let calls = 0;
  const { response, attempts } = await fetchWithRetry("https://example.com", {}, {
    retries: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection refused");
      return okResponse(402);
    },
    sleep: neverSleep,
  });
  assert.equal(response.status, 402);
  assert.equal(attempts, 2);
});

test("throws after exhausting retries and tries exactly retries + 1 times", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchWithRetry("https://example.com", {}, {
        retries: 2,
        fetchImpl: async () => {
          calls += 1;
          throw new Error("boom");
        },
        sleep: neverSleep,
      }),
    /boom/
  );
  assert.equal(calls, 3);
});

test("returns the last retryable response instead of throwing", async () => {
  let calls = 0;
  const { response, attempts } = await fetchWithRetry("https://example.com", {}, {
    retries: 1,
    fetchImpl: async () => {
      calls += 1;
      return okResponse(503);
    },
    sleep: neverSleep,
  });
  assert.equal(response.status, 503);
  assert.equal(attempts, 2);
  assert.equal(calls, 2);
});

test("backoff doubles per retry and is capped", async () => {
  const sleeps = [];
  // Exercise the cap by stubbing fetch to fail 10 times with retries 10:
  // the sleep sequence must start 100, 200, 400, ... and never exceed 2000.
  let calls = 0;
  await assert.rejects(
    () =>
      fetchWithRetry("https://example.com", {}, {
        retries: 10,
        fetchImpl: async () => {
          calls += 1;
          throw new Error("down");
        },
        sleep: async (ms) => sleeps.push(ms),
      }),
    /down/
  );
  assert.equal(calls, 11);
  assert.deepEqual(sleeps.slice(0, 4), [100, 200, 400, 800]);
  assert.ok(sleeps.every((ms) => ms <= 2000));
  assert.ok(sleeps.includes(2000));
});

test("each attempt gets its own timeout signal", async () => {
  const signals = [];
  let calls = 0;
  const { attempts } = await fetchWithRetry("https://example.com", {}, {
    retries: 1,
    timeoutMs: 5000,
    fetchImpl: async (_url, init) => {
      calls += 1;
      signals.push(init.signal);
      if (calls === 1) throw new Error("first try down");
      return okResponse(402);
    },
    sleep: neverSleep,
  });
  assert.equal(attempts, 2);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0].aborted, false);
});
