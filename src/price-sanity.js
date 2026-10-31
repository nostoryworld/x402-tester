/**
 * Price sanity checks for x402 payment requirements.
 *
 * A 402 response quotes a price in raw token units, and a single
 * misplaced decimal turns a $0.02 API call into a $20,000 one — or a
 * $0.0000001 one that no facilitator will settle. This module flags
 * both failure modes with pure heuristics on the token amount:
 *
 *   DUST  — more than zero, but under 0.001 token units. Below a tenth
 *           of a cent for a stablecoin; almost certainly a decimals
 *           bug, not a real price.
 *   WHALE — over 1,000,000 token units for one call. Nobody prices a
 *           single API call at a million tokens; almost certainly a
 *           decimals bug in the other direction.
 *
 * These are heuristics on token amount, not USD value: without a price
 * oracle there is no way to know what a volatile token is worth, so
 * the bands are deliberately wide and only catch egregious outliers.
 * Unknown assets cannot be converted from raw units, so they report
 * UNKNOWN and are never flagged — a guess is worse than silence.
 * All comparisons use BigInt, never floats.
 */

import { resolveAsset, formatPrice } from "./price.js";

// 0.001 token units, expressed as raw < scale / 1000 (BigInt-safe for
// any decimals, including 0).
const DUST_DENOMINATOR = 1000n;
// 1,000,000 token units.
const WHALE_UNITS = 1000000n;

function parseRaw(amount) {
  try {
    const value = typeof amount === "bigint" ? amount : BigInt(String(amount).trim());
    return value < 0n ? null : value;
  } catch {
    return null;
  }
}

/**
 * Classify one normalized payment requirement's price.
 * Returns { status, reason } where status is OK, DUST, WHALE, or
 * UNKNOWN.
 */
export function classifyPrice(req) {
  const meta = resolveAsset(req?.network, req?.asset);
  if (!meta) {
    return {
      status: "UNKNOWN",
      reason: "unknown asset, cannot convert raw units to a token amount",
    };
  }
  const raw = parseRaw(req?.amount);
  if (raw === null) {
    return { status: "UNKNOWN", reason: "amount is not a non-negative integer" };
  }
  if (raw === 0n) {
    return { status: "OK", reason: "zero price (free)" };
  }
  const scale = 10n ** BigInt(meta.decimals);
  if (raw * DUST_DENOMINATOR < scale) {
    return {
      status: "DUST",
      reason: `under 0.001 ${meta.symbol} — dust-level price, likely a decimals bug`,
    };
  }
  if (raw > WHALE_UNITS * scale) {
    return {
      status: "WHALE",
      reason: `over 1,000,000 ${meta.symbol} for one call — whale-level price, likely a decimals bug`,
    };
  }
  return { status: "OK", reason: "within sane bounds" };
}

/**
 * Check every payment option in a normalized requirements array.
 * Accepts a single requirement or an array. Returns
 *   { checks: [{ index, price, status, reason }], flagged }
 * where `flagged` is true when any option is DUST or WHALE.
 */
export function checkPriceSanity(requirements) {
  const list = Array.isArray(requirements) ? requirements : [requirements];
  const checks = list.map((req, index) => {
    const { status, reason } = classifyPrice(req);
    return { index, price: formatPrice(req), status, reason };
  });
  return {
    checks,
    flagged: checks.some((c) => c.status === "DUST" || c.status === "WHALE"),
  };
}

/**
 * One human-readable line per flagged option, for report output.
 */
export function formatPriceSanityLines(sanity) {
  return (sanity?.checks ?? [])
    .filter((c) => c.status === "DUST" || c.status === "WHALE")
    .map((c) => `price sanity: option ${c.index + 1} (${c.price}) — ${c.reason}`);
}
