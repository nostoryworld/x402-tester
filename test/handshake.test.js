import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkHandshake } from "../src/handshake.js";

const VALID_402 = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "base",
      payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda4a1300",
      amount: "20000",
      maxTimeoutSeconds: 60,
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

test("accepts a well-formed 402 handshake", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(VALID_402));
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, true);
    assert.equal(r.status, 402);
    assert.equal(r.requirements.network, "base");
    assert.equal(r.requirements.amount, "20000");
    assert.equal(r.requirements.scheme, "exact");
  } finally {
    srv.close();
  }
});

test("rejects a 200 response (not a paid endpoint)", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, false);
    assert.match(r.error, /expected HTTP 402/);
  } finally {
    srv.close();
  }
});

test("rejects 402 with an empty accepts array", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 2, accepts: [] }));
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, false);
    assert.match(r.error, /no payment requirements/);
  } finally {
    srv.close();
  }
});

test("rejects 402 with a non-JSON body", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402);
    res.end("not json");
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, false);
    assert.match(r.error, /not valid JSON/);
  } finally {
    srv.close();
  }
});

test("flags missing required fields in the payment requirement", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepts: [{ scheme: "exact" }] }));
  });
  try {
    const r = await checkHandshake(addr(srv));
    assert.equal(r.ok, false);
    assert.match(r.error, /missing/);
  } finally {
    srv.close();
  }
});
