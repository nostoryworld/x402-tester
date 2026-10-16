/**
 * Validates the x402 HTTP 402 handshake of a paid endpoint.
 *
 * A healthy x402 endpoint answers unpaid requests with HTTP 402 and a
 * JSON body describing how to pay (the `accepts` array in x402 v2,
 * `paymentRequirements` in v1). This module checks that contract and
 * returns a structured report — no wallet or signing involved.
 *
 * Some endpoints only answer on a specific HTTP method (e.g. a POST-only
 * endpoint may return an empty-body 402 to GET). Use the `method` option
 * to probe with a different method.
 */

import {
  normalizeResponse,
  validateRequirement,
} from "./requirements.js";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

export async function checkHandshake(
  url,
  { timeoutMs = 15000, method = "GET" } = {}
) {
  const startedAt = Date.now();
  const fail = (error, extra = {}) => ({
    url,
    ok: false,
    error,
    latencyMs: Date.now() - startedAt,
    ...extra,
  });

  const httpMethod = String(method || "GET").toUpperCase();
  const init = { method: httpMethod, signal: AbortSignal.timeout(timeoutMs) };
  if (METHODS_WITH_BODY.has(httpMethod)) {
    init.headers = { "content-type": "application/json" };
    init.body = "{}";
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return fail(`request failed: ${err.cause?.message || err.message}`);
  }
  const latencyMs = Date.now() - startedAt;

  if (res.status !== 402) {
    return fail(`expected HTTP 402 Payment Required, got ${res.status}`, {
      status: res.status,
      method: httpMethod,
    });
  }

  const rawText = await res.text();
  if (!rawText.trim()) {
    return fail(
      `402 response has an empty body (probed with ${httpMethod}). ` +
        "Some endpoints only describe payment on a specific method — " +
        "retry with --method POST.",
      { status: 402, method: httpMethod }
    );
  }

  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    return fail("402 response body is not valid JSON", {
      status: 402,
      method: httpMethod,
    });
  }

  let parsed;
  try {
    parsed = normalizeResponse(body);
  } catch (err) {
    return fail(err.message, { status: 402, method: httpMethod });
  }

  const first = parsed.requirements[0];
  const { ok, missing } = validateRequirement(first);

  const warnings = [];
  if (parsed.requirements.length > 1) {
    warnings.push(
      `${parsed.requirements.length} payment options offered; validated the first`
    );
  }
  if (body.error) {
    warnings.push(`server included an error field: ${body.error}`);
  }
  if (parsed.version === null) {
    warnings.push(
      "could not determine the x402 version from the response; treated generically"
    );
  }

  return {
    url,
    ok,
    status: 402,
    method: httpMethod,
    latencyMs,
    version: parsed.version,
    error: ok ? undefined : `first payment requirement is missing: ${missing.join(", ")}`,
    requirements: first,
    options: parsed.requirements.length,
    warnings,
  };
}

export function formatReport(r) {
  const lines = [
    `x402 handshake check: ${r.url}`,
    `status: ${r.ok ? "OK" : "FAIL"} (${r.latencyMs}ms, ${r.method || "GET"})`,
  ];
  if (r.version) lines.push(`x402 version: v${r.version}`);
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.requirements) {
    const q = r.requirements;
    lines.push(`scheme: ${q.scheme} | network: ${q.network}`);
    lines.push(`payTo: ${q.payTo}`);
    lines.push(`price: ${q.amount} (raw units) of ${q.asset}`);
    if (q.description) lines.push(`description: ${q.description}`);
  }
  for (const w of r.warnings || []) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
