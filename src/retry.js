/**
 * Retry and timeout policy for probe requests.
 *
 * Paid endpoints are often slow or flaky on first contact (cold
 * starts, rate-limit bursts, facilitator hiccups), and a single failed
 * probe should not condemn an endpoint that would answer a second
 * later. This module gives every probe the same policy: each attempt
 * gets its own timeout, and only transient failures are retried.
 *
 * What is retried:
 *   - transport failures (fetch throws: DNS, refused, timeout) and
 *   - transient statuses: 429, 502, 503, 504.
 *
 * What is NOT retried:
 *   - 402 (the healthy x402 answer), 200, and every other 4xx — a
 *     definitive answer from the endpoint is never re-asked, so a
 *     retry can never turn a real verdict into a different one.
 *
 * Backoff is exponential from 100ms (100, 200, 400, …) capped at 2s,
 * so retries stay polite. `retries` is the number of retries AFTER
 * the first attempt (0 = the old single-attempt behaviour), capped
 * at 10 so a typo cannot turn one probe into a hammering loop.
 */

export const MAX_RETRIES = 10;
export const DEFAULT_TIMEOUT_MS = 15000;
export const MAX_TIMEOUT_MS = 600000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 2000;

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Validate a retry policy. Returns the normalised
 * { retries, timeoutMs }. Throws on anything out of range so a
 * misconfigured policy fails before a probe runs, not mid-report.
 */
export function normalizeRetryPolicy({
  retries = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    throw new Error(`'retries' must be an integer between 0 and ${MAX_RETRIES}`);
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `'timeoutMs' must be an integer between 1 and ${MAX_TIMEOUT_MS} (milliseconds)`
    );
  }
  return { retries, timeoutMs };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt) {
  // attempt is 0-based (the retry after attempt N sleeps this long).
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

/**
 * Fetch with the shared retry policy. Each attempt gets a fresh
 * per-attempt timeout (a timed-out attempt does not eat the next
 * attempt's budget). Returns { response, attempts }.
 *
 * A retryable response is returned, not thrown, on the final attempt
 * — the caller owns the verdict for that status (e.g. handshake
 * reports "expected 402, got 503"). A transport failure on the final
 * attempt is thrown, as before. `fetchImpl` and `sleep` are injectable
 * for tests; production callers leave them alone.
 */
export async function fetchWithRetry(
  url,
  init = {},
  {
    retries = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = {}
) {
  const policy = normalizeRetryPolicy({ retries, timeoutMs });
  let lastError;
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      if (isRetryableStatus(response.status) && attempt < policy.retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { response, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (attempt < policy.retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }
  }
  // Unreachable: the loop always returns or throws. Kept for clarity.
  throw lastError;
}
