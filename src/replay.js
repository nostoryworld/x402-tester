/**
 * Signed-payment replay protection check.
 *
 * An x402 payment is a signed authorization (EIP-3009
 * TransferWithAuthorization on EVM, a signed transaction on Solana)
 * that must only ever settle once. If an endpoint serves the paid
 * resource twice for the same signed payment, one authorization can
 * be reused to buy the resource again — a replay attack. A correct
 * endpoint + facilitator pair rejects the second use: the facilitator
 * knows the nonce is spent (on-chain, after settlement) and its
 * /verify fails, so the endpoint answers 402.
 *
 * This module probes that property against a live endpoint +
 * facilitator pair (or the local mock stack, via `runReplayCheck`):
 *
 *   1. handshake — unpaid request must 402 with a usable option
 *   2. sign      — one payment is signed locally (throwaway key)
 *   3. first paid request — the signed payment buys the resource (200)
 *   4. settle    — the payment is settled via the facilitator, which
 *                  marks its nonce spent (what a real endpoint does
 *                  after serving, and what the chain enforces)
 *   5. replay    — the exact same X-PAYMENT header is sent again
 *
 * Verdicts:
 *   - "protected": the replay was rejected (any 4xx) — the endpoint
 *     refuses to serve the same signed payment twice. `ok` is true.
 *   - "replayable": the replay served the resource again (200) — the
 *     same authorization bought the resource twice. `ok` is false:
 *     this is a security failure, so the run exits 1 like any other
 *     failed check, and under --ci it surfaces as an error annotation.
 *   - "inconclusive": the probe could not tell — the handshake, the
 *     first payment, or the settle step failed, or the replay attempt
 *     itself errored (transport failure, 5xx). The failing step says
 *     why; `ok` is false, because an unproven property is not a pass.
 *
 * Everything runs locally against the mock stack by default; no chain,
 * no funds. The probe never signs a second payment and never spends
 * anything twice — the whole point is that one signature is reused.
 */

import { signPayment, generateTestKey } from "./pay.js";
import { normalizeRequirement } from "./requirements.js";
import { startMockFacilitator } from "./mockFacilitator.js";
import { startMockEndpoint, defaultTestRequirement } from "./endtoend.js";
import { DEFAULT_TIMEOUT_MS } from "./retry.js";

/**
 * Probe replay protection against an endpoint + facilitator pair.
 * Returns { ok, verdict, steps, endpointUrl, facilitatorUrl,
 * nonce, replayStatus }. Steps continue after failures so the report
 * shows the full picture; a step that cannot run is recorded as
 * failed with "skipped — …" rather than silently omitted.
 */
export async function probeReplayProtection({
  endpointUrl,
  facilitatorUrl,
  requirement,
  privateKey,
  nowSec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    return ok;
  };
  const fetchJson = async (url, init) => {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON bodies stay null */
    }
    return { res, body };
  };

  // 1. handshake — unpaid request must 402 with a usable payment option
  let offered = null;
  try {
    const { res, body } = await fetchJson(endpointUrl);
    offered = body && Array.isArray(body.accepts) ? body.accepts[0] : null;
    step(
      "handshake",
      res.status === 402 && !!offered,
      res.status === 402 && offered
        ? `402 with ${body.accepts.length} payment option(s): ${offered.network}, ${offered.amount} atomic units`
        : `expected 402 with accepts, got HTTP ${res.status}`
    );
  } catch (err) {
    step("handshake", false, `request failed: ${err.message}`);
  }

  // 2. sign — build the single X-PAYMENT payload this probe reuses
  let signed = null;
  try {
    signed = await signPayment(requirement, privateKey, { nowSec });
    step(
      "sign",
      true,
      `payment signed by ${signed.payload.payload.authorization.from} for ${signed.payload.payload.authorization.value} atomic units (nonce ${signed.payload.payload.authorization.nonce.slice(0, 10)}…)`
    );
  } catch (err) {
    step("sign", false, `signing failed: ${err.message}`);
  }

  // 3. first paid request — the signed payment must buy the resource
  let firstPaid = false;
  if (signed) {
    try {
      const { res, body } = await fetchJson(endpointUrl, {
        headers: { "X-PAYMENT": signed.header },
      });
      firstPaid = res.status === 200 && body && !!body.resource;
      step(
        "first paid request",
        firstPaid,
        firstPaid
          ? `HTTP 200 — resource received: "${String(body.resource).slice(0, 60)}…"`
          : `expected HTTP 200 with the resource, got HTTP ${res.status}: ${body?.error ?? "no body"}`
      );
    } catch (err) {
      step("first paid request", false, `paid request failed: ${err.message}`);
    }
  } else {
    step("first paid request", false, "skipped — nothing was signed");
  }

  // 4. settle — the facilitator settles the payment, spending its
  // nonce. Without this step a replay proves nothing: an endpoint
  // that never settles has no spent nonce to check against.
  let settled = false;
  if (signed && firstPaid) {
    try {
      const { body } = await fetchJson(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: signed.payload,
          paymentRequirements: [offered ?? requirement],
        }),
      });
      settled = body && body.success === true;
      step(
        "settle",
        settled,
        settled
          ? `facilitator settled the payment (tx ${String(body.transaction).slice(0, 18)}…) — nonce is now spent`
          : `facilitator refused to settle: ${body?.errorReason ?? "unknown reason"}`
      );
    } catch (err) {
      step("settle", false, `settle request failed: ${err.message}`);
    }
  } else {
    step("settle", false, "skipped — the first payment never went through");
  }

  // 5. replay — the exact same signed payment, byte for byte.
  // A 4xx means the endpoint refused the reused authorization
  // (protected); a 200 means it served the resource twice
  // (replayable); anything else leaves the question open.
  let verdict = "inconclusive";
  let replayStatus = null;
  if (signed && firstPaid && settled) {
    try {
      const { res, body } = await fetchJson(endpointUrl, {
        headers: { "X-PAYMENT": signed.header },
      });
      replayStatus = res.status;
      if (res.status >= 400 && res.status < 500) {
        verdict = "protected";
        step(
          "replay",
          true,
          `endpoint rejected the reused payment (HTTP ${res.status}${body?.error ? `: ${body.error}` : ""})`
        );
      } else if (res.status === 200) {
        verdict = "replayable";
        step(
          "replay",
          false,
          `endpoint served the resource again for the same signed payment (HTTP 200) — one authorization bought the resource twice`
        );
      } else {
        step(
          "replay",
          false,
          `replay attempt answered HTTP ${res.status} — not a clean rejection, so protection cannot be confirmed`
        );
      }
    } catch (err) {
      step("replay", false, `replay request failed: ${err.message}`);
    }
  } else {
    step("replay", false, "skipped — the payment was never settled, so there is no spent nonce to replay against");
  }

  return {
    ok: verdict === "protected",
    verdict,
    steps,
    endpointUrl,
    facilitatorUrl,
    nonce: signed ? signed.payload.payload.authorization.nonce : null,
    replayStatus,
  };
}

/**
 * Full self-contained run: starts a mock facilitator and a mock paid
 * endpoint, probes replay protection, tears everything down.
 * `facilitatorOptions` passes through to startMockFacilitator — tests
 * use `{ replayProtection: false }` to exercise the replayable path
 * against a facilitator with no protection.
 * Returns { ok, verdict, steps, endpointUrl, facilitatorUrl,
 * nonce, replayStatus }.
 */
export async function runReplayCheck({
  rawRequirement,
  privateKey,
  nowSec,
  timeoutMs,
  facilitatorOptions,
} = {}) {
  const raw = rawRequirement ?? defaultTestRequirement();
  const requirement = normalizeRequirement(raw, 2);
  const key = privateKey || generateTestKey();

  const facilitator = await startMockFacilitator({ nowSec, ...(facilitatorOptions || {}) });
  const endpoint = await startMockEndpoint({
    facilitatorUrl: facilitator.url,
    rawRequirement: raw,
  });
  try {
    return await probeReplayProtection({
      endpointUrl: endpoint.url,
      facilitatorUrl: facilitator.url,
      requirement,
      privateKey: key,
      nowSec,
      timeoutMs,
    });
  } finally {
    await endpoint.close();
    await facilitator.close();
  }
}

export function formatReplayReport(report) {
  const lines = [
    "x402 replay protection check (mock facilitator — no real funds)",
    `endpoint: ${report.endpointUrl}`,
    `facilitator: ${report.facilitatorUrl}`,
    "",
  ];
  for (const s of report.steps) {
    lines.push(`[${s.ok ? "✓" : "✗"}] ${s.name} — ${s.detail}`);
  }
  lines.push("");
  if (report.verdict === "protected") {
    lines.push(
      "verdict: PROTECTED — the endpoint refused to serve the same signed payment twice"
    );
  } else if (report.verdict === "replayable") {
    lines.push(
      "verdict: REPLAYABLE — the same signed payment bought the resource twice; " +
        "an attacker can reuse one authorization until it expires"
    );
  } else {
    lines.push(
      "verdict: INCONCLUSIVE — the probe could not determine whether replays are rejected (see the failed step above)"
    );
  }
  lines.push(
    `result: ${report.ok ? "PASS" : "FAIL"} (${report.steps.filter((s) => s.ok).length}/${report.steps.length} steps)`
  );
  return lines.join("\n");
}
