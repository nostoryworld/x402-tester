/**
 * Validates the x402 HTTP 402 handshake of a paid endpoint.
 *
 * A healthy x402 endpoint answers unpaid requests with HTTP 402 and a
 * JSON body describing how to pay (the `accepts` array in x402 v2,
 * `paymentRequirements` in v1). This module checks that contract and
 * returns a structured report — no wallet or signing involved.
 */

const REQUIRED_FIELDS = ["scheme", "network", "payTo", "asset", "amount"];

export async function checkHandshake(url, { timeoutMs = 15000 } = {}) {
  const startedAt = Date.now();
  const fail = (error, extra = {}) => ({
    url,
    ok: false,
    error,
    latencyMs: Date.now() - startedAt,
    ...extra,
  });

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(`request failed: ${err.cause?.message || err.message}`);
  }
  const latencyMs = Date.now() - startedAt;

  if (res.status !== 402) {
    return fail(`expected HTTP 402 Payment Required, got ${res.status}`, {
      status: res.status,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return fail("402 response body is not valid JSON", { status: 402 });
  }

  const accepts = body.accepts ?? body.paymentRequirements;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return fail(
      "402 response contains no payment requirements (expected a non-empty `accepts` array)",
      { status: 402 }
    );
  }

  const first = accepts[0];
  const missing = REQUIRED_FIELDS.filter(
    (k) => first[k] === undefined || first[k] === null || first[k] === ""
  );

  const warnings = [];
  if (accepts.length > 1) {
    warnings.push(
      `${accepts.length} payment options offered; validated the first`
    );
  }
  if (body.error) {
    warnings.push(`server included an error field: ${body.error}`);
  }

  return {
    url,
    ok: missing.length === 0,
    status: 402,
    latencyMs,
    error: missing.length
      ? `first payment requirement is missing: ${missing.join(", ")}`
      : undefined,
    requirements: {
      scheme: first.scheme,
      network: first.network,
      payTo: first.payTo,
      asset: first.asset,
      amount: first.amount,
      maxTimeoutSeconds: first.maxTimeoutSeconds,
      extra: first.extra,
    },
    options: accepts.length,
    warnings,
  };
}

export function formatReport(r) {
  const lines = [
    `x402 handshake check: ${r.url}`,
    `status: ${r.ok ? "OK" : "FAIL"} (${r.latencyMs}ms)`,
  ];
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.requirements) {
    const q = r.requirements;
    lines.push(`scheme: ${q.scheme} | network: ${q.network}`);
    lines.push(`payTo: ${q.payTo}`);
    lines.push(`price: ${q.amount} (raw units) of ${q.asset}`);
  }
  for (const w of r.warnings || []) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
