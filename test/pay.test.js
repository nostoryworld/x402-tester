import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chainIdFromNetwork,
  eip712Domain,
  buildAuthorization,
  signPayment,
  recoverPayer,
  decodePaymentHeader,
  generateTestKey,
  pickSignableRequirement,
} from "../src/pay.js";

const TEST_KEY =
  "0xe0f001b9b27342c3fdf1cd39d9e5b173368437956af8dc71dfba8b3e7451f575"; // generated test fixture, no funds
const TEST_ADDR = "0x31456b2f8A639D72138ad44B27DA0B30E528574c";
const NOW = 1_790_000_000; // fixed clock for deterministic windows

const BASE_REQ = {
  scheme: "exact",
  network: "eip155:8453",
  payTo: "0x8e37022edcf0f21cf3c9f93fee9d4d32519f36f4",
  asset: "0x833589fCD6edB6e08F4C7C32D4F71B54BdA923b6", // USDC on Base
  amount: "3000",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
  version: 2,
};

describe("chainIdFromNetwork", () => {
  it("parses eip155 CAIP-2 identifiers", () => {
    assert.equal(chainIdFromNetwork("eip155:8453"), 8453);
    assert.equal(chainIdFromNetwork("eip155:1"), 1);
  });
  it("accepts plain numeric chain ids", () => {
    assert.equal(chainIdFromNetwork("8453"), 8453);
  });
  it("rejects non-EVM networks", () => {
    assert.throws(() => chainIdFromNetwork("solana:mainnet"), /not an EVM network/);
    assert.throws(() => chainIdFromNetwork("solana"), /not an EVM network/);
    assert.throws(() => chainIdFromNetwork(""), /not an EVM network/);
  });
});

describe("eip712Domain", () => {
  it("builds the USDC domain from a standard v2 entry", () => {
    assert.deepEqual(eip712Domain(BASE_REQ), {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6edB6e08F4C7C32D4F71B54BdA923b6",
    });
  });
  it("honours a Gateway-style extra.verifyingContract", () => {
    const gateway = "0x1234567890123456789012345678901234567890";
    const domain = eip712Domain({
      ...BASE_REQ,
      extra: { name: "GatewayWallet", version: "1", verifyingContract: gateway },
    });
    assert.equal(domain.verifyingContract, gateway);
    assert.equal(domain.name, "GatewayWallet");
  });
  it("falls back to defaults when extra is missing", () => {
    const domain = eip712Domain({ ...BASE_REQ, extra: null });
    assert.equal(domain.name, "USD Coin");
    assert.equal(domain.version, "2");
  });
});

describe("buildAuthorization", () => {
  it("uses amount + timeout from the requirement", () => {
    const auth = buildAuthorization(BASE_REQ, TEST_ADDR, { nowSec: NOW });
    assert.equal(auth.from, TEST_ADDR);
    assert.equal(auth.to, BASE_REQ.payTo);
    assert.equal(auth.value, 3000n);
    assert.equal(auth.validAfter, BigInt(NOW - 30));
    assert.equal(auth.validBefore, BigInt(NOW + 60));
    assert.match(auth.nonce, /^0x[0-9a-f]{64}$/);
  });
  it("defaults the validity window to 600s", () => {
    const { maxTimeoutSeconds: _drop, ...noTimeout } = BASE_REQ;
    const auth = buildAuthorization(noTimeout, TEST_ADDR, { nowSec: NOW });
    assert.equal(auth.validBefore, BigInt(NOW + 600));
  });
  it("rejects zero amounts", () => {
    assert.throws(
      () => buildAuthorization({ ...BASE_REQ, amount: "0" }, TEST_ADDR, { nowSec: NOW }),
      /must be positive/
    );
  });
});

describe("signPayment", () => {
  it("signs a v2 payload whose signature recovers to the payer", async () => {
    const signed = await signPayment(BASE_REQ, TEST_KEY, { nowSec: NOW });
    assert.equal(signed.payload.x402Version, 2);
    assert.equal(signed.payload.scheme, "exact");
    assert.equal(signed.payload.network, "eip155:8453");
    assert.match(signed.signature, /^0x[0-9a-f]{130}$/);
    assert.equal(signed.payload.payload.authorization.value, "3000");
    assert.equal(signed.payload.payload.authorization.from, TEST_ADDR);
    const recovered = await recoverPayer(signed);
    assert.equal(recovered.toLowerCase(), TEST_ADDR.toLowerCase());
  });

  it("uses x402Version 1 for v1 requirements", async () => {
    const v1 = { ...BASE_REQ, version: 1, maxTimeoutSeconds: undefined };
    const signed = await signPayment(v1, TEST_KEY, { nowSec: NOW });
    assert.equal(signed.payload.x402Version, 1);
  });

  it("round-trips through the base64 payment header", async () => {
    const signed = await signPayment(BASE_REQ, TEST_KEY, { nowSec: NOW });
    const decoded = decodePaymentHeader(signed.header);
    assert.deepEqual(decoded, signed.payload);
  });

  it("rejects non-exact schemes", async () => {
    await assert.rejects(
      signPayment({ ...BASE_REQ, scheme: "permit2" }, TEST_KEY, { nowSec: NOW }),
      /unsupported scheme/
    );
  });

  it("rejects non-EVM networks", async () => {
    await assert.rejects(
      signPayment({ ...BASE_REQ, network: "solana:mainnet" }, TEST_KEY, { nowSec: NOW }),
      /no signable payment requirement found|not an EVM network/
    );
  });

  it("rejects requirements missing payTo", async () => {
    await assert.rejects(
      signPayment({ ...BASE_REQ, payTo: "" }, TEST_KEY, { nowSec: NOW }),
      /missing "payTo"/
    );
  });
});

describe("generateTestKey", () => {
  it("produces a fresh valid 32-byte key each call", () => {
    const a = generateTestKey();
    const b = generateTestKey();
    assert.match(a, /^0x[0-9a-f]{64}$/);
    assert.match(b, /^0x[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});

describe("pickSignableRequirement", () => {
  const solanaReq = { ...BASE_REQ, network: "solana:devnet", scheme: "exact" };
  const permitReq = { ...BASE_REQ, scheme: "permit2" };
  const alienReq = { ...BASE_REQ, network: "starknet:mainnet", scheme: "exact" };

  it("picks the first signable requirement, EVM or Solana", () => {
    assert.equal(pickSignableRequirement([solanaReq, BASE_REQ]), solanaReq);
    assert.equal(pickSignableRequirement([permitReq, BASE_REQ]), BASE_REQ);
    assert.equal(pickSignableRequirement([alienReq, solanaReq]), solanaReq);
  });
  it("throws when nothing is signable", () => {
    assert.throws(
      () => pickSignableRequirement([alienReq, permitReq]),
      /no signable payment requirement/
    );
    assert.throws(() => pickSignableRequirement([]), /no signable payment requirement/);
  });
});
