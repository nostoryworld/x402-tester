import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConfig,
  loadConfigFile,
  findConfigFile,
  resolveConfig,
  ConfigError,
} from "../src/config.js";

const tmp = () => mkdtemp(join(tmpdir(), "x402-tester-config-"));

test("normalises a full config and keeps only present keys", () => {
  assert.deepEqual(
    parseConfig({
      method: "post",
      json: true,
      rpc: "https://api.devnet.solana.com",
      decimals: 6,
      port: 4021,
      endpointPort: 4022,
      endpoints: ["https://example.com/a", "POST https://example.com/b"],
    }),
    {
      method: "POST",
      json: true,
      rpc: "https://api.devnet.solana.com",
      decimals: 6,
      port: 4021,
      endpointPort: 4022,
      endpoints: ["https://example.com/a", "POST https://example.com/b"],
    }
  );
});

test("an empty object is a valid (empty) config", () => {
  assert.deepEqual(parseConfig({}), {});
});

test("accepts retries and timeoutMs, but not bare timeout", () => {
  assert.deepEqual(parseConfig({ retries: 2, timeoutMs: 5000 }), {
    retries: 2,
    timeoutMs: 5000,
  });
  assert.throws(() => parseConfig({ timeout: 5000 }), /unknown key 'timeout'/);
});

test("rejects non-object top levels", () => {
  for (const raw of [null, [], "x", 42]) {
    assert.throws(() => parseConfig(raw), ConfigError);
  }
});

test("rejects unknown keys — and points key-holders at env/flags", () => {
  assert.throws(() => parseConfig({ timeout: 5 }), /unknown key 'timeout'/);
  assert.throws(() => parseConfig({ key: "0xabc" }), /X402_TEST_KEY/);
});

test("rejects bad values per key", () => {
  const bad = [
    [{ method: "" }, /'method'/],
    [{ method: "FETCH" }, /unknown HTTP method/],
    [{ json: "yes" }, /'json'/],
    [{ report: "html" }, /'report' must be 'md'/],
    [{ report: "json" }, /"json": true/],
    [{ rpc: "" }, /'rpc'/],
    [{ blockhash: 42 }, /'blockhash'/],
    [{ decimals: -1 }, /'decimals'/],
    [{ decimals: 1.5 }, /'decimals'/],
    [{ port: 0 }, /'port'/],
    [{ port: 70000 }, /'port'/],
    [{ port: "4021" }, /'port'/],
    [{ endpointPort: 99999 }, /'endpointPort'/],
    [{ retries: -1 }, /'retries'/],
    [{ retries: 11 }, /'retries'/],
    [{ retries: 1.5 }, /'retries'/],
    [{ timeoutMs: 0 }, /'timeoutMs'/],
    [{ timeoutMs: 600001 }, /'timeoutMs'/],
    [{ timeoutMs: "5000" }, /'timeoutMs'/],
    [{ endpoints: [] }, /'endpoints'/],
    [{ endpoints: "https://example.com" }, /'endpoints'/],
    [{ endpoints: ["not-a-url"] }, /not an http\(s\) URL/],
    [{ endpoints: ["FETCH https://example.com"] }, /unknown method/],
    [{ endpoints: ["GET https://example.com extra"] }, /'<METHOD> <url>'/],
  ];
  for (const [raw, pattern] of bad) {
    assert.throws(() => parseConfig(raw), pattern, JSON.stringify(raw));
  }
});

test("loadConfigFile reads and validates a file on disk", async () => {
  const dir = await tmp();
  const path = join(dir, "x402-tester.json");
  await writeFile(path, JSON.stringify({ method: "POST" }), "utf8");
  assert.deepEqual(await loadConfigFile(path), { method: "POST" });
  await writeFile(path, "{ not json", "utf8");
  await assert.rejects(() => loadConfigFile(path), /invalid JSON/);
  await assert.rejects(
    () => loadConfigFile(join(dir, "missing.json")),
    /cannot read config file/
  );
});

test("findConfigFile walks up to a parent directory", async () => {
  const dir = await tmp();
  const sub = join(dir, "a", "b");
  await mkdir(sub, { recursive: true });
  const path = join(dir, "x402-tester.json");
  await writeFile(path, "{}", "utf8");
  assert.equal(await findConfigFile(sub), path);
  assert.equal(await findConfigFile(dir), path);
});

test("findConfigFile returns null when no ancestor holds a config", async () => {
  const dir = await tmp();
  assert.equal(await findConfigFile(dir), null);
});

test("resolveConfig prefers an explicit path and reports the source", async () => {
  const dir = await tmp();
  const explicit = join(dir, "custom.json");
  await writeFile(explicit, JSON.stringify({ json: true }), "utf8");
  const found = await resolveConfig({ explicitPath: explicit, startDir: dir });
  assert.deepEqual(found, { config: { json: true }, path: explicit });

  const discovered = join(dir, "x402-tester.json");
  await writeFile(discovered, JSON.stringify({ method: "GET" }), "utf8");
  const auto = await resolveConfig({ startDir: dir });
  assert.deepEqual(auto, { config: { method: "GET" }, path: discovered });

  const none = await resolveConfig({ startDir: await tmp() });
  assert.deepEqual(none, { config: {}, path: null });
});
