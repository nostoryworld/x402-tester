/**
 * Normalizes x402 payment requirements across protocol versions.
 *
 * x402 v1 describes payment options in a `paymentRequirements` array whose
 * entries use `maxAmountRequired`; x402 v2 uses an `accepts` array whose
 * entries use `amount`. Both versions get mapped to one uniform shape so
 * every downstream check, formatter, and report only deals with one schema.
 *
 * Normalized shape:
 *   { scheme, network, payTo, asset, amount, maxTimeoutSeconds,
 *     resource, description, mimeType, extra, version }
 */

const REQUIRED_FIELDS = ["scheme", "network", "payTo", "asset", "amount"];

/**
 * Detect the x402 version of a 402 response body.
 * Returns 1, 2, or null when the version cannot be determined.
 */
export function detectVersion(body) {
  if (!body || typeof body !== "object") return null;
  if (body.x402Version === 1) return 1;
  if (body.x402Version === 2) return 2;
  if (Array.isArray(body.accepts)) return 2;
  if (Array.isArray(body.paymentRequirements)) return 1;
  return null;
}

/**
 * Map one raw payment requirement entry (either version) to the
 * uniform normalized shape. Version is captured on the entry itself.
 */
export function normalizeRequirement(entry, version) {
  const e = entry && typeof entry === "object" ? entry : {};
  return {
    scheme: e.scheme,
    network: e.network,
    payTo: e.payTo,
    asset: e.asset,
    // v1 calls the price `maxAmountRequired`, v2 calls it `amount`
    amount: e.amount ?? e.maxAmountRequired,
    maxTimeoutSeconds: e.maxTimeoutSeconds,
    resource: e.resource,
    description: e.description,
    mimeType: e.mimeType,
    // v2 allows an opaque `extra` field; keep anything unrecognized too
    extra: e.extra ?? null,
    version,
  };
}

/**
 * Validate the normalized shape. Returns { ok, missing[] }.
 */
export function validateRequirement(req) {
  const missing = REQUIRED_FIELDS.filter(
    (k) => req[k] === undefined || req[k] === null || req[k] === ""
  );
  return { ok: missing.length === 0, missing };
}

/**
 * Extract + normalize the payment options from a parsed 402 body.
 * Returns { version, requirements } or throws an Error describing
 * why the body has no usable payment requirements.
 */
export function normalizeResponse(body) {
  const version = detectVersion(body);
  // Prefer the version-specific key; fall back to whichever exists.
  const raw =
    version === 1
      ? body.paymentRequirements ?? body.accepts
      : body.accepts ?? body.paymentRequirements;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      "402 response contains no payment requirements (expected a non-empty `accepts` (v2) or `paymentRequirements` (v1) array)"
    );
  }
  return {
    version,
    requirements: raw.map((entry) => normalizeRequirement(entry, version)),
  };
}
