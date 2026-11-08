import test from "node:test";
import assert from "node:assert/strict";
import { formatAmount, resolveAsset, formatPrice, KNOWN_ASSETS } from "../src/price.js";

test("registry: every EVM asset key is a well-formed 40-hex address", () => {
  const evmNetworks = ["base", "base-sepolia", "ethereum", "ethereum-sepolia", "polygon"];
  for (const net of evmNetworks) {
    for (const addr of Object.keys(KNOWN_ASSETS[net])) {
      assert.match(addr, /^0x[0-9a-f]{40}$/i, `${net} key ${addr} must be a valid address`);
    }
  }
});

test("formatAmount: sub-unit amount becomes a decimal string", () => {
  assert.equal(formatAmount("20000", 6), "0.02");
});

test("formatAmount: trims trailing zeros but keeps significance", () => {
  assert.equal(formatAmount("1500000", 6), "1.5");
  assert.equal(formatAmount("100000000", 8), "1");
});

test("formatAmount: smallest unit of an 18-decimal token", () => {
  assert.equal(formatAmount("1", 18), "0.000000000000000001");
});

test("formatAmount: zero and whole amounts stay clean", () => {
  assert.equal(formatAmount("0", 6), "0");
  assert.equal(formatAmount("1000000", 6), "1");
});

test("formatAmount: accepts numbers and bigints too", () => {
  assert.equal(formatAmount(20000, 6), "0.02");
  assert.equal(formatAmount(20000n, 6), "0.02");
});

test("formatAmount: exact for values that break float math", () => {
  // 0.1 + 0.2 !== 0.3 in IEEE754; BigInt arithmetic is exact.
  assert.equal(formatAmount("300000000000000000", 18), "0.3");
});

test("formatAmount: rejects negative and non-integer input", () => {
  assert.throws(() => formatAmount("-1", 6), RangeError);
  assert.throws(() => formatAmount("1.5", 6));
  assert.throws(() => formatAmount("abc", 6));
  assert.throws(() => formatAmount("10", -1), RangeError);
});

test("resolveAsset: known USDC on base, case-insensitive", () => {
  const meta = resolveAsset("base", "0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.deepEqual(meta, { symbol: "USDC", decimals: 6 });
});

test("resolveAsset: known USDC on solana (base58 mint)", () => {
  const meta = resolveAsset("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.deepEqual(meta, { symbol: "USDC", decimals: 6 });
});

test("resolveAsset: unknown network or asset returns null", () => {
  assert.equal(resolveAsset("nope", "0x833589fcd6edb6e08f4c7c32d4f71b54bda4a1300"), null);
  assert.equal(resolveAsset("base", "0x0000000000000000000000000000000000000000"), null);
  assert.equal(resolveAsset(null, "0x1234"), null);
});

test("formatPrice: known asset renders human amount", () => {
  assert.equal(
    formatPrice({
      scheme: "exact",
      network: "base",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amount: "20000",
    }),
    "0.02 USDC"
  );
});

test("formatPrice: unknown asset falls back to raw units", () => {
  const out = formatPrice({ network: "base", asset: "0xdeadbeef", amount: "123" });
  assert.equal(out, "123 (raw units) of 0xdeadbeef");
});

test("formatPrice: missing amount is reported, not invented", () => {
  const out = formatPrice({ network: "base", asset: "0xdeadbeef" });
  assert.ok(out.startsWith("no amount specified"));
});

test("resolveAsset: CAIP-2 eip155 networks map onto the short names", () => {
  const usdcBase = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  assert.deepEqual(resolveAsset("eip155:8453", usdcBase), { symbol: "USDC", decimals: 6 });
  assert.deepEqual(
    resolveAsset("eip155:1", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    { symbol: "USDC", decimals: 6 }
  );
  // An unlisted chain id resolves to nothing, never a guessed network.
  assert.equal(resolveAsset("eip155:999999", usdcBase), null);
  assert.equal(resolveAsset("eip155:abc", usdcBase), null);
});

test("resolveAsset: solana:mainnet maps to solana; devnet does not (different mint)", () => {
  const usdcSol = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  assert.deepEqual(resolveAsset("solana:mainnet", usdcSol), { symbol: "USDC", decimals: 6 });
  assert.equal(resolveAsset("solana:devnet", usdcSol), null);
});

test("formatPrice: a real v2 fixture requirement prices in token units, not raw", () => {
  assert.equal(
    formatPrice({
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
    }),
    "0.001 USDC"
  );
});
