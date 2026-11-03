import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginError,
  normalizePluginResult,
  loadPlugin,
  loadPlugins,
  runPlugin,
  runPlugins,
  applyPluginResults,
} from "../src/plugins.js";
import { formatReport } from "../src/handshake.js";
import { collectAnnotations } from "../src/ci.js";
import { parseConfig } from "../src/config.js";

const plugin = (name) => ({ name, check: () => {} });

describe("normalizePluginResult", () => {
  it("treats nothing, null, and true as a pass", () => {
    assert.deepEqual(normalizePluginResult(undefined, plugin("a")), { name: "a", ok: true });
    assert.deepEqual(normalizePluginResult(null, plugin("a")), { name: "a", ok: true });
    assert.deepEqual(normalizePluginResult(true, plugin("a")), { name: "a", ok: true });
  });

  it("treats false as a failure with a default message", () => {
    assert.deepEqual(normalizePluginResult(false, plugin("a")), {
      name: "a",
      ok: false,
      message: "check failed",
    });
  });

  it("treats a string as a failure message", () => {
    assert.deepEqual(normalizePluginResult("too pricey", plugin("a")), {
      name: "a",
      ok: false,
      message: "too pricey",
    });
  });

  it("passes through ok/message/warning objects, and error as a message alias", () => {
    assert.deepEqual(
      normalizePluginResult({ ok: true, warning: "watch out" }, plugin("a")),
      { name: "a", ok: true, warning: "watch out" }
    );
    assert.deepEqual(
      normalizePluginResult({ ok: false, error: "nope" }, plugin("a")),
      { name: "a", ok: false, message: "nope" }
    );
    assert.deepEqual(
      normalizePluginResult({ ok: false }, plugin("a")),
      { name: "a", ok: false, message: "check failed" }
    );
  });

  it("treats a warning-only object as a pass with a warning", () => {
    assert.deepEqual(normalizePluginResult({ warning: "watch out" }, plugin("a")), {
      name: "a",
      ok: true,
      warning: "watch out",
    });
  });

  it("treats a message-only object as a failure", () => {
    assert.deepEqual(normalizePluginResult({ message: "nope" }, plugin("a")), {
      name: "a",
      ok: false,
      message: "nope",
    });
  });

  it("rejects empty strings, bare objects, and other types", () => {
    assert.throws(() => normalizePluginResult("", plugin("a")), PluginError);
    assert.throws(() => normalizePluginResult({}, plugin("a")), PluginError);
    assert.throws(() => normalizePluginResult(42, plugin("a")), PluginError);
    assert.throws(() => normalizePluginResult({ ok: "yes" }, plugin("a")), PluginError);
  });
});

describe("loadPlugin / loadPlugins", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "x402-plugins-"));
    await writeFile(
      join(dir, "fn-check.mjs"),
      `export default function checkBase(ctx) { return ctx.requirements.network === "base"; }\n`
    );
    await writeFile(
      join(dir, "obj-check.mjs"),
      `export default { name: "only-base", check: () => ({ ok: true }) };\n`
    );
    await writeFile(
      join(dir, "anon-check.mjs"),
      `export default { check: () => true };\n`
    );
    await writeFile(
      join(dir, "bad-check.mjs"),
      `export default 42;\n`
    );
    await writeFile(
      join(dir, "anon-fn.mjs"),
      `export default () => true;\n`
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a function export, keeping the function's name", async () => {
    const loaded = await loadPlugin(join(dir, "fn-check.mjs"));
    assert.equal(loaded.name, "checkBase");
    assert.equal(typeof loaded.check, "function");
  });

  it("loads an object export with its declared name", async () => {
    const loaded = await loadPlugin(join(dir, "obj-check.mjs"));
    assert.equal(loaded.name, "only-base");
  });

  it("falls back to the file stem when an object export has no name", async () => {
    const loaded = await loadPlugin(join(dir, "anon-check.mjs"));
    assert.equal(loaded.name, "anon-check");
  });

  it("falls back to the file stem for an anonymous default-export function (not 'default')", async () => {
    const loaded = await loadPlugin(join(dir, "anon-fn.mjs"));
    assert.equal(loaded.name, "anon-fn");
  });

  it("fails closed on a missing file", async () => {
    await assert.rejects(
      () => loadPlugin(join(dir, "no-such-plugin.mjs")),
      /cannot load plugin/
    );
  });

  it("fails closed on an export that is neither a function nor { check }", async () => {
    await assert.rejects(
      () => loadPlugin(join(dir, "bad-check.mjs")),
      /must default-export a function/
    );
  });

  it("dedupes the same file listed twice, preserving order", async () => {
    const loaded = await loadPlugins([
      join(dir, "fn-check.mjs"),
      join(dir, "obj-check.mjs"),
      join(dir, "fn-check.mjs"),
    ]);
    assert.deepEqual(
      loaded.map((p) => p.name),
      ["checkBase", "only-base"]
    );
  });
});

describe("runPlugin / runPlugins", () => {
  it("runs plugins in order and passes the same context to each", async () => {
    const seen = [];
    const plugins = [
      { name: "first", check: async (ctx) => { seen.push(["first", ctx.url]); } },
      { name: "second", check: (ctx) => { seen.push(["second", ctx.url]); return "bad"; } },
    ];
    const results = await runPlugins(plugins, { url: "https://example.com/paid" });
    assert.deepEqual(seen, [
      ["first", "https://example.com/paid"],
      ["second", "https://example.com/paid"],
    ]);
    assert.deepEqual(results, [
      { name: "first", ok: true },
      { name: "second", ok: false, message: "bad" },
    ]);
  });

  it("turns a throwing check into a failed result, not an exception", async () => {
    const result = await runPlugin(
      { name: "boom", check: () => { throw new Error("kaboom"); } },
      {}
    );
    assert.deepEqual(result, {
      name: "boom",
      ok: false,
      message: "plugin error: kaboom",
    });
  });

  it("turns a rejecting check and a bad return shape into failed results", async () => {
    const rejected = await runPlugin(
      { name: "async-boom", check: async () => { throw new Error("async kaboom"); } },
      {}
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /async kaboom/);
    const badShape = await runPlugin({ name: "weird", check: () => 42 }, {});
    assert.equal(badShape.ok, false);
    assert.match(badShape.message, /plugin error/);
  });
});

describe("applyPluginResults", () => {
  it("flips ok to false on a plugin failure, leaving the original report untouched", () => {
    const report = { url: "https://example.com/paid", ok: true, warnings: [] };
    const applied = applyPluginResults(report, [
      { name: "only-base", ok: false, message: "expected base" },
    ]);
    assert.equal(applied.ok, false);
    assert.equal(applied.plugins[0].message, "expected base");
    assert.equal(report.ok, true);
  });

  it("appends plugin warnings prefixed with the plugin name", () => {
    const applied = applyPluginResults(
      { url: "https://example.com/paid", ok: true, warnings: ["existing"] },
      [{ name: "watch", ok: true, warning: "price looks odd" }]
    );
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.warnings, [
      "existing",
      "plugin watch: price looks odd",
    ]);
  });

  it("keeps a clean pass clean", () => {
    const applied = applyPluginResults(
      { url: "https://example.com/paid", ok: true, warnings: [] },
      [{ name: "only-base", ok: true }]
    );
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.warnings, []);
  });
});

describe("plugin results in reports and CI annotations", () => {
  it("formatReport prints plugin pass/fail lines", () => {
    const text = formatReport({
      url: "https://example.com/paid",
      ok: false,
      latencyMs: 10,
      method: "GET",
      warnings: [],
      plugins: [
        { name: "only-base", ok: true },
        { name: "cheap", ok: false, message: "too pricey" },
      ],
    });
    assert.match(text, /plugin only-base: PASS/);
    assert.match(text, /plugin cheap: FAIL: too pricey/);
  });

  it("a plugin-only failure yields one plugin annotation, not a generic duplicate", () => {
    const out = collectAnnotations(
      {
        url: "https://example.com/paid",
        ok: false,
        warnings: [],
        plugins: [{ name: "only-base", ok: false, message: "expected base" }],
      },
      { command: "check" }
    );
    assert.deepEqual(out, [
      {
        level: "error",
        message: "https://example.com/paid: plugin only-base: expected base",
        title: "x402-tester check",
      },
    ]);
  });
});

describe("config plugins key", () => {
  it("accepts a list of plugin paths, including an empty list", () => {
    assert.deepEqual(parseConfig({ plugins: ["./only-base.mjs"] }).plugins, [
      "./only-base.mjs",
    ]);
    assert.deepEqual(parseConfig({ plugins: [] }).plugins, []);
  });

  it("rejects a non-array or a blank entry", () => {
    assert.throws(() => parseConfig({ plugins: "./only-base.mjs" }), /'plugins' must be an array/);
    assert.throws(() => parseConfig({ plugins: ["  "] }), /non-empty strings/);
  });
});

describe("CLI --plugin flag", () => {
  const cli = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "index.js"
  );

  it("a plugin path that cannot be loaded fails before any check runs", () => {
    let stderr = "";
    let status = null;
    try {
      execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--plugin", "/definitely/not/a-plugin.mjs"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stderr = err.stderr;
      status = err.status;
    }
    assert.match(stderr, /error: cannot load plugin/);
    assert.equal(status, 1);
  });

  it("config command reports the configured plugin paths", () => {
    // Run from a temp dir with a config file so no real config leaks in.
    let stdout = "";
    const dir = join(tmpdir(), `x402-plugin-cli-${process.pid}`);
    execFileSync(process.execPath, ["-e", `
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      writeFileSync(${JSON.stringify(join(dir, "x402-tester.json"))},
        JSON.stringify({ plugins: ["./only-base.mjs"] }));
    `], { encoding: "utf8" });
    try {
      stdout = execFileSync(
        process.execPath,
        [cli, "config", "--config", join(dir, "x402-tester.json")],
        { encoding: "utf8", timeout: 20000 }
      );
    } finally {
      execFileSync("rm", ["-rf", dir]);
    }
    assert.deepEqual(JSON.parse(stdout).plugins, ["./only-base.mjs"]);
  });
});
