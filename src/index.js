#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { checkHandshake, formatReport } from "./handshake.js";
import { parseBatchFile, runBatch, formatBatchReport } from "./batch.js";
import { checkFacilitator, formatFacilitatorReport } from "./facilitator.js";
import { checkX402scan, formatX402scanReport } from "./x402scan.js";
import {
  signPayment,
  pickSignableRequirement,
  generateTestKey,
} from "./pay.js";
import {
  signSolanaPayment,
  parseSolanaSecretKey,
  generateSolanaTestKeypair,
  isSolanaNetwork,
  defaultRpcForNetwork,
  KNOWN_MINTS,
} from "./solana.js";
import {
  runPaidEndToEnd,
  formatEndToEndReport,
  defaultTestRequirement,
} from "./endtoend.js";
import { startMockFacilitator } from "./mockFacilitator.js";
import { startMockEndpoint } from "./endtoend.js";
import {
  renderReport,
  payJsonReport,
  solanaPayJsonReport,
} from "./output.js";
import { resolveConfig, CONFIG_FILENAME } from "./config.js";

const args = process.argv.slice(2);
let [cmd, url, ...flags] = args;

// A leading flag was captured as `url` — fold it back into the flags.
// A URL never starts with "-", so this is always a flag, not an
// address (it also makes `config --config <path>` and `batch --json`
// work when no positional argument comes first).
if (url && url.startsWith("-")) {
  flags = [url, ...flags];
  url = undefined;
}

let method = "GET";
let json = false;
let reportFormat = null; // --report <fmt>; only "md" is supported for now
let key = process.env.X402_TEST_KEY || null;
let solanaKey = process.env.X402_SOLANA_TEST_KEY || null;
let mockPort = 4021;
let endpointPort = 4022;
let rpcUrl; // undefined = the requirement's cluster RPC; --rpc overrides
let blockhash = null; // --blockhash pins it (skips the RPC fetch)
let decimals; // --decimals overrides the mint decimals (default: extra.decimals, then known mints, then 6)
let retries = 0; // --retries <n>: retries after the first attempt (0 = single attempt)
let timeoutMs = 15000; // --timeout <ms>: per-attempt timeout, in milliseconds
let configPath = null; // --config <path>; null = auto-discover x402-tester.json upward
// Flags the user set explicitly — config values only fill options the
// user did NOT set, so CLI flags always beat the config file.
const setFlags = new Set();
// support `--method POST` and `--method=POST` (plus `-m` shorthand),
// plus `--key 0x...` / `--key=0x...` for the signing key
for (let i = 0; i < flags.length; i++) {
  if ((flags[i] === "--method" || flags[i] === "-m") && flags[i + 1]) {
    method = flags[i + 1].toUpperCase();
    setFlags.add("method");
  }
  const m = flags[i].match(/^--?m(?:ethod)?=(.+)$/i);
  if (m) { method = m[1].toUpperCase(); setFlags.add("method"); }
  if (flags[i] === "--key" && flags[i + 1]) key = flags[i + 1];
  const k = flags[i].match(/^--key=(.+)$/);
  if (k) key = k[1];
  if (flags[i] === "--port" && flags[i + 1]) { mockPort = Number(flags[i + 1]); setFlags.add("port"); }
  const p = flags[i].match(/^--port=(\d+)$/);
  if (p) { mockPort = Number(p[1]); setFlags.add("port"); }
  if (flags[i] === "--endpoint-port" && flags[i + 1]) { endpointPort = Number(flags[i + 1]); setFlags.add("endpointPort"); }
  const ep = flags[i].match(/^--endpoint-port=(\d+)$/);
  if (ep) { endpointPort = Number(ep[1]); setFlags.add("endpointPort"); }
  if (flags[i] === "--rpc" && flags[i + 1]) { rpcUrl = flags[i + 1]; setFlags.add("rpc"); }
  const r = flags[i].match(/^--rpc=(.+)$/);
  if (r) { rpcUrl = r[1]; setFlags.add("rpc"); }
  if (flags[i] === "--blockhash" && flags[i + 1]) { blockhash = flags[i + 1]; setFlags.add("blockhash"); }
  const b = flags[i].match(/^--blockhash=(.+)$/);
  if (b) { blockhash = b[1]; setFlags.add("blockhash"); }
  if (flags[i] === "--decimals" && flags[i + 1]) { decimals = Number(flags[i + 1]); setFlags.add("decimals"); }
  const d = flags[i].match(/^--decimals=(\d+)$/);
  if (d) { decimals = Number(d[1]); setFlags.add("decimals"); }
  // `--retries N` / `--retries=N`: extra attempts after the first probe,
  // only for transient failures (transport errors, 429/502/503/504).
  // `--timeout N` / `--timeout=N`: per-attempt timeout in milliseconds.
  if (flags[i] === "--retries" && flags[i + 1]) { retries = Number(flags[i + 1]); setFlags.add("retries"); }
  const rt = flags[i].match(/^--retries=(.+)$/);
  if (rt) { retries = Number(rt[1]); setFlags.add("retries"); }
  if (flags[i] === "--timeout" && flags[i + 1]) { timeoutMs = Number(flags[i + 1]); setFlags.add("timeoutMs"); }
  const to = flags[i].match(/^--timeout=(.+)$/);
  if (to) { timeoutMs = Number(to[1]); setFlags.add("timeoutMs"); }
  // `--json` switches report commands (check, pay, e2e, facilitator,
  // x402scan) to machine-readable JSON output instead of human text
  if (flags[i] === "--json") { json = true; setFlags.add("json"); }
  // `--report md` renders the same reports as Markdown instead of
  // human text; `--report=<fmt>` form also works
  if (flags[i] === "--report" && flags[i + 1]) { reportFormat = flags[i + 1]; setFlags.add("report"); }
  const rf = flags[i].match(/^--report=(.+)$/);
  if (rf) { reportFormat = rf[1]; setFlags.add("report"); }
  // `--config <path>` pins the config file; without it, x402-tester.json
  // is auto-discovered upward from the working directory.
  if (flags[i] === "--config" && flags[i + 1]) configPath = flags[i + 1];
  const cf = flags[i].match(/^--config=(.+)$/);
  if (cf) configPath = cf[1];
}

// Config file: explicit path must exist and parse; auto-discovery is
// silent when nothing is found. Flags beat config, which beats the
// built-in defaults above — so only unset options are filled in.
let config = {};
let configSource = null;
try {
  ({ config, path: configSource } = await resolveConfig({
    explicitPath: configPath,
    startDir: process.cwd(),
  }));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
if (configSource) console.error(`using config file: ${configSource}`);
if (!setFlags.has("method") && config.method) method = config.method;
if (!setFlags.has("json") && config.json !== undefined) json = config.json;
if (!setFlags.has("report") && config.report) reportFormat = config.report;
if (!setFlags.has("rpc") && config.rpc) rpcUrl = config.rpc;
if (!setFlags.has("blockhash") && config.blockhash) blockhash = config.blockhash;
if (!setFlags.has("decimals") && config.decimals !== undefined) decimals = config.decimals;
if (!setFlags.has("port") && config.port !== undefined) mockPort = config.port;
if (!setFlags.has("endpointPort") && config.endpointPort !== undefined) endpointPort = config.endpointPort;
if (!setFlags.has("retries") && config.retries !== undefined) retries = config.retries;
if (!setFlags.has("timeoutMs") && config.timeoutMs !== undefined) timeoutMs = config.timeoutMs;

// Fail on a bad retry/timeout policy before any command runs: a typo
// here must never silently turn into an unbounded retry loop or a
// zero-millisecond timeout.
if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
  console.error("error: --retries must be an integer between 0 and 10");
  process.exit(1);
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
  console.error("error: --timeout must be an integer between 1 and 600000 (milliseconds)");
  process.exit(1);
}

// `--report` only knows "md" so far, and it conflicts with `--json` —
// fail on bad flags before any command runs, not mid-report.
if (reportFormat !== null && reportFormat !== "md") {
  console.error(`error: unknown --report format '${reportFormat}' (supported: md)`);
  process.exit(1);
}
if (json && reportFormat === "md") {
  console.error("error: --json and --report md cannot be combined");
  process.exit(1);
}

function emit(report, formatFn, title) {
  console.log(
    renderReport(report, formatFn, {
      json,
      markdown: reportFormat === "md",
      title,
    })
  );
}

function formatPayReport(signed) {
  const a = signed.payload.payload.authorization;
  return [
    `x402 payment signed for: ${url}`,
    `payer: ${a.from}`,
    `payTo: ${a.to}`,
    `amount: ${a.value} atomic units (${signed.payload.network})`,
    `valid: ${new Date(Number(a.validAfter) * 1000).toISOString()} → ${new Date(Number(a.validBefore) * 1000).toISOString()}`,
    `nonce: ${a.nonce}`,
    `signature: ${signed.signature}`,
    ``,
    `Send it as the X-PAYMENT header (base64):`,
    signed.header,
    ``,
    `curl example:`,
    `  curl -H "X-PAYMENT: ${signed.header.slice(0, 40)}…" ${url}`,
  ].join("\n");
}

function formatSolanaPayReport(signed, requirement) {
  const mintInfo = KNOWN_MINTS[requirement.asset];
  const mintLabel = mintInfo
    ? `${mintInfo.symbol} (${mintInfo.cluster})`
    : "SPL token";
  const selfPaid = signed.feePayer === signed.payer;
  return [
    `x402 payment signed for: ${url}`,
    `payer: ${signed.payer}`,
    `payTo: ${requirement.payTo}`,
    `amount: ${requirement.amount} atomic units of ${mintLabel}`,
    `mint: ${requirement.asset}`,
    `network: ${signed.payload.network}`,
    `fee payer: ${signed.feePayer} ${selfPaid ? "(you — fully signed)" : "(facilitator co-signs and broadcasts)"}`,
    `transaction signature: ${signed.signature}`,
    ``,
    `Send it as the PAYMENT-SIGNATURE header (base64):`,
    signed.header,
    ``,
    `curl example:`,
    `  curl -H "PAYMENT-SIGNATURE: ${signed.header.slice(0, 40)}…" ${url}`,
    ``,
    `Local-only signature — nothing was broadcast. The endpoint's`,
    `facilitator verifies the transaction, co-signs as fee payer, and settles.`,
  ].join("\n");
}

function usage() {
  console.log(`x402-tester — dev toolkit for x402 payment endpoints

Usage:
  x402-tester check <url> [--method <METHOD>] [--json] [--report md]
  x402-tester batch <file> [--method <METHOD>] [--json] [--report md]
  x402-tester pay <url> [--method <METHOD>] [--key <0x...>] [--json] [--report md]
  x402-tester e2e [--key <0x...>] [--json] [--report md]
  x402-tester mock [--port <n>] [--endpoint-port <n>]
  x402-tester facilitator <facilitator-url> [--json] [--report md]
  x402-tester x402scan <url> [--json] [--report md]
  x402-tester config [--config <path>]

Options:
  --config       Config file to read (default: x402-tester.json,
                 auto-discovered upward from the working directory).
                 CLI flags beat config values, which beat defaults.
                 Signing keys are never read from config — use --key
                 or X402_TEST_KEY / X402_SOLANA_TEST_KEY.
  --method, -m   HTTP method for the handshake probe (default: GET).
                 Some paid endpoints are POST-only and answer GET with an
                 empty 402 body — retry them with --method POST.
  --key          Private key used to sign the payment (also reads
                 X402_TEST_KEY). Omit it and a throwaway test key is
                 generated for the run — it has no funds and signs only
                 locally, so nothing can move. For Solana requirements
                 --key takes a base58 secret key or a JSON byte array
                 (X402_SOLANA_TEST_KEY also works).
  --rpc          Solana RPC used to fetch a fresh blockhash for the
                 payment transaction (default: the requirement's cluster
                 RPC; skipped when --blockhash is given or the endpoint
                 supplies extra.recentBlockhash).
  --blockhash    Pin the Solana transaction's recent blockhash explicitly.
  --decimals     SPL mint decimals for the Solana transfer (default:
                 extra.decimals, then known mints, then 6).
  --retries      Retries after the first probe (default: 0). Only
                 transient failures are retried: transport errors and
                 HTTP 429/502/503/504. A 402, 200 or other 4xx is a
                 verdict and is never re-asked.
  --timeout      Per-attempt timeout in milliseconds (default: 15000).
                 Each retry gets a fresh timeout, so a slow first
                 attempt does not eat the next attempt's budget.
  --port         Port for the mock facilitator (default: 4021).
  --endpoint-port
                 Port for the mock paid endpoint (default: 4022).
  --json         Machine-readable output: print the report object as
                 JSON instead of human-readable text. Works with check,
                 batch, pay, e2e, facilitator and x402scan (not mock, which
                 runs an interactive server).
  --report       Report format: --report md renders the report as
                 Markdown instead of human-readable text (same commands
                 as --json; cannot be combined with --json).

Commands:
  check          Validate the 402 handshake of a paid endpoint.
  batch          Check every endpoint listed in a file, one per line
                 (blank lines and # comments ignored; a line may carry
                 its own method, e.g. "POST https://…"). Exit 0 only
                 when every entry passes; unparseable lines count as
                 failures, not silent skips.
  pay            Sign an x402 payment payload for an endpoint: EVM
                 exact-scheme requirements via EIP-712, Solana
                 exact-scheme requirements (e.g. solana:devnet) via a
                 signed SPL transfer transaction. Signs locally and
                 prints the payload + base64 payment header; sends
                 nothing.
  e2e            Run the full paid flow against local mock servers —
                 handshake, sign, facilitator /verify, paid request —
                 with a throwaway test key. No chain, no funds.
  mock           Start a mock facilitator + mock paid endpoint on
                 localhost for manual testing (curl your own client
                 against them); stops on Ctrl-C.
  facilitator    Probe a facilitator's /verify endpoint: an empty POST
                 proves it's alive (a 4xx rejecting the probe is the
                 expected healthy answer).
  x402scan       Check whether an endpoint's host is listed on x402scan's
                 public marketplace (exit 0 = listed).
  config         Print the effective configuration: the config file
                 found (if any) and the merged settings after CLI flags
                 beat config values. Never prints keys.

Config file (x402-tester.json):
  Drop one in your project root and stop repeating flags. Any of
  method, json, report ("md"), rpc, blockhash, decimals, port,
  endpointPort, retries, timeoutMs, and endpoints (a list of URLs,
  each optionally prefixed with a method, e.g. "POST https://…") may
  be set. Config uses timeoutMs (milliseconds); the CLI flag is
  --timeout.
  A command run without a URL checks the first configured endpoint;
  batch run without a file checks all of them. Run
  'x402-tester config' to see what resolved. Precedence: flags >
  config file > built-in defaults.

Examples:
  x402-tester check https://example.com/paid-api
  x402-tester batch endpoints.txt --json | jq .failed
  x402-tester check https://example.com/paid-api --json | jq .price
  x402-tester check https://example.com/paid-api --report md > report.md
  x402-tester check https://example.com/rugcheck --method POST
  x402-tester pay https://example.com/paid-api
  x402-tester pay https://example.com/solana-api --blockhash <hash>
  x402-tester e2e
  x402-tester mock
  x402-tester facilitator https://facilitator.example.com
  x402-tester x402scan https://example.com/paid-api
`);
}

async function runPay(targetUrl) {
  const handshake = await checkHandshake(targetUrl, { method, retries, timeoutMs });
  if (!handshake.ok || !handshake.requirements) {
    console.error(`cannot sign: handshake failed — ${handshake.error}`);
    process.exitCode = 1;
    return;
  }
  let requirement;
  try {
    // handshake only reports the first option; if it isn't signable we stop
    // rather than guess at options the check never validated.
    requirement = pickSignableRequirement([handshake.requirements]);
  } catch (err) {
    console.error(`cannot sign: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (isSolanaNetwork(requirement.network)) {
    await runSolanaPay(requirement);
    return;
  }
  const ephemeral = !key;
  const signingKey = key || generateTestKey();
  if (ephemeral) {
    console.error(
      "warning: no --key given — signing with a fresh throwaway test key (no funds, local only)."
    );
  }
  try {
    const signed = await signPayment(requirement, signingKey);
    emit(payJsonReport(url, method, signed), () => formatPayReport(signed), "Payment");
  } catch (err) {
    console.error(`cannot sign: ${err.message}`);
    process.exitCode = 1;
  }
}

async function runSolanaPay(requirement) {
  const ephemeral = !key && !solanaKey;
  const keyInput = solanaKey || key || null;
  let keypair;
  if (keyInput) {
    try {
      keypair = parseSolanaSecretKey(keyInput);
    } catch (err) {
      console.error(`cannot sign: bad Solana key — ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    keypair = generateSolanaTestKeypair();
  }
  if (ephemeral) {
    console.error(
      "warning: no --key given — signing with a fresh throwaway test keypair (no funds, local only)."
    );
  }
  try {
    const signed = await signSolanaPayment(requirement, keypair, {
      blockhash,
      decimals,
      rpcUrl: rpcUrl === undefined ? defaultRpcForNetwork(requirement.network) : rpcUrl,
    });
    emit(
      solanaPayJsonReport(url, method, requirement, signed),
      () => formatSolanaPayReport(signed, requirement),
      "Payment"
    );
  } catch (err) {
    console.error(`cannot sign: ${err.message}`);
    process.exitCode = 1;
  }
}

async function runE2E() {  const ephemeral = !key;
  const signingKey = key || generateTestKey();
  if (ephemeral) {
    console.error(
      "using a fresh throwaway test key (no funds, local only) — pass --key to use your own test key."
    );
  }
  const report = await runPaidEndToEnd({ privateKey: signingKey });
  emit(report, formatEndToEndReport, "Paid end-to-end test");
  process.exitCode = report.ok ? 0 : 1;
}

async function runBatchFromEntries(entries, invalid = []) {
  if (entries.length === 0 && invalid.length === 0) {
    console.error("no endpoints to check");
    process.exitCode = 1;
    return;
  }
  const report = await runBatch({ entries, invalid }, { retries, timeoutMs });
  emit(report, formatBatchReport, "Batch handshake check");
  process.exitCode = report.ok ? 0 : 1;
}

async function runBatchCmd(file) {
  // No file given: fall back to the config file's endpoints list.
  if (!file) {
    if (config.endpoints && config.endpoints.length > 0) {
      const parsed = parseBatchFile(config.endpoints.join("\n"), {
        defaultMethod: method,
      });
      await runBatchFromEntries(parsed.entries, parsed.invalid);
      return;
    }
    console.error("batch needs a file (or endpoints in x402-tester.json)");
    process.exitCode = 1;
    return;
  }
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (err) {
    console.error(`cannot read batch file '${file}': ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const parsed = parseBatchFile(content, { defaultMethod: method });
  await runBatchFromEntries(parsed.entries, parsed.invalid);
}

async function runMock() {
  const facilitator = await startMockFacilitator({ port: mockPort });
  const endpoint = await startMockEndpoint({
    facilitatorUrl: facilitator.url,
    port: endpointPort,
  });
  const raw = defaultTestRequirement();
  console.log(`mock facilitator:  ${facilitator.url}   (POST /verify, POST /settle)`);
  console.log(`mock paid endpoint: ${endpoint.url}   (unpaid → 402, X-PAYMENT → 200)`);
  console.log(`\nThe endpoint's 402 body offers this requirement (no real funds involved):`);
  console.log(JSON.stringify(raw, null, 2));
  console.log(`\nTry: curl -i ${endpoint.url}/`);
  console.log("Press Ctrl-C to stop.");
  await new Promise((resolve) => process.on("SIGINT", resolve));
  await endpoint.close();
  await facilitator.close();
}

// Commands run without a URL fall back to the config file's first
// endpoint, so a checked-in config makes `check` a zero-argument run.
if (
  !url &&
  (cmd === "check" || cmd === "pay" || cmd === "facilitator" || cmd === "x402scan") &&
  config.endpoints &&
  config.endpoints.length > 0
) {
  const parsed = parseBatchFile(config.endpoints.join("\n"), {
    defaultMethod: method,
  });
  if (parsed.entries.length > 0) url = parsed.entries[0].url;
}

if (cmd === "config") {
  // Inspect the effective configuration: what file was found and the
  // merged settings after flags beat config. Keys are never printed
  // — config never holds them, and env/flag keys stay out of output.
  console.log(
    JSON.stringify(
      {
        file: configSource,
        method,
        json,
        report: reportFormat,
        rpc: rpcUrl ?? null,
        blockhash,
        decimals: decimals ?? null,
        port: mockPort,
        endpointPort,
        retries,
        timeoutMs,
        endpoints: config.endpoints ?? [],
      },
      null,
      2
    )
  );
} else if (cmd === "check" && url) {
  const report = await checkHandshake(url, { method, retries, timeoutMs });
  emit(report, formatReport, "Handshake check");
  process.exitCode = report.ok ? 0 : 1;
} else if (cmd === "batch") {
  await runBatchCmd(url);
} else if (cmd === "pay" && url) {
  await runPay(url);
} else if (cmd === "e2e" && !url) {
  await runE2E();
} else if (cmd === "mock" && !url) {
  await runMock();
} else if (cmd === "facilitator" && url) {
  const report = await checkFacilitator(url, { retries, timeoutMs });
  emit(report, formatFacilitatorReport, "Facilitator check");
  process.exitCode = report.reachable ? 0 : 1;
} else if (cmd === "x402scan" && url) {
  const report = await checkX402scan(url, { retries, timeoutMs });
  emit(report, formatX402scanReport, "Discovery check");
  process.exitCode = report.listed ? 0 : 1;
} else {
  usage();
  process.exitCode = cmd ? 1 : 0;
}
