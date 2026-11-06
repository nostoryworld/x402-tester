import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  escapeAnnotationData,
  escapeAnnotationProperty,
  formatAnnotation,
  reportPassed,
  hasWarnings,
  collectAnnotations,
  ciExitCode,
  emitCiAnnotations,
} from "../src/ci.js";

describe("escapeAnnotationData / escapeAnnotationProperty", () => {
  it("escapes % first, then CR and LF, so newlines cannot split an annotation", () => {
    assert.equal(escapeAnnotationData("100% sure\r\nnext"), "100%25 sure%0D%0Anext");
  });

  it("additionally escapes : and , in property values", () => {
    assert.equal(escapeAnnotationProperty("a:b,c%d"), "a%3Ab%2Cc%25d");
  });
});

describe("formatAnnotation", () => {
  it("formats a bare annotation with no properties", () => {
    assert.equal(formatAnnotation("error", "boom"), "::error::boom");
  });

  it("formats properties in file,line,endLine,title order", () => {
    assert.equal(
      formatAnnotation("warning", "careful", {
        title: "x402-tester check",
        file: "a,b.ts",
        line: 3,
      }),
      "::warning file=a%2Cb.ts,line=3,title=x402-tester check::careful"
    );
  });

  it("escapes the message so it stays one log line", () => {
    assert.equal(
      formatAnnotation("error", "line1\nline2"),
      "::error::line1%0Aline2"
    );
  });

  it("throws on an unknown level instead of emitting a line GitHub ignores", () => {
    assert.throws(() => formatAnnotation("fatal", "x"), /unknown annotation level/);
  });
});

describe("reportPassed", () => {
  it("reads ok, reachable, and listed verdicts", () => {
    assert.equal(reportPassed({ ok: true }), true);
    assert.equal(reportPassed({ ok: false }), false);
    assert.equal(reportPassed({ reachable: true }), true);
    assert.equal(reportPassed({ reachable: false }), false);
    assert.equal(reportPassed({ listed: false }), false);
  });

  it("reads end-to-end steps and batch results when no top-level verdict exists", () => {
    assert.equal(reportPassed({ steps: [{ ok: true }, { ok: false }] }), false);
    assert.equal(reportPassed({ steps: [{ ok: true }] }), true);
    assert.equal(reportPassed({ results: [] }), false);
  });

  it("does not invent a failure for a report with no failure signal", () => {
    assert.equal(reportPassed({ url: "https://example.com" }), true);
  });

  it("rejects a non-report", () => {
    assert.equal(reportPassed(null), false);
  });
});

describe("hasWarnings", () => {
  it("finds top-level warnings and batch-result warnings", () => {
    assert.equal(hasWarnings({ warnings: ["w"] }), true);
    assert.equal(hasWarnings({ warnings: [] }), false);
    assert.equal(
      hasWarnings({ results: [{ ok: true, warnings: [] }, { ok: true, warnings: ["w"] }] }),
      true
    );
    assert.equal(hasWarnings({ results: [{ ok: true }] }), false);
  });

  it("treats compare differences as warnings", () => {
    assert.equal(
      hasWarnings({ ok: true, differences: [{ field: "price", a: "0.02 USDC", b: "0.05 USDC" }] }),
      true
    );
    assert.equal(hasWarnings({ ok: true, differences: [] }), false);
  });
});

describe("collectAnnotations", () => {
  it("emits an error for a failed single check and warnings alongside it", () => {
    const out = collectAnnotations(
      { url: "https://example.com/paid", ok: false, error: "expected 402, got 200", warnings: ["odd"] },
      { command: "check" }
    );
    assert.deepEqual(out, [
      { level: "error", message: "https://example.com/paid: expected 402, got 200", title: "x402-tester check" },
      { level: "warning", message: "https://example.com/paid: odd", title: "x402-tester check" },
    ]);
  });

  it("emits only warnings for a passing check with warnings", () => {
    const out = collectAnnotations({
      url: "https://example.com/paid",
      ok: true,
      warnings: ["price sanity: option 1 (0.0000001 USDC) — under 0.001 USDC"],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "warning");
  });

  it("emits nothing for a clean pass", () => {
    assert.deepEqual(collectAnnotations({ ok: true, warnings: [] }), []);
  });

  it("emits one error per failed batch result, prefixed with its URL", () => {
    const out = collectAnnotations({
      ok: false,
      results: [
        { url: "https://a.example.com", ok: true },
        { url: "https://b.example.com", ok: false, error: "request failed: refused" },
      ],
    });
    assert.deepEqual(out, [
      { level: "error", message: "https://b.example.com: request failed: refused", title: "x402-tester" },
    ]);
  });

  it("emits one error per failed benchmark probe and per failed e2e step", () => {
    assert.deepEqual(
      collectAnnotations({ ok: false, failures: [{ probe: 2, error: "got 500" }] }),
      [{ level: "error", message: "probe 2 failed: got 500", title: "x402-tester" }]
    );
    assert.deepEqual(
      collectAnnotations({ steps: [{ name: "verify", ok: false, detail: "rejected" }] }),
      [{ level: "error", message: "verify: rejected", title: "x402-tester" }]
    );
  });

  it("emits rate-limit probe warnings alongside probe errors", () => {
    const out = collectAnnotations(
      {
        url: "https://example.com/paid-api",
        ok: true,
        failures: [],
        warnings: ["2 of 2 429 responses carried no Retry-After header — clients must guess when to retry"],
      },
      { command: "ratelimit" }
    );
    assert.deepEqual(out, [
      {
        level: "warning",
        message: "https://example.com/paid-api: 2 of 2 429 responses carried no Retry-After header — clients must guess when to retry",
        title: "x402-tester ratelimit",
      },
    ]);
  });

  it("emits one error per schema mismatch, naming the field", () => {
    const out = collectAnnotations({
      file: "paid-response.json",
      ok: false,
      errors: [{ path: "$.price", message: "expected number" }],
    });
    assert.deepEqual(out, [
      { level: "error", message: "paid-response.json: $.price: expected number", title: "x402-tester" },
    ]);
  });

  it("falls back to diagnosis for discovery/facilitator failures without an error field", () => {
    const out = collectAnnotations({
      url: "https://example.com/paid",
      listed: false,
      diagnosis: "not listed in the CDP Bazaar (scanned 3 resources, none matched)",
    });
    assert.equal(out[0].level, "error");
    assert.match(out[0].message, /not listed in the CDP Bazaar/);
  });

  it("emits one warning per compare difference and no error when both handshakes pass", () => {
    const out = collectAnnotations(
      {
        urlA: "https://a.example.com/paid",
        urlB: "https://b.example.com/paid",
        ok: true,
        identical: false,
        differences: [
          { field: "price", a: "0.02 USDC", b: "0.05 USDC" },
          { field: "network", a: "base", b: "ethereum" },
        ],
        a: { ok: true },
        b: { ok: true },
      },
      { command: "compare" }
    );
    assert.deepEqual(out, [
      { level: "warning", message: "price: 0.02 USDC vs 0.05 USDC", title: "x402-tester compare" },
      { level: "warning", message: "network: base vs ethereum", title: "x402-tester compare" },
    ]);
  });

  it("emits an error for a failing compare side and no duplicate warning for the handshake difference", () => {
    const out = collectAnnotations(
      {
        urlA: "https://a.example.com/paid",
        urlB: "https://b.example.com/paid",
        ok: false,
        identical: false,
        differences: [{ field: "handshake", a: "ok", b: "expected 402, got 200" }],
        a: { ok: true },
        b: { ok: false, error: "expected 402, got 200" },
      },
      { command: "compare" }
    );
    assert.deepEqual(out, [
      { level: "error", message: "https://b.example.com/paid: expected 402, got 200", title: "x402-tester compare" },
    ]);
  });

  it("emits nothing for an identical compare", () => {
    assert.deepEqual(
      collectAnnotations({
        urlA: "https://a.example.com/paid",
        urlB: "https://b.example.com/paid",
        ok: true,
        identical: true,
        differences: [],
        a: { ok: true },
        b: { ok: true },
      }),
      []
    );
  });
});

describe("ciExitCode", () => {
  it("is 0 on a clean pass and 1 on any failure", () => {
    assert.equal(ciExitCode({ ok: true }), 0);
    assert.equal(ciExitCode({ ok: false }), 1);
    assert.equal(ciExitCode({ reachable: false }), 1);
    assert.equal(ciExitCode({ listed: false }), 1);
  });

  it("is strict only in CI mode: warnings pass normally, fail with --ci", () => {
    const warned = { ok: true, warnings: ["price sanity: dust"] };
    assert.equal(ciExitCode(warned), 0);
    assert.equal(ciExitCode(warned, { ci: true }), 1);
  });

  it("is strict for batch warnings too", () => {
    const batch = {
      ok: true,
      results: [{ url: "https://a.example.com", ok: true, warnings: ["w"] }],
    };
    assert.equal(ciExitCode(batch), 0);
    assert.equal(ciExitCode(batch, { ci: true }), 1);
  });

  it("is strict for compare differences: drift passes normally, fails with --ci", () => {
    const drifted = {
      ok: true,
      differences: [{ field: "price", a: "0.02 USDC", b: "0.05 USDC" }],
    };
    assert.equal(ciExitCode(drifted), 0);
    assert.equal(ciExitCode(drifted, { ci: true }), 1);
    assert.equal(ciExitCode({ ok: true, differences: [] }, { ci: true }), 0);
  });
});

describe("emitCiAnnotations", () => {
  it("writes formatted annotations via the injected writer and returns them", () => {
    const lines = [];
    const out = emitCiAnnotations(
      { url: "https://example.com/paid", ok: false, error: "got 500" },
      { command: "check", write: (line) => lines.push(line) }
    );
    assert.equal(out.length, 1);
    assert.equal(lines[0], "::error title=x402-tester check::https://example.com/paid: got 500");
  });
});

describe("CLI --ci flag", () => {
  const cli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "index.js"
  );
  // Same sandbox quirk as the --json CLI test: fetch-to-loopback is
  // blocked in spawned children, so a closed loopback port stands in
  // for a failing endpoint — refused immediately, still a failure.
  it("check --ci puts the annotation on stderr, keeps stdout parseable JSON, and exits 1", () => {
    let stdout = "";
    let stderr = "";
    let status = null;
    try {
      stdout = execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--json", "--ci"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stdout = err.stdout;
      stderr = err.stderr;
      status = err.status;
    }
    const parsed = JSON.parse(stdout); // annotations must not pollute stdout
    assert.equal(parsed.ok, false);
    assert.match(stderr, /::error title=x402-tester check::/);
    assert.equal(status, 1);
  });
});
