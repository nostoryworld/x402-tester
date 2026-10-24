import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { toMarkdown } from "../src/markdown.js";
import { renderReport } from "../src/output.js";

describe("toMarkdown", () => {
  it("heads the document with the given title", () => {
    const out = toMarkdown({ ok: true }, "Handshake check");
    assert.ok(out.startsWith("# Handshake check\n"));
  });

  it("adds a pass/fail status line from a boolean ok field", () => {
    assert.match(toMarkdown({ ok: true }), /\*\*Status:\*\* ✅ pass/);
    assert.match(toMarkdown({ ok: false }), /\*\*Status:\*\* ❌ fail/);
  });

  it("renders scalar fields as a table and skips undefined", () => {
    const out = toMarkdown({
      url: "http://example.com/paid",
      status: 402,
      price: "0.02 USDC",
      missing: undefined,
    });
    assert.match(out, /\| url \| `http:\/\/example\.com\/paid` \|/);
    assert.match(out, /\| status \| `402` \|/);
    assert.match(out, /\| price \| `0\.02 USDC` \|/);
    assert.ok(!out.includes("missing"));
  });

  it("renders nested objects as subsections", () => {
    const out = toMarkdown({
      url: "http://example.com/paid",
      requirements: { scheme: "exact", network: "eip155:8453" },
    });
    assert.match(out, /## requirements\n/);
    assert.match(out, /\| scheme \| `exact` \|/);
    assert.match(out, /\| network \| `eip155:8453` \|/);
  });

  it("renders arrays of objects as one subsection per item", () => {
    const out = toMarkdown({
      steps: [
        { name: "handshake", ok: true },
        { name: "settle", ok: false },
      ],
    });
    assert.match(out, /## steps 1\n/);
    assert.match(out, /\| name \| `handshake` \|/);
    assert.match(out, /## steps 2\n/);
    assert.match(out, /\| name \| `settle` \|/);
  });

  it("renders scalar arrays as bullet lists and empty arrays as none", () => {
    const out = toMarkdown({ warnings: ["a", "b"], matches: [] });
    assert.match(out, /## warnings\n\n- `a`\n- `b`/);
    assert.match(out, /## matches\n\n_\(none\)_/);
  });

  it("stringifies BigInts and escapes table pipes", () => {
    const out = toMarkdown({ value: 123n, note: "a|b" });
    assert.match(out, /\| value \| `123` \|/);
    assert.match(out, /\| note \| `a\\\|b` \|/);
  });
});

describe("renderReport markdown mode", () => {
  it("renders Markdown and ignores the text formatter", () => {
    const out = renderReport({ ok: true, url: "http://x" }, () => "text", {
      markdown: true,
      title: "Handshake check",
    });
    assert.ok(out.startsWith("# Handshake check\n"));
    assert.ok(!out.includes("text"));
  });

  it("defaults to the generic title when none is given", () => {
    assert.ok(
      renderReport({ ok: true }, () => "text", { markdown: true }).startsWith(
        "# x402-tester report\n"
      )
    );
  });

  it("rejects combining --json and --report md", () => {
    assert.throws(
      () =>
        renderReport({ ok: true }, () => "text", {
          json: true,
          markdown: true,
        }),
      /cannot combine/
    );
  });
});

describe("CLI --report md flag", () => {
  const cli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "index.js"
  );
  // Same loopback trick as the --json CLI test: a closed port fails the
  // handshake immediately, and the CLI must still emit the failure
  // report as Markdown with the command's title.
  it("check --report md emits Markdown for a failed handshake", () => {
    let stdout = "";
    let status = null;
    try {
      stdout = execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--report", "md"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stdout = err.stdout;
      status = err.status;
    }
    assert.ok(stdout.startsWith("# Handshake check\n"));
    assert.match(stdout, /\*\*Status:\*\* ❌ fail/);
    assert.match(stdout, /\| url \| `http:\/\/127\.0\.0\.1:1` \|/);
    assert.match(stdout, /\| error \| `request failed/);
    assert.equal(status, 1); // failure exit code is preserved in md mode
  });

  it("rejects an unknown --report format before running", () => {
    let stderr = "";
    let status = null;
    try {
      execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--report", "pdf"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stderr = err.stderr;
      status = err.status;
    }
    assert.match(stderr, /unknown --report format 'pdf'/);
    assert.equal(status, 1);
  });

  it("rejects combining --json and --report md", () => {
    let stderr = "";
    let status = null;
    try {
      execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--json", "--report", "md"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stderr = err.stderr;
      status = err.status;
    }
    assert.match(stderr, /cannot be combined/);
    assert.equal(status, 1);
  });
});
