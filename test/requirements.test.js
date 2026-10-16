import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  detectVersion,
  normalizeRequirement,
  normalizeResponse,
  validateRequirement,
} from "../src/requirements.js";
import { checkHandshake } from "../src/handshake.js";

const V2_BODY = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "base",
      payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda4a1300",
      amount: "20000",
      maxTimeoutSeconds: 60,
      description: "v2 endpoint",
    },
  ],
};

const V1_BODY = {
  x402Version: 1,
  paymentRequirements: [
    {
      scheme: "exact",
      network: "base",
      payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda4a1300",
      maxAmountRequired: "50000",
      maxTimeoutSeconds: 60,
      description: "v1 endpoint",
      mimeType: "application/json",
    },
  ],
};

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("detects version 2 from x402Version field", () => {
  assert.equal(detectVersion(V2_BODY), 2);
});

test("detects version 1 from x402Version field", () => {
  assert.equal(detectVersion(V1_BODY), 1);
});

test("infers version from array key when x402Version is missing", () => {
  assert.equal(detectVersion({ accepts: [{}] }), 2);
  assert.equal(detectVersion({ paymentRequirements: [{}] }), 1);
  assert.equal(detectVersion({}), null);
  assert.equal(detectVersion(null), null);
});

test("normalizes a v1 entry (maxAmountRequired -> amount)", () => {
  const n = normalizeRequirement(V1_BODY.paymentRequirements[0], 1);
  assert.equal(n.amount, "50000");
  assert.equal(n.scheme, "exact");
  assert.equal(n.network, "base");
  assert.equal(n.description, "v1 endpoint");
  assert.equal(n.mimeType, "application/json");
  assert.equal(n.version, 1);
});

test("normalizes a v2 entry (amount kept)", () => {
  const n = normalizeRequirement(V2_BODY.accepts[0], 2);
  assert.equal(n.amount, "20000");
  assert.equal(n.version, 2);
  assert.equal(n.extra, null);
});

test("validates required fields on the normalized shape", () => {
  const good = validateRequirement(
    normalizeRequirement(V2_BODY.accepts[0], 2)
  );
  assert.deepEqual(good, { ok: true, missing: [] });
  const bad = validateRequirement(normalizeRequirement({ scheme: "exact" }, 2));
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("amount"));
  assert.ok(bad.missing.includes("network"));
});

test("normalizeResponse keeps v1 and v2 options uniform", () => {
  for (const [body, version, amount] of [
    [V1_BODY, 1, "50000"],
    [V2_BODY, 2, "20000"],
  ]) {
    const p = normalizeResponse(body);
    assert.equal(p.version, version);
    assert.equal(p.requirements.length, 1);
    assert.equal(p.requirements[0].amount, amount);
    assert.equal(p.requirements[0].payTo, body.accepts?.[0]?.payTo ?? body.paymentRequirements[0].payTo);
  }
});

test("normalizeResponse throws when no payment array exists", () => {
  assert.throws(() => normalizeResponse({}), /no payment requirements/);
  assert.throws(() => normalizeResponse({ accepts: [] }), /no payment requirements/);
});

test("checkHandshake normalizes a v1 402 body", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(V1_BODY));
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, true);
    assert.equal(r.version, 1);
    assert.equal(r.requirements.amount, "50000");
    assert.equal(r.requirements.description, "v1 endpoint");
  } finally {
    srv.close();
  }
});

test("checkHandshake reports version 2 for a v2 402 body", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(V2_BODY));
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, true);
    assert.equal(r.version, 2);
    assert.equal(r.requirements.amount, "20000");
  } finally {
    srv.close();
  }
});

test("checkHandshake sends the requested method with a JSON body", async () => {
  let seen = null;
  const srv = await startServer((req, res) => {
    seen = { method: req.method, contentType: req.headers["content-type"] };
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      seen.body = chunks;
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(V2_BODY));
    });
  });
  try {
    const r = await checkHandshake(addr(srv), { method: "POST" });
    assert.equal(r.ok, true);
    assert.equal(r.method, "POST");
    assert.equal(seen.method, "POST");
    assert.equal(seen.contentType, "application/json");
    assert.equal(seen.body, "{}");
  } finally {
    srv.close();
  }
});

test("checkHandshake defaults to GET", async () => {
  let seenMethod = null;
  const srv = await startServer((req, res) => {
    seenMethod = req.method;
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(V2_BODY));
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, true);
    assert.equal(seenMethod, "GET");
  } finally {
    srv.close();
  }
});

test("checkHandshake gives a method hint on empty-body 402", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end();
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, false);
    assert.match(r.error, /empty body/);
    assert.match(r.error, /--method POST/);
  } finally {
    srv.close();
  }
});
