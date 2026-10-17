/**
 * Human-readable price formatting for x402 payment requirements.
 *
 * 402 responses quote prices in raw token units ("20000"), which is
 * unreadable without the asset's decimals. This module keeps a small
 * registry of well-known x402 payment assets (network -> address ->
 * { symbol, decimals }) and converts raw amounts to real token amounts
 * with exact BigInt arithmetic — no floating-point rounding.
 *
 * The registry is intentionally small and extendable: unknown assets
 * fall back to showing the raw amount untouched, never a guess.
 */

const USDC_6 = { symbol: "USDC", decimals: 6 };

// EVM addresses are matched case-insensitively; Solana mints (base58)
// are matched exactly.
export const KNOWN_ASSETS = {
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": USDC_6,
  },
  "base-sepolia": {
    "0x036cbD53842c5426634e7929541ec2318f3dcf7e": USDC_6,
  },
  ethereum: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": USDC_6,
  },
  "ethereum-sepolia": {
    "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": USDC_6,
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": USDC_6,
  },
  solana: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: USDC_6,
  },
};

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

/**
 * Look up a payment asset by network + address/mint.
 * Returns { symbol, decimals } or null when unknown.
 */
export function resolveAsset(network, asset) {
  if (typeof network !== "string" || typeof asset !== "string") return null;
  const byNetwork = KNOWN_ASSETS[network.toLowerCase()];
  if (!byNetwork) return null;
  if (EVM_ADDRESS.test(asset)) {
    return byNetwork[asset.toLowerCase()] ?? null;
  }
  return byNetwork[asset] ?? null;
}

/**
 * Convert a raw integer amount into a decimal string using the
 * asset's decimals, with exact integer arithmetic.
 *   formatAmount("20000", 6)          -> "0.02"
 *   formatAmount("1500000", 6)        -> "1.5"
 *   formatAmount("1", 18)             -> "0.000000000000000001"
 *   formatAmount("100000000", 8)      -> "1"
 * Throws on non-integer or negative input — callers fall back to
 * showing the raw amount in that case.
 */
export function formatAmount(raw, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  const value = typeof raw === "bigint" ? raw : BigInt(String(raw).trim());
  if (value < 0n) throw new RangeError(`amount must be non-negative, got ${raw}`);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Render a normalized payment requirement's price in human form:
 *   "0.02 USDC"
 * Falls back to the raw-unit rendering when the asset is unknown or
 * the amount is not a clean integer — never invents a price.
 */
export function formatPrice(req) {
  const amount = req?.amount;
  const asset = req?.asset ?? "unknown asset";
  if (amount === undefined || amount === null || amount === "") {
    return `no amount specified (of ${asset})`;
  }
  const meta = resolveAsset(req?.network, req?.asset);
  if (!meta) return `${amount} (raw units) of ${asset}`;
  let human = null;
  try {
    human = formatAmount(amount, meta.decimals);
  } catch {
    human = null;
  }
  if (human === null) return `${amount} (raw units) of ${meta.symbol}`;
  return `${human} ${meta.symbol}`;
}
