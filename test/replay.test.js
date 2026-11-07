import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runReplayCheck,
  probeReplayProtection,
  formatReplayReport,
} from "../src/replay.js";
import { startMockFacilitator } from "../src/mockFacilitator.js";
import { startMockEndpoint, defaultTestRequirement } from "../src/endtoend.js";
import { normalizeRequirement } from "../src/requirements.js";
import { generateTestKey } from "../src/pay.js";

describe("runReplayCheck (mock stack, protected by default)", () => {
  it("walks the flow and reports PROTECTED when the replay is rejected", async () => {
    const report = await runReplayCheck();
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "protected");
    assert.equal(report.steps.length, 5);
    assert.deepEqual(
      report.steps.map((s) => s.name),
      ["handshake", "sign", "first paid request", "settle", "replay"]
    );
    for (const s of report.steps) assert.equal(s.ok, true, `step failed: ${s.name} — ${s.detail}`);
    assert.equal(report.replayStatus, 402);
    assert.match(report.nonce, /^0x[0-9a-f]{64}$/);
    assert.match(formatReplayReport(report), /verdict: PROTECTED/);
    assert.match(formatReplayReport(report), /result: PASS \(5\/5 steps\)/);
  });

  it("uses the supplied key for signing", async () => {
    const key = generateTestKey();
    const report = await runReplayCheck({ privateKey: key });
    assert.equal(report.ok, true);
    assert.match(report.steps[1].detail, /payment signed by 0x[0-9a-fA-F]{40}/);
  });
});

describe("runReplayCheck (facilitator without replay protection)", () => {
  it("reports REPLAYABLE when the same payment buys the resource twice", async () => {
    const report = await runReplayCheck({
      facilitatorOptions: { replayProtection: false },
    });
    assert.equal(report.ok, false);
    assert.equal(report.verdict, "replayable");
    assert.equal(report.replayStatus, 200);
    const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
    assert.equal(byName["first paid request"].ok, true);
    assert.equal(byName["settle"].ok, true);
    assert.equal(byName["replay"].ok, false);
    assert.match(byName["replay"].detail, /served the resource again/);
    assert.match(formatReplayReport(report), /verdict: REPLAYABLE/);
    assert.match(formatReplayReport(report), /result: FAIL \(4\/5 steps\)/);
  });
});

describe("probeReplayProtection (unhappy path)", () => {
  it("reports INCONCLUSIVE when the facilitator rejects the payment", async () => {
    const fac = await startMockFacilitator({ alwaysReject: true });
    const ep = await startMockEndpoint({ facilitatorUrl: fac.url });
    try {
      const raw = defaultTestRequirement();
      const report = await probeReplayProtection({
        endpointUrl: ep.url,
        facilitatorUrl: fac.url,
        requirement: normalizeRequirement(raw, 2),
        privateKey: generateTestKey(),
      });
      assert.equal(report.ok, false);
      assert.equal(report.verdict, "inconclusive");
      assert.equal(report.replayStatus, null);
      const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
      assert.equal(byName["handshake"].ok, true);
      assert.equal(byName["sign"].ok, true);
      assert.equal(byName["first paid request"].ok, false);
      assert.equal(byName["settle"].ok, false);
      assert.match(byName["settle"].detail, /skipped/);
      assert.equal(byName["replay"].ok, false);
      assert.match(byName["replay"].detail, /never settled/);
      assert.match(formatReplayReport(report), /verdict: INCONCLUSIVE/);
    } finally {
      await ep.close();
      await fac.close();
    }
  });

  it("reports INCONCLUSIVE when the replay attempt itself errors", async () => {
    // A facilitator that settles fine but an endpoint that 500s on
    // the replay: the probe cannot confirm protection either way.
    // Simulate it with a hand-rolled endpoint that 500s the second
    // paid request.
    const fac = await startMockFacilitator();
    const { createServer } = await import("node:http");
    let paidCount = 0;
    const server = createServer(async (req, res) => {
      const send = (status, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      };
      if (!req.headers["x-payment"]) return send(402, { x402Version: 2, accepts: [defaultTestRequirement()] });
      paidCount += 1;
      if (paidCount > 1) return send(500, { error: "boom" });
      return send(200, { resource: "paid resource" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpointUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const raw = defaultTestRequirement();
      const report = await probeReplayProtection({
        endpointUrl,
        facilitatorUrl: fac.url,
        requirement: normalizeRequirement(raw, 2),
        privateKey: generateTestKey(),
      });
      assert.equal(report.ok, false);
      assert.equal(report.verdict, "inconclusive");
      assert.equal(report.replayStatus, 500);
      const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
      assert.equal(byName["first paid request"].ok, true);
      assert.equal(byName["settle"].ok, true);
      assert.equal(byName["replay"].ok, false);
      assert.match(byName["replay"].detail, /HTTP 500/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await fac.close();
    }
  });
});
