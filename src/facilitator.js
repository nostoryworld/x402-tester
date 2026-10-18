/**
 * Facilitator reachability check.
 *
 * Before money moves, the x402 flow depends on a third-party facilitator
 * (Coinbase's, CDP's, or a self-hosted one) whose `/verify` endpoint
 * confirms that a signed payment is valid. If that endpoint is down, the
 * paid endpoint is effectively broken even when its 402 handshake is
 * perfect — so checking it is a core part of testing an x402 integration.
 *
 * This module probes `POST {facilitator}/verify` to see whether the
 * facilitator is alive. No real payment is needed: we send an intentionally
 * empty JSON body. Any HTTP response — even a 4xx rejecting the empty
 * probe — proves the facilitator is up and answering. Only a
 * transport-level failure (DNS, connection refused, timeout) counts as
 * unreachable.
 */

const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);

/**
 * Resolve the /verify URL for a facilitator base URL, handling
 * trailing slashes so `<base>/` and `<base>` both work.
 */
export function facilitatorVerifyUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("a facilitator base URL is required");
  return `${trimmed}/verify`;
}

/**
 * Probe a facilitator's /verify endpoint. Returns a structured report:
 *
 *   { url, verifyUrl, reachable, status?, diagnosis?, error?, latencyMs }
 *
 * `reachable` is true whenever the facilitator answered with any HTTP
 * status; only transport failures (DNS, refused, timeout) report
 * `reachable: false`.
 */
export async function checkFacilitator(url, { timeoutMs = 15000 } = {}) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  let verifyUrl;
  try {
    verifyUrl = facilitatorVerifyUrl(url);
  } catch (err) {
    return {
      url,
      verifyUrl: null,
      reachable: false,
      error: err.message,
      latencyMs: elapsed(),
    };
  }

  let res;
  try {
    res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = TIMEOUT_NAMES.has(err.name)
      ? `request timed out after ${timeoutMs}ms`
      : err.cause?.message || err.message;
    return {
      url,
      verifyUrl,
      reachable: false,
      error: `facilitator unreachable: ${reason}`,
      latencyMs: elapsed(),
    };
  }

  const latencyMs = elapsed();
  let diagnosis;
  if (res.status >= 200 && res.status < 300) {
    diagnosis =
      "reachable; /verify accepted the empty probe payload (unexpected — " +
      "a real facilitator normally rejects an unsigned payload)";
  } else if (res.status >= 400 && res.status < 500) {
    diagnosis =
      `reachable; /verify rejected the empty probe payload with HTTP ` +
      `${res.status} (expected — pass a real signed payment to check ` +
      "actual verification behavior)";
  } else {
    diagnosis =
      `reachable but /verify answered HTTP ${res.status} (the facilitator ` +
      "is up but unhealthy)";
  }

  return { url, verifyUrl, reachable: true, status: res.status, latencyMs, diagnosis };
}

export function formatFacilitatorReport(r) {
  const lines = [
    `x402 facilitator check: ${r.url}`,
    `status: ${r.reachable ? "REACHABLE" : "UNREACHABLE"} (${r.latencyMs}ms)`,
  ];
  if (r.verifyUrl) lines.push(`probed: POST ${r.verifyUrl}`);
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.diagnosis) lines.push(`diagnosis: ${r.diagnosis}`);
  return lines.join("\n");
}
