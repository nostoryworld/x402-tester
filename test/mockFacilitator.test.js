import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startMockFacilitator, verifyPaymentPayload } from "../src/mockFacilitator.js";
import { signPayment } from "../src/pay.js";
import { normalizeRequirement } from "../src/requirements.js";

const TEST_KEY =
  "0xe0f001b9b27342c3fdf1cd39d9e5b173368437956af8dc71dfba8b3e7451f575"; // generated test fixture, no funds
const TEST_ADDR = "0x31456b2f8A639D72138ad44B27DA0B30E528574c";
const NOW = 1_790_000_000; // fixed clock for deterministic windows

const BASE_RAW = {
  scheme: "exact",
  network: "eip155:8453",
  payTo: "0x8e37022edcf0f21cf3c9f93fee9d4d32519f36f4",
  asset: "0x833589fCD6edB6e08F4C7C32D4F71B54BdA923b6",
  amount: "3000",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const BASE_REQ = normalizeRequirement(BASE_RAW, 2);

async function signedPayload(req = BASE_REQ, nowSec = NOW) {
  return (await signPayment(req, TEST_KEY, { nowSec })).payload;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Test payloads are signed against the fixed NOW clock, which lags the real
// clock — pin the mock server to the same clock unless a test says otherwise.
const mockFac = (opts = {}) => startMockFacilitator({ nowSec: NOW, ...opts });

describe("startMockFacilitator", () => {
  it("binds on 127.0.0.1, answers /healthz, and closes cleanly", async () => {
    const fac = await mockFac();
    assert.match(fac.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${fac.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, mock: true });
    await fac.close();
  });

  it("rejects unknown routes with 404", async () => {
    const fac = await mockFac();
    try {
      const res = await fetch(`${fac.url}/nope`, { method: "POST", body: "{}" });
      assert.equal(res.status, 404);
    } finally {
      await fac.close();
    }
  });
});

describe("POST /verify", () => {
  it("accepts a properly signed payment", async () => {
    const fac = await mockFac();
    try {
      const { status, body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: await signedPayload(),
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(status, 200);
      assert.equal(body.isValid, true);
      assert.ok(!("invalidReason" in body));
    } finally {
      await fac.close();
    }
  });

  it("rejects when the amount differs from the requirement", async () => {
    const fac = await mockFac();
    try {
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: await signedPayload(),
        paymentRequirements: [{ ...BASE_RAW, amount: "9999" }],
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /does not match required amount/);
    } finally {
      await fac.close();
    }
  });

  it("rejects when the payee differs from the requirement", async () => {
    const fac = await mockFac();
    try {
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: await signedPayload(),
        paymentRequirements: [{ ...BASE_RAW, payTo: "0x000000000000000000000000000000000000dEaD" }],
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /does not match required payTo/);
    } finally {
      await fac.close();
    }
  });

  it("rejects an expired authorization (pinned server clock)", async () => {
    const fac = await startMockFacilitator({ nowSec: NOW + 10_000 });
    try {
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: await signedPayload(BASE_REQ, NOW),
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /expired/);
    } finally {
      await fac.close();
    }
  });

  it("rejects a not-yet-valid authorization (pinned server clock)", async () => {
    const fac = await startMockFacilitator({ nowSec: NOW - 10_000 });
    try {
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: await signedPayload(BASE_REQ, NOW),
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /not yet valid/);
    } finally {
      await fac.close();
    }
  });

  it("rejects when the signature recovers to a different address", async () => {
    const fac = await mockFac();
    try {
      const payload = await signedPayload();
      // tamper the claimed payer: the signature was made by TEST_ADDR
      payload.payload.authorization.from = "0x1111111111111111111111111111111111111111";
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /not the claimed payer/);
    } finally {
      await fac.close();
    }
  });

  it("rejects a payment signed for a different asset (domain mismatch)", async () => {
    const fac = await mockFac();
    try {
      const otherAsset = { ...BASE_RAW, asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
      const payload = await signedPayload(normalizeRequirement(otherAsset, 2));
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: [BASE_RAW], // offered asset differs → domain differs
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /not the claimed payer|signature is not a valid/);
    } finally {
      await fac.close();
    }
  });

  it("rejects malformed payloads and empty bodies", async () => {
    const fac = await mockFac();
    try {
      const empty = await postJson(`${fac.url}/verify`, {});
      assert.equal(empty.body.isValid, false);
      const garbage = await postJson(`${fac.url}/verify`, {
        paymentPayload: { nope: true },
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(garbage.body.isValid, false);
      assert.match(garbage.body.invalidReason, /missing signature/);
    } finally {
      await fac.close();
    }
  });

  it("rejects everything when alwaysReject is set", async () => {
    const fac = await startMockFacilitator({ alwaysReject: true });
    try {
      const { body } = await postJson(`${fac.url}/verify`, {
        x402Version: 2,
        paymentPayload: await signedPayload(),
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(body.isValid, false);
      assert.match(body.invalidReason, /configured to reject/);
    } finally {
      await fac.close();
    }
  });
});

describe("POST /settle", () => {
  it("returns a mock settlement receipt for a valid payment", async () => {
    const fac = await mockFac();
    try {
      const { status, body } = await postJson(`${fac.url}/settle`, {
        x402Version: 2,
        paymentPayload: await signedPayload(),
        paymentRequirements: [BASE_RAW],
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.match(body.transaction, /^0x[0-9a-f]{64}$/);
      assert.equal(body.network, "eip155:8453");
      assert.equal(body.payer.toLowerCase(), TEST_ADDR.toLowerCase());
      assert.equal(body.mock, true);
    } finally {
      await fac.close();
    }
  });

  it("refuses to settle an invalid payment", async () => {
    const fac = await mockFac();
    try {
      const { body } = await postJson(`${fac.url}/settle`, {
        x402Version: 2,
        paymentPayload: await signedPayload(),
        paymentRequirements: [{ ...BASE_RAW, amount: "1" }],
      });
      assert.equal(body.success, false);
      assert.match(body.errorReason, /does not match required amount/);
    } finally {
      await fac.close();
    }
  });
});

describe("verifyPaymentPayload (pure)", () => {
  it("accepts a valid signed payload without a server", async () => {
    const verdict = await verifyPaymentPayload(await signedPayload(), [BASE_RAW], { nowSec: NOW });
    assert.deepEqual(verdict, { isValid: true });
  });

  it("rejects non-EVM requirements", async () => {
    const sol = { ...BASE_RAW, network: "solana:mainnet" };
    const verdict = await verifyPaymentPayload(await signedPayload(), [sol], { nowSec: NOW });
    assert.equal(verdict.isValid, false);
    assert.match(verdict.invalidReason, /only verifies EVM/);
  });
});
