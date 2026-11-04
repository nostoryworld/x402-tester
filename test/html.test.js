import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { toHtml } from "../src/html.js";
import { renderReport } from "../src/output.js";

describe("toHtml", () => {
  it("emits a standalone document headed with the given title", () => {
    const out = toHtml({ ok: true }, "Handshake check");
    assert.ok(out.startsWith("<!DOCTYPE html>"));
    assert.match(out, /<title>Handshake check<\/title>/);
    assert.match(out, /<h1>Handshake check<\/h1>/);
    assert.match(out, /<style>/); // self-contained: inline CSS, no assets
  });

  it("adds a pass/fail status badge from a boolean ok field", () => {
    assert.match(toHtml({ ok: true }), /class="status pass">✅ pass/);
    assert.match(toHtml({ ok: false }), /class="status fail">❌ fail/);
  });

  it("renders scalar fields as a table and skips undefined", () => {
    const out = toHtml({
      url: "http://example.com/paid",
      status: 402,
      price: "0.02 USDC",
      missing: undefined,
    });
    assert.match(out, /<td>url<\/td><td><code>http:\/\/example\.com\/paid<\/code><\/td>/);
    assert.match(out, /<td>status<\/td><td><code>402<\/code><\/td>/);
    assert.match(out, /<td>price<\/td><td><code>0\.02 USDC<\/code><\/td>/);
    assert.ok(!out.includes("missing"));
  });

  it("renders nested objects as sections", () => {
    const out = toHtml({
      url: "http://example.com/paid",
      requirements: { scheme: "exact", network: "eip155:8453" },
    });
    assert.match(out, /<h2>requirements<\/h2>/);
    assert.match(out, /<td>scheme<\/td><td><code>exact<\/code><\/td>/);
    assert.match(out, /<td>network<\/td><td><code>eip155:8453<\/code><\/td>/);
  });

  it("renders arrays of objects as one section per item", () => {
    const out = toHtml({
      steps: [
        { name: "handshake", ok: true },
        { name: "settle", ok: false },
      ],
    });
    assert.match(out, /<h2>steps 1<\/h2>/);
    assert.match(out, /<td>name<\/td><td><code>handshake<\/code><\/td>/);
    assert.match(out, /<h2>steps 2<\/h2>/);
    assert.match(out, /<td>name<\/td><td><code>settle<\/code><\/td>/);
  });

  it("renders scalar arrays as lists and empty arrays as none", () => {
    const out = toHtml({ warnings: ["a", "b"], matches: [] });
    assert.match(out, /<h2>warnings<\/h2><ul>\n<li><code>a<\/code><\/li>\n<li><code>b<\/code><\/li>/);
    assert.match(out, /<h2>matches<\/h2><p><em>none<\/em><\/p>/);
  });

  it("stringifies BigInts and escapes hostile markup in values", () => {
    const out = toHtml({
      value: 123n,
      note: '<script>alert("x")</script> & friends',
    });
    assert.match(out, /<td>value<\/td><td><code>123<\/code><\/td>/);
    assert.match(out, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; friends/);
    assert.ok(!out.includes("<script>alert"));
  });
});

describe("renderReport html mode", () => {
  it("renders HTML and ignores the text formatter", () => {
    const out = renderReport(
      { ok: true, url: "http://x" },
      () => "FORMATTER-OUTPUT",
      {
        html: true,
        title: "Handshake check",
      }
    );
    assert.ok(out.startsWith("<!DOCTYPE html>"));
    assert.ok(!out.includes("FORMATTER-OUTPUT"));
  });

  it("defaults to the generic title when none is given", () => {
    assert.ok(
      renderReport({ ok: true }, () => "text", { html: true }).includes(
        "<title>x402-tester report</title>"
      )
    );
  });

  it("rejects combining --json and --report html", () => {
    assert.throws(
      () =>
        renderReport({ ok: true }, () => "text", {
          json: true,
          html: true,
        }),
      /cannot combine/
    );
  });

  it("rejects combining --report md and --report html", () => {
    assert.throws(
      () =>
        renderReport({ ok: true }, () => "text", {
          markdown: true,
          html: true,
        }),
      /cannot combine/
    );
  });
});

describe("CLI --report html flag", () => {
  const cli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "index.js"
  );
  // Same loopback trick as the --report md CLI test: a closed port fails
  // the handshake immediately, and the CLI must still emit the failure
  // report as HTML with the command's title.
  it("check --report html emits HTML for a failed handshake", () => {
    let stdout = "";
    let status = null;
    try {
      stdout = execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--report", "html"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stdout = err.stdout;
      status = err.status;
    }
    assert.ok(stdout.startsWith("<!DOCTYPE html>"));
    assert.match(stdout, /<title>Handshake check<\/title>/);
    assert.match(stdout, /class="status fail">❌ fail/);
    assert.match(stdout, /<td>url<\/td><td><code>http:\/\/127\.0\.0\.1:1<\/code><\/td>/);
    assert.equal(status, 1); // failure exit code is preserved in html mode
  });

  it("rejects combining --json and --report html", () => {
    let stderr = "";
    let status = null;
    try {
      execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--json", "--report", "html"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stderr = err.stderr;
      status = err.status;
    }
    assert.match(stderr, /cannot be combined/);
    assert.equal(status, 1);
  });

  it("accepts --report=html form", () => {
    let stdout = "";
    let status = null;
    try {
      stdout = execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--report=html"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stdout = err.stdout;
      status = err.status;
    }
    assert.ok(stdout.startsWith("<!DOCTYPE html>"));
    assert.equal(status, 1);
  });
});
