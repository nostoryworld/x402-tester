import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  classifyPrice,
  checkPriceSanity,
  formatPriceSanityLines,
} from "../src/price-sanity.js";
import { checkHandshake } from "../src/handshake.js";

// Base USDC: 6 decimals, so raw 20000 = 0.02 USDC.
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const req = (amount, asset = USDC, network = "base") => ({
  scheme: "exact",
  network,
  payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
  asset,
  amount,
});

test("a normal price is OK", () => {
  assert.equal(classifyPrice(req("20000")).status, "OK");
});

test("under 0.001 token units is DUST", () => {
  assert.equal(classifyPrice(req("500")).status, "DUST");
  assert.equal(classifyPrice(req("999")).status, "DUST");
});

test("exactly 0.001 token units is the OK boundary", () => {
  assert.equal(classifyPrice(req("1000")).status, "OK");
});

test("over 1,000,000 token units is WHALE", () => {
  assert.equal(classifyPrice(req("1000001000000")).status, "WHALE");
});

test("exactly 1,000,000 token units is the OK boundary", () => {
  assert.equal(classifyPrice(req("1000000000000")).status, "OK");
});

test("a zero price is OK (free), not dust", () => {
  const c = classifyPrice(req("0"));
  assert.equal(c.status, "OK");
  assert.match(c.reason, /free/);
});

test("an unknown asset is UNKNOWN, never flagged", () => {
  const c = classifyPrice(req("1", "0x0000000000000000000000000000000000000000"));
  assert.equal(c.status, "UNKNOWN");
  assert.equal(checkPriceSanity(req("1", "0x0000000000000000000000000000000000000000")).flagged, false);
});

test("a non-integer or negative amount is UNKNOWN", () => {
  assert.equal(classifyPrice(req("abc")).status, "UNKNOWN");
  assert.equal(classifyPrice(req("-5")).status, "UNKNOWN");
});

test("checkPriceSanity flags when any option is dust or whale", () => {
  const s = checkPriceSanity([req("20000"), req("500")]);
  assert.equal(s.flagged, true);
  assert.deepEqual(
    s.checks.map((c) => c.status),
    ["OK", "DUST"]
  );
  assert.equal(s.checks[1].price, "0.0005 USDC");
});

test("formatPriceSanityLines only renders flagged options", () => {
  const lines = formatPriceSanityLines(
    checkPriceSanity([req("20000"), req("1000001000000")])
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /option 2/);
  assert.match(lines[0], /WHALE|whale/);
});

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

test("checkHandshake attaches priceSanity and warns, without failing the check", async () => {
  const body = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
        asset: USDC,
        amount: "500",
        maxTimeoutSeconds: 60,
      },
    ],
  };
  const srv = await startServer((req_, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  try {
    const r = await checkHandshake(`http://127.0.0.1:${srv.address().port}`);
    assert.equal(r.ok, true);
    assert.equal(r.priceSanity.flagged, true);
    assert.equal(r.priceSanity.checks[0].status, "DUST");
    assert.ok(r.warnings.some((w) => w.includes("price sanity")));
  } finally {
    srv.close();
  }
});
