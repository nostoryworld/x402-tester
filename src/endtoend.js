/**
 * Paid end-to-end test flow against a mock facilitator (no real funds).
 *
 * Spins up two local servers and walks the full x402 paid flow between
 * them:
 *   1. handshake — the mock endpoint answers unpaid requests with 402
 *   2. sign      — a payment is signed locally (throwaway key by default)
 *   3. verify    — the mock facilitator /verify checks the signature
 *   4. paid request — the endpoint re-verifies and serves the resource
 *
 * Everything runs on 127.0.0.1; no chain, no funds, no external calls.
 */

import { createServer } from "node:http";
import { signPayment, generateTestKey } from "./pay.js";
import { normalizeRequirement } from "./requirements.js";
import { startMockFacilitator } from "./mockFacilitator.js";
import { validatePaidResponse } from "./schema.js";

/**
 * The canonical test payment requirement: a v2 `exact` EVM entry for a
 * dust amount of USDC on Base, payable to the burn address. The mock
 * endpoint serves it in its 402 body; signing and verification use the
 * normalized form.
 */
export function defaultTestRequirement() {
  return {
    scheme: "exact",
    network: "eip155:8453",
    payTo: "0x000000000000000000000000000000000000dEaD",
    asset: "0x833589fCD6edB6e08F4C7C32D4F71B54BdA923b6", // USDC on Base
    amount: "1000", // 0.001 USDC — dust, and it never moves anyway
    maxTimeoutSeconds: 300,
    resource: "mock://x402-tester/e2e",
    description: "mock paid resource for end-to-end testing (no real funds)",
    extra: { name: "USD Coin", version: "2" },
  };
}

const MOCK_RESOURCE = {
  resource: "Hello from the mock paid endpoint — this response was 'paid for'.",
  receipt: "verified by the mock facilitator, settled by nobody, worth nothing",
};

/**
 * Start a mock paid endpoint. Unpaid requests get a 402 with `accepts`;
 * requests carrying a valid X-PAYMENT / PAYMENT-SIGNATURE header get the
 * resource after the facilitator's /verify confirms the payment.
 * Returns { url, close() }.
 */
export async function startMockEndpoint({ facilitatorUrl, rawRequirement, port = 0 } = {}) {
  if (!facilitatorUrl) throw new Error("a facilitatorUrl is required");
  const raw = rawRequirement ?? defaultTestRequirement();

  const server = createServer(async (req, res) => {
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    };

    const header =
      req.headers["x-payment"] || req.headers["payment-signature"] || null;
    if (!header) {
      return send(402, {
        x402Version: 2,
        error: "payment required",
        accepts: [raw],
      });
    }

    let paymentPayload;
    try {
      paymentPayload = JSON.parse(
        Buffer.from(String(header), "base64").toString("utf8")
      );
    } catch {
      return send(402, {
        x402Version: 2,
        error: "X-PAYMENT header is not valid base64 JSON",
        accepts: [raw],
      });
    }

    let verdict;
    try {
      const vres = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: [raw],
        }),
        signal: AbortSignal.timeout(10000),
      });
      verdict = await vres.json();
    } catch (err) {
      return send(502, { error: `mock endpoint could not reach the facilitator: ${err.message}` });
    }

    if (!verdict.isValid) {
      return send(402, {
        x402Version: 2,
        error: `payment rejected: ${verdict.invalidReason}`,
        accepts: [raw],
      });
    }

    return send(200, {
      ...MOCK_RESOURCE,
      paidBy: paymentPayload.payload.authorization.from,
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port: boundPort } = server.address();
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Run the four paid-flow steps against a live endpoint + facilitator pair.
 * Steps continue after failures so the report shows the full picture.
 * Returns { ok, steps: [{ name, ok, detail }], resource? }.
 */
export async function probePaidFlow({
  endpointUrl,
  facilitatorUrl,
  requirement,
  privateKey,
  nowSec,
  timeoutMs = 15000,
  expectedSchema,
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

  // 2. sign — build the X-PAYMENT payload locally
  let signed = null;
  try {
    signed = await signPayment(requirement, privateKey, { nowSec });
    step(
      "sign",
      true,
      `payment signed by ${signed.payload.payload.authorization.from} for ${signed.payload.payload.authorization.value} atomic units`
    );
  } catch (err) {
    step("sign", false, `signing failed: ${err.message}`);
  }

  // 3. verify — the facilitator checks the signed payment
  if (signed) {
    try {
      const { body } = await fetchJson(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: signed.payload,
          paymentRequirements: [offered ?? requirement],
        }),
      });
      step(
        "verify",
        body && body.isValid === true,
        body && body.isValid === true
          ? "mock facilitator accepted the signed payment"
          : `facilitator rejected it: ${body?.invalidReason ?? "unknown reason"}`
      );
    } catch (err) {
      step("verify", false, `verify request failed: ${err.message}`);
    }
  } else {
    step("verify", false, "skipped — nothing was signed");
  }

  // 4. paid request — replay the request with the X-PAYMENT header
  let resource = null;
  let paidBody = null;
  if (signed) {
    try {
      const { res, body } = await fetchJson(endpointUrl, {
        headers: { "X-PAYMENT": signed.header },
      });
      if (res.status === 200 && body && body.resource) {
        resource = body.resource;
        paidBody = body;
        step("paid request", true, `HTTP 200 — resource received: "${body.resource.slice(0, 60)}…"`);
      } else {
        step(
          "paid request",
          false,
          `expected HTTP 200 with the resource, got HTTP ${res.status}: ${body?.error ?? "no body"}`
        );
      }
    } catch (err) {
      step("paid request", false, `paid request failed: ${err.message}`);
    }
  } else {
    step("paid request", false, "skipped — nothing was signed");
  }

  // 5. schema — only when the caller supplied a documented shape AND
  // there is a paid response to check. A failed paid request already
  // fails the run; inventing a schema verdict without a response
  // would double-count that failure.
  let schema = null;
  if (expectedSchema && paidBody) {
    try {
      schema = validatePaidResponse(paidBody, expectedSchema);
      step(
        "schema",
        schema.ok,
        schema.ok
          ? "paid response matches the documented shape"
          : `paid response does not match the documented shape: ${schema.errors
              .map((e) => `${e.path}: ${e.message}`)
              .join("; ")}`
      );
    } catch (err) {
      schema = { ok: false, errors: [{ path: "$schema", message: err.message }] };
      step("schema", false, `invalid schema: ${err.message}`);
    }
  }

  return {
    ok: steps.every((s) => s.ok),
    steps,
    resource,
    ...(schema ? { schema } : {}),
  };
}

/**
 * Full self-contained run: starts a mock facilitator and a mock paid
 * endpoint, probes the whole flow, tears everything down.
 * Returns { ok, steps, resource, endpointUrl, facilitatorUrl }.
 */
export async function runPaidEndToEnd({
  rawRequirement,
  privateKey,
  nowSec,
  timeoutMs,
  expectedSchema,
} = {}) {
  const raw = rawRequirement ?? defaultTestRequirement();
  const requirement = normalizeRequirement(raw, 2);
  const key = privateKey || generateTestKey();

  const facilitator = await startMockFacilitator({ nowSec });
  const endpoint = await startMockEndpoint({
    facilitatorUrl: facilitator.url,
    rawRequirement: raw,
  });
  try {
    const report = await probePaidFlow({
      endpointUrl: endpoint.url,
      facilitatorUrl: facilitator.url,
      requirement,
      privateKey: key,
      nowSec,
      timeoutMs,
      expectedSchema,
    });
    return {
      ...report,
      endpointUrl: endpoint.url,
      facilitatorUrl: facilitator.url,
    };
  } finally {
    await endpoint.close();
    await facilitator.close();
  }
}

export function formatEndToEndReport(report) {
  const lines = [
    "x402 paid end-to-end test (mock facilitator — no real funds)",
    `endpoint: ${report.endpointUrl}`,
    `facilitator: ${report.facilitatorUrl}`,
    "",
  ];
  for (const s of report.steps) {
    lines.push(`[${s.ok ? "✓" : "✗"}] ${s.name} — ${s.detail}`);
  }
  lines.push("", `result: ${report.ok ? "PASS" : "FAIL"} (${report.steps.filter((s) => s.ok).length}/${report.steps.length} steps)`);
  return lines.join("\n");
}
