import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  checkFacilitator,
  facilitatorVerifyUrl,
  formatFacilitatorReport,
} from "../src/facilitator.js";

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("a 4xx on /verify counts as reachable (probe payload rejected)", async () => {
  let seen = null;
  const srv = await startServer((req, res) => {
    seen = { method: req.method, url: req.url };
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid payment payload" }));
  });
  try {
    const r = await checkFacilitator(addr(srv));
    assert.equal(r.reachable, true);
    assert.equal(r.status, 400);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/verify");
    assert.match(r.diagnosis, /rejected the empty probe payload/);
  } finally {
    srv.close();
  }
});

test("a 5xx on /verify counts as reachable but unhealthy", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(502);
    res.end("bad gateway");
  });
  try {
    const r = await checkFacilitator(addr(srv));
    assert.equal(r.reachable, true);
    assert.equal(r.status, 502);
    assert.match(r.diagnosis, /up but unhealthy/);
  } finally {
    srv.close();
  }
});

test("an unexpected 2xx is flagged in the diagnosis", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ valid: false }));
  });
  try {
    const r = await checkFacilitator(addr(srv));
    assert.equal(r.reachable, true);
    assert.match(r.diagnosis, /unexpected/);
  } finally {
    srv.close();
  }
});

test("connection refused counts as unreachable", async () => {
  // port 1 on loopback is effectively always closed
  const r = await checkFacilitator("http://127.0.0.1:1");
  assert.equal(r.reachable, false);
  assert.match(r.error, /unreachable/);
});

test("a silent facilitator times out", async () => {
  const srv = await startServer(() => {
    // never respond — simulate a hung facilitator
  });
  try {
    const r = await checkFacilitator(addr(srv), { timeoutMs: 150 });
    assert.equal(r.reachable, false);
    assert.match(r.error, /timed out/);
  } finally {
    srv.close();
  }
});

test("verify URL resolves without doubling slashes", () => {
  assert.equal(
    facilitatorVerifyUrl("https://facilitator.example.com/"),
    "https://facilitator.example.com/verify"
  );
  assert.equal(
    facilitatorVerifyUrl("https://facilitator.example.com///"),
    "https://facilitator.example.com/verify"
  );
});

test("an empty base URL is unreachable with a clear error", async () => {
  const r = await checkFacilitator("");
  assert.equal(r.reachable, false);
  assert.match(r.error, /base URL is required/);
});

test("report renders reachable and unreachable results", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(422);
    res.end("{}");
  });
  try {
    const ok = await checkFacilitator(addr(srv));
    const down = await checkFacilitator("http://127.0.0.1:1");
    assert.match(formatFacilitatorReport(ok), /status: REACHABLE/);
    assert.match(formatFacilitatorReport(down), /status: UNREACHABLE/);
    assert.match(formatFacilitatorReport(down), /error: facilitator unreachable/);
  } finally {
    srv.close();
  }
});
