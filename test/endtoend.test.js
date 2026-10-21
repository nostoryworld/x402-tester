import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runPaidEndToEnd,
  probePaidFlow,
  startMockEndpoint,
  defaultTestRequirement,
  formatEndToEndReport,
} from "../src/endtoend.js";
import { startMockFacilitator } from "../src/mockFacilitator.js";
import { normalizeRequirement } from "../src/requirements.js";
import { generateTestKey } from "../src/pay.js";

describe("defaultTestRequirement", () => {
  it("is a v2 exact EVM requirement the mock stack can sign and verify", () => {
    const raw = defaultTestRequirement();
    assert.equal(raw.scheme, "exact");
    assert.equal(raw.network, "eip155:8453");
    assert.match(raw.payTo, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(BigInt(raw.amount) > 0n);
    assert.ok(raw.extra && typeof raw.extra === "object");
  });
});

describe("startMockEndpoint", () => {
  it("402s unpaid requests with the requirement in accepts", async () => {
    const fac = await startMockFacilitator();
    const ep = await startMockEndpoint({ facilitatorUrl: fac.url });
    try {
      const res = await fetch(ep.url);
      assert.equal(res.status, 402);
      const body = await res.json();
      assert.equal(body.x402Version, 2);
      assert.ok(Array.isArray(body.accepts) && body.accepts.length === 1);
      assert.equal(body.accepts[0].network, "eip155:8453");
    } finally {
      await ep.close();
      await fac.close();
    }
  });

  it("402s garbage X-PAYMENT headers", async () => {
    const fac = await startMockFacilitator();
    const ep = await startMockEndpoint({ facilitatorUrl: fac.url });
    try {
      const res = await fetch(ep.url, { headers: { "X-PAYMENT": "not-base64!!!" } });
      assert.equal(res.status, 402);
    } finally {
      await ep.close();
      await fac.close();
    }
  });
});

describe("runPaidEndToEnd", () => {
  it("walks the full paid flow against the mocks and serves the resource", async () => {
    const report = await runPaidEndToEnd();
    assert.equal(report.ok, true);
    assert.equal(report.steps.length, 4);
    assert.deepEqual(
      report.steps.map((s) => s.name),
      ["handshake", "sign", "verify", "paid request"]
    );
    for (const s of report.steps) assert.equal(s.ok, true, `step failed: ${s.name} — ${s.detail}`);
    assert.ok(typeof report.resource === "string" && report.resource.length > 0);
    assert.match(formatEndToEndReport(report), /result: PASS \(4\/4 steps\)/);
  });

  it("uses the supplied key for signing", async () => {
    const key = generateTestKey();
    const report = await runPaidEndToEnd({ privateKey: key });
    assert.equal(report.ok, true);
    assert.match(report.steps[1].detail, /payment signed by 0x[0-9a-fA-F]{40}/);
  });
});

describe("probePaidFlow (unhappy path)", () => {
  it("reports FAIL when the facilitator rejects the payment", async () => {
    const fac = await startMockFacilitator({ alwaysReject: true });
    const ep = await startMockEndpoint({ facilitatorUrl: fac.url });
    try {
      const raw = defaultTestRequirement();
      const report = await probePaidFlow({
        endpointUrl: ep.url,
        facilitatorUrl: fac.url,
        requirement: normalizeRequirement(raw, 2),
        privateKey: generateTestKey(),
      });
      assert.equal(report.ok, false);
      const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
      assert.equal(byName["handshake"].ok, true);
      assert.equal(byName["sign"].ok, true);
      assert.equal(byName["verify"].ok, false);
      assert.match(byName["verify"].detail, /rejected/);
      assert.equal(byName["paid request"].ok, false);
      assert.match(formatEndToEndReport(report), /result: FAIL/);
    } finally {
      await ep.close();
      await fac.close();
    }
  });
});
