import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  renderReport,
  payJsonReport,
  solanaPayJsonReport,
} from "../src/output.js";
import { signPayment } from "../src/pay.js";
import {
  signSolanaPayment,
  generateSolanaTestKeypair,
} from "../src/solana.js";
import { normalizeRequirement } from "../src/requirements.js";

const EVM_KEY =
  "0xe0f001b9b27342c3fdf1cd39d9e5b173368437956af8dc71dfba8b3e7451f575"; // test fixture, no funds
const NOW = 1_790_000_000; // fixed clock for deterministic signatures

const EVM_REQ = {
  scheme: "exact",
  network: "eip155:8453",
  payTo: "0x8e37022edcf0f21cf3c9f93fee9d4d32519f36f4",
  asset: "0x833589fCD6edB6e08F4C7C32D4F71B54BdA923b6", // USDC on Base
  amount: "3000",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
  version: 2,
};

const seed = (start) =>
  Uint8Array.from({ length: 32 }, (_, i) => (start + i) % 256);
const SOL_PAYER = generateSolanaTestKeypair(); // fresh throwaway keypair
const SOL_BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8B91K9zXhNf8dKQeRZJg8xX"; // fixed fixture, never fetched

const SOL_RAW = {
  scheme: "exact",
  network: "solana:devnet",
  payTo: generateSolanaTestKeypair().publicKey.toBase58(),
  asset: generateSolanaTestKeypair().publicKey.toBase58(), // test-only mint stand-in
  amount: "2500",
  maxTimeoutSeconds: 300,
  extra: { decimals: 6 },
  version: 1,
};

describe("renderReport", () => {
  it("delegates to the text formatter by default", () => {
    const out = renderReport({ ok: true }, (r) => `OK=${r.ok}`);
    assert.equal(out, "OK=true");
  });

  it("emits pretty-printed JSON that round-trips when --json is set", () => {
    const report = {
      url: "http://example.com/paid",
      ok: true,
      price: "0.002 USDC",
      requirements: { scheme: "exact", network: "base" },
    };
    const out = renderReport(report, () => "text", { json: true });
    assert.match(out, /\n/); // pretty, not compact
    assert.deepEqual(JSON.parse(out), report);
  });

  it("stringifies BigInts instead of throwing", () => {
    const report = { value: 123n, nested: { nonce: 0n } };
    const parsed = JSON.parse(renderReport(report, () => "text", { json: true }));
    assert.deepEqual(parsed, { value: "123", nested: { nonce: "0" } });
  });

  it("omits undefined fields per JSON semantics", () => {
    const parsed = JSON.parse(
      renderReport({ ok: false, error: undefined }, () => "text", { json: true })
    );
    assert.deepEqual(parsed, { ok: false });
  });
});

describe("payJsonReport", () => {
  it("curates a signed EVM payment into a JSON-safe report", async () => {
    const signed = await signPayment(EVM_REQ, EVM_KEY, { nowSec: NOW });
    const report = payJsonReport("http://example.com/paid", "POST", signed);
    const out = JSON.stringify(report);
    assert.equal(report.url, "http://example.com/paid");
    assert.equal(report.method, "POST");
    assert.equal(report.network, "eip155:8453");
    assert.equal(report.scheme, "exact");
    assert.equal(report.payTo, EVM_REQ.payTo);
    assert.equal(report.amount, EVM_REQ.amount);
    assert.equal(report.signature, signed.signature);
    assert.deepEqual(report.payload, signed.payload);
    // the base64 header decodes back to the payload (ready to send as X-PAYMENT)
    const decoded = JSON.parse(Buffer.from(report.header, "base64").toString("utf8"));
    assert.deepEqual(decoded, signed.payload);
    // no private key material anywhere in the JSON
    assert.ok(!out.includes(EVM_KEY.slice(2)));
    assert.ok(!out.includes("account"));
  });
});

describe("solanaPayJsonReport", () => {
  it("curates a signed Solana payment without key material", async () => {
    const requirement = normalizeRequirement(SOL_RAW, 1);
    const signed = await signSolanaPayment(requirement, SOL_PAYER, {
      blockhash: SOL_BLOCKHASH,
    });
    const report = solanaPayJsonReport(
      "http://example.com/solana",
      "GET",
      requirement,
      signed
    );
    const out = JSON.stringify(report);
    assert.equal(report.url, "http://example.com/solana");
    assert.equal(report.network, "solana:devnet");
    assert.equal(report.payer, SOL_PAYER.publicKey.toBase58());
    assert.equal(report.payTo, SOL_RAW.payTo);
    assert.equal(report.amount, "2500");
    assert.equal(report.asset, SOL_RAW.asset);
    assert.equal(report.transactionSignature, signed.signature);
    assert.deepEqual(report.payload, signed.payload);
    // the base64 header decodes back to the payload (ready to send as PAYMENT-SIGNATURE)
    const decoded = JSON.parse(Buffer.from(report.header, "base64").toString("utf8"));
    assert.deepEqual(decoded, signed.payload);
    // the secret key bytes must not appear in the JSON in any encoding
    const secretB64 = Buffer.from(SOL_PAYER.secretKey).toString("base64");
    assert.ok(!out.includes(secretB64));
    assert.ok(!out.includes("secretKey"));
    assert.ok(!out.includes("keypair"));
  });
});

describe("CLI --json flag", () => {
  const cli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "index.js"
  );
  // A sandbox quirk blocks fetch-to-loopback in spawned child processes,
  // so a local 402 server can't be probed from a CLI child. Instead we
  // hit a closed loopback port: the connection is refused immediately,
  // and the CLI must still emit the failure report as parseable JSON.
  it("check --json emits parseable JSON for a failed handshake", () => {
    let stdout = "";
    let status = null;
    try {
      stdout = execFileSync(
        process.execPath,
        [cli, "check", "http://127.0.0.1:1", "--json"],
        { encoding: "utf8", timeout: 20000 }
      );
    } catch (err) {
      stdout = err.stdout;
      status = err.status;
    }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.url, "http://127.0.0.1:1");
    assert.match(parsed.error, /request failed/);
    assert.equal(status, 1); // failure exit code is preserved in JSON mode
  });
});
