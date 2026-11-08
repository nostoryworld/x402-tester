#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { checkHandshake, formatReport } from "./handshake.js";
import { parseBatchFile, runBatch, formatBatchReport } from "./batch.js";
import { checkFacilitator, formatFacilitatorReport } from "./facilitator.js";
import { checkX402scan, formatX402scanReport } from "./x402scan.js";
import { checkBazaar, formatBazaarReport } from "./bazaar.js";
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
import {
  runBenchmark,
  formatBenchmarkReport,
  DEFAULT_PROBES,
  MAX_PROBES,
} from "./benchmark.js";
import {
  validatePaidResponse,
  assertValidSchema,
  formatSchemaReport,
} from "./schema.js";
import { emitCiAnnotations, ciExitCode } from "./ci.js";
import {
  loadPlugins,
  runPlugins,
  applyPluginResults,
} from "./plugins.js";
import {
  compareEndpoints,
  formatCompareReport,
} from "./compare.js";
import {
  probeRateLimit,
  formatRateLimitReport,
  DEFAULT_BURST,
  MAX_BURST,
} from "./ratelimit.js";
import {
  runReplayCheck,
  formatReplayReport,
} from "./replay.js";
import {
  listFixtures,
  loadFixture,
  checkFixture,
  formatFixtureList,
  formatFixtureReport,
} from "./fixtures.js";

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
let reportFormat = null; // --report <fmt>; "md" or "html"
let key = process.env.X402_TEST_KEY || null;
let solanaKey = process.env.X402_SOLANA_TEST_KEY || null;
let mockPort = 4021;
let endpointPort = 4022;
let rpcUrl; // undefined = the requirement's cluster RPC; --rpc overrides
let blockhash = null; // --blockhash pins it (skips the RPC fetch)
let decimals; // --decimals overrides the mint decimals (default: extra.decimals, then known mints, then 6)
let retries = 0; // --retries <n>: retries after the first attempt (0 = single attempt)
let timeoutMs = 15000; // --timeout <ms>: per-attempt timeout, in milliseconds
let probes = DEFAULT_PROBES; // --probes <n>: benchmark probes (default: 10)
let burst = DEFAULT_BURST; // --burst <n>: rate-limit burst size (default: 20)
let schemaArg = null; // --schema <path-or-JSON>: documented shape for a paid response
let ci = false; // --ci: CI mode — annotations on stderr, warnings fail the run
let configPath = null; // --config <path>; null = auto-discover x402-tester.json upward
let fixtureName = null; // --fixture <name>: check a bundled example fixture offline instead of a live URL
let cliPluginPaths = []; // --plugin <file>, repeatable; appended after config plugins
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
  // `--probes N` / `--probes=N`: how many sequential handshake probes
  // the benchmark command runs (1–100; see benchmark.js).
  if (flags[i] === "--probes" && flags[i + 1]) { probes = Number(flags[i + 1]); setFlags.add("probes"); }
  const pr = flags[i].match(/^--probes=(.+)$/);
  if (pr) { probes = Number(pr[1]); setFlags.add("probes"); }
  // `--burst N` / `--burst=N`: how many rapid requests the
  // rate-limit probe fires (1–100; see ratelimit.js).
  if (flags[i] === "--burst" && flags[i + 1]) { burst = Number(flags[i + 1]); setFlags.add("burst"); }
  const bu = flags[i].match(/^--burst=(.+)$/);
  if (bu) { burst = Number(bu[1]); setFlags.add("burst"); }
  // `--schema <path-or-JSON>` / `--schema=<...>`: the documented shape
  // a paid response must match. A path to a JSON schema file, or the
  // schema itself as inline JSON. Used by `e2e` (validates the live
  // paid response) and `schema` (validates a saved response file).
  if (flags[i] === "--schema" && flags[i + 1]) { schemaArg = flags[i + 1]; setFlags.add("schema"); }
  const sc = flags[i].match(/^--schema=(.+)$/);
  if (sc) { schemaArg = sc[1]; setFlags.add("schema"); }
  // `--json` switches report commands (check, batch, compare, pay, e2e,
  // replay, benchmark, ratelimit, facilitator, x402scan, bazaar, fixtures, schema) to machine-readable
  // JSON output instead of human text
  if (flags[i] === "--json") { json = true; setFlags.add("json"); }
  // `--ci` enables CI mode for report commands (check, batch, compare,
  // benchmark, ratelimit, e2e, replay, schema, facilitator, x402scan, bazaar): failures
  // and warnings are emitted as GitHub Actions annotations on stderr
  // (so --json stdout stays parseable), and any warning fails the run
  // even when the check itself passed. See ci.js.
  if (flags[i] === "--ci") { ci = true; setFlags.add("ci"); }
  // `--report md|html` renders the same reports as Markdown or HTML
  // instead of human text; `--report=<fmt>` form also works
  if (flags[i] === "--report" && flags[i + 1]) { reportFormat = flags[i + 1]; setFlags.add("report"); }
  const rf = flags[i].match(/^--report=(.+)$/);
  if (rf) { reportFormat = rf[1]; setFlags.add("report"); }
  // `--config <path>` pins the config file; without it, x402-tester.json
  // is auto-discovered upward from the working directory.
  if (flags[i] === "--config" && flags[i + 1]) configPath = flags[i + 1];
  const cf = flags[i].match(/^--config=(.+)$/);
  if (cf) configPath = cf[1];
  // `--fixture <name>` / `--fixture=<name>`: run `check` against a
  // bundled example fixture's recorded 402 response instead of a live
  // URL (see fixtures.js). No network request is made.
  if (flags[i] === "--fixture" && flags[i + 1]) { fixtureName = flags[i + 1]; setFlags.add("fixture"); }
  const fx = flags[i].match(/^--fixture=(.+)$/);
  if (fx) { fixtureName = fx[1]; setFlags.add("fixture"); }
  // `--plugin <file>` / `--plugin=<file>`, repeatable: a user-supplied
  // check that runs after a passing handshake (see plugins.js).
  // Config plugins run first, CLI plugins after, in listed order.
  if (flags[i] === "--plugin" && flags[i + 1]) cliPluginPaths.push(flags[i + 1]);
  const pl = flags[i].match(/^--plugin=(.+)$/);
  if (pl) cliPluginPaths.push(pl[1]);
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
if (!setFlags.has("probes") && config.probes !== undefined) probes = config.probes;
if (!setFlags.has("burst") && config.burst !== undefined) burst = config.burst;
if (!setFlags.has("ci") && config.ci !== undefined) ci = config.ci;
// Effective plugins: config entries first, then CLI flags, in order.
// A path listed twice runs once (loadPlugins dedupes by resolved path).
const pluginPaths = [...(config.plugins || []), ...cliPluginPaths];

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
if (!Number.isInteger(probes) || probes < 1 || probes > MAX_PROBES) {
  console.error(`error: --probes must be an integer between 1 and ${MAX_PROBES}`);
  process.exit(1);
}
if (!Number.isInteger(burst) || burst < 1 || burst > MAX_BURST) {
  console.error(`error: --burst must be an integer between 1 and ${MAX_BURST}`);
  process.exit(1);
}

// `--report` knows "md" and "html", and conflicts with `--json` —
// fail on bad flags before any command runs, not mid-report.
if (reportFormat !== null && reportFormat !== "md" && reportFormat !== "html") {
  console.error(`error: unknown --report format '${reportFormat}' (supported: md, html)`);
  process.exit(1);
}
if (json && reportFormat !== null) {
  console.error(`error: --json and --report ${reportFormat} cannot be combined`);
  process.exit(1);
}

function emit(report, formatFn, title) {
  console.log(
    renderReport(report, formatFn, {
      json,
      markdown: reportFormat === "md",
      html: reportFormat === "html",
      title,
    })
  );
}

/**
 * Settle a report command's exit code. Without --ci this is the plain
 * pass/fail verdict; with --ci the report's annotations go to stderr
 * first and the strict code from ci.js applies, so a passing report
 * carrying warnings still fails the run. `passed` is the command's own
 * verdict for the non-CI path; the CI path re-derives it from the
 * report so the two can never disagree.
 */
function settle(report, passed, command) {
  if (ci) emitCiAnnotations(report, { command });
  process.exitCode = ci ? ciExitCode(report, { ci: true }) : (passed ? 0 : 1);
}

/**
 * Resolve a --schema argument: a path to a JSON schema file if it
 * reads as one, otherwise the schema itself as inline JSON. A file
 * that exists but is not valid JSON is an error, not a fallback —
 * silently reinterpreting a broken file as inline JSON would hide
 * the real problem.
 */
async function loadSchemaArg(arg) {
  try {
    const text = await readFile(arg, "utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`schema file '${arg}' is not valid JSON`);
    }
  } catch (err) {
    if (err.message.startsWith("schema file")) throw err;
    try {
      return JSON.parse(arg);
    } catch {
      throw new Error(
        `--schema must be a path to a JSON schema file or inline JSON ` +
          `(could not read '${arg}' as a file or parse it as JSON)`
      );
    }
  }
}

/**
 * Flags that take a following value (so the next token is their value,
 * not a positional argument). Used by `compare`, the only command
 * taking two URLs, to find its second URL among the flags: a token
 * starting with "-" is a flag, and the token after a value flag is
 * that flag's value. `--flag=value` forms carry their value inline
 * and never consume the next token.
 */
  const VALUE_FLAGS = new Set([
  "--method", "-m", "--key", "--port", "--endpoint-port", "--rpc",
  "--blockhash", "--decimals", "--retries", "--timeout", "--probes",
  "--burst", "--schema", "--config", "--plugin", "--report", "--fixture",
]);

function positionalArgs(flagList) {
  const positionals = [];
  for (let i = 0; i < flagList.length; i++) {
    const tok = flagList[i];
    if (tok.startsWith("-")) {
      if (!tok.includes("=") && VALUE_FLAGS.has(tok)) i++;
      continue;
    }
    positionals.push(tok);
  }
  return positionals;
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
  x402-tester check <url> [--method <METHOD>] [--plugin <file> ...] [--json] [--report md|html]
  x402-tester check --fixture <name> [--plugin <file> ...] [--json] [--report md|html]
  x402-tester fixtures [--json] [--report md|html]
  x402-tester compare <urlA> <urlB> [--method <METHOD>] [--json] [--report md|html]
  x402-tester benchmark <url> [--probes <N>] [--method <METHOD>] [--json] [--report md|html]
  x402-tester ratelimit <url> [--burst <N>] [--method <METHOD>] [--json] [--report md|html]
  x402-tester batch <file> [--method <METHOD>] [--json] [--report md|html]
  x402-tester pay <url> [--method <METHOD>] [--key <0x...>] [--json] [--report md|html]
  x402-tester e2e [--key <0x...>] [--schema <file-or-JSON>] [--json] [--report md|html]
  x402-tester replay [--key <0x...>] [--json] [--report md|html]
  x402-tester schema <response.json> --schema <schema-file-or-JSON> [--json] [--report md|html]
  x402-tester mock [--port <n>] [--endpoint-port <n>]
  x402-tester facilitator <facilitator-url> [--json] [--report md|html]
  x402-tester x402scan <url> [--json] [--report md|html]
  x402-tester bazaar <url> [--json] [--report md|html]
  x402-tester config [--config <path>]

Options:
  --fixture      Bundled example fixture to check offline instead of a
                 live URL: a recorded 402 response from a well-known
                 public x402 endpoint (see 'x402-tester fixtures').
                 Runs the same handshake validation as a live check
                 — normalize, validate, price, price sanity — with
                 no network request and nothing signed or sent.
                 Cannot be combined with a URL.
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
  --probes       Benchmark probes (default: 10, max: 100). Probes run
                 sequentially so the numbers reflect ordinary response
                 time, not self-inflicted load; only successful
                 handshakes count toward p50/p95.
  --burst        Rate-limit burst size (default: 20, max: 100). The
                 ratelimit command fires this many rapid requests in
                 a row, with no delay between them, and reports
                 whether the endpoint 429s and whether those 429s
                 carry a parseable Retry-After. --retries is ignored
                 for ratelimit: retrying would re-ask a 429 and hide
                 the behaviour being measured.
  --schema       Documented shape a paid response must match: a path
                 to a JSON schema file, or the schema as inline JSON.
                 With e2e it validates the live paid response as an
                 extra step; with schema it validates a saved response
                 file. Supported keywords: type, required, properties,
                 additionalProperties, items, enum, const, minimum,
                 maximum, minLength, maxLength, pattern, minItems,
                 maxItems. A malformed schema fails before any check
                 runs, so a typo never reads as a pass.
  --plugin       Custom check plugin: a JS file default-exporting a
                 function or a { name, check } object (repeatable).
                 Runs after a passing handshake, with the handshake
                 report, first requirement and price as context; a
                 failing plugin fails the check, a plugin warning
                 joins the report's warnings (and fails under --ci).
                 A plugin that throws fails only itself, never the
                 whole run — but a path that cannot be loaded fails
                 before any check runs. Plugins are arbitrary code:
                 load only files you trust. Also settable as
                 "plugins": [...] in x402-tester.json (config entries
                 run first, CLI --plugin entries after).
  --port         Port for the mock facilitator (default: 4021).
  --endpoint-port
                 Port for the mock paid endpoint (default: 4022).
  --json         Machine-readable output: print the report object as
                 JSON instead of human-readable text. Works with check,
                 batch, compare, pay, e2e, replay, ratelimit, benchmark,
                 facilitator and x402scan (not mock, which
                 runs an interactive server).
  --report       Report format: --report md renders the report as
                 Markdown, --report html as a standalone HTML page,
                 instead of human-readable text (same commands
                 as --json; cannot be combined with --json).
  --ci           CI mode for report commands (check, batch, compare,
                 benchmark, ratelimit, e2e, replay, schema, facilitator, x402scan, bazaar): failures
                 and warnings are emitted as GitHub Actions annotations
                 (::error:: / ::warning::) on stderr, so --json stdout
                 stays parseable — and any warning fails the run even
                 when the check itself passed (strict exit codes).
                 Also settable as "ci": true in x402-tester.json.

Commands:
  check          Validate the 402 handshake of a paid endpoint, then
                 run any --plugin / configured custom checks against it.
                 With --fixture <name>, check a bundled example
                 fixture offline instead of a live URL.
  fixtures       List the bundled example fixtures: recorded 402
                 responses from well-known public x402 endpoints,
                 with their price and where each recording came from.
  compare        Diff the handshakes of two endpoints: run check
                 against each URL and report every payment-term field
                 that differs (price, network, asset, payee, scheme,
                 version, timeout, …). Exit 0 when both handshakes
                 are valid, even when they differ — a difference is
                 information, not a failure. Under --ci a difference
                 fails the run, so it gates staging-vs-production
                 drift in CI.
  benchmark      Probe an endpoint N times (default 10) and report
                 handshake latency: min, mean, p50, p95, max. Exit 0
                 only when every probe succeeded; partial runs still
                 report the stats from the probes that did succeed.
  ratelimit      Fire a burst of rapid requests (default 20) and
                 report whether the endpoint throttles with 429s —
                 and whether those 429s are graceful (a parseable
                 Retry-After on every one). Exit 0 when the probe
                 ran cleanly; "not rate limited" is a finding, not
                 a failure. Under --ci, ungraceful 429s and 5xx
                 responses under load fail the run.
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
                 With --schema, the paid response is also validated
                 against its documented shape as a fifth step.
  replay         Sign one payment against local mock servers, settle
                 it, then send the exact same signed payment again:
                 a protected endpoint rejects the replay (402), a
                 replayable one serves the resource twice. Exit 0
                 only when the replay is rejected. No chain, no funds.
  schema         Validate a saved paid response (JSON file) against its
                 documented shape (--schema). Exit 0 only when every
                 field matches — for CI on captured real responses.
  mock           Start a mock facilitator + mock paid endpoint on
                 localhost for manual testing (curl your own client
                 against them); stops on Ctrl-C.
  facilitator    Probe a facilitator's /verify endpoint: an empty POST
                 proves it's alive (a 4xx rejecting the probe is the
                 expected healthy answer).
  x402scan       Check whether an endpoint's host is listed on x402scan's
                 public marketplace (exit 0 = listed).
  bazaar         Check whether an endpoint's exact URL is listed in
                 Coinbase's CDP Bazaar catalog (exit 0 = listed).
                 Pages the public list endpoint until a match is found
                 or the catalog is exhausted; a scan cut short by the
                 page cap reports UNKNOWN, never NOT LISTED.
  config         Print the effective configuration: the config file
                 found (if any) and the merged settings after CLI flags
                 beat config values. Never prints keys.

Config file (x402-tester.json):
  Drop one in your project root and stop repeating flags. Any of
  method, json, ci, report ("md"), rpc, blockhash, decimals, port,
  endpointPort, retries, timeoutMs, probes, burst, endpoints (a list of
  URLs, each optionally prefixed with a method, e.g. "POST https://…"),
  and plugins (a list of custom-check plugin file paths)
  may be set. Config uses timeoutMs (milliseconds); the CLI flag is
  --timeout.
  A command run without a URL checks the first configured endpoint;
  batch run without a file checks all of them. Run
  'x402-tester config' to see what resolved. Precedence: flags >
  config file > built-in defaults.

Examples:
  x402-tester check https://example.com/paid-api
  x402-tester fixtures
  x402-tester check --fixture tbs-weather-current
  x402-tester check --fixture ax1-q-verdict --json
  x402-tester compare https://staging.example.com/paid-api https://example.com/paid-api
  x402-tester batch endpoints.txt --json | jq .failed
  x402-tester check https://example.com/paid-api --json | jq .price
  x402-tester check https://example.com/paid-api --report md > report.md
  x402-tester check https://example.com/paid-api --ci   # GitHub Actions annotations + strict exit codes
  x402-tester check https://example.com/paid-api --plugin ./only-base.mjs
  x402-tester check https://example.com/rugcheck --method POST
  x402-tester pay https://example.com/paid-api
  x402-tester pay https://example.com/solana-api --blockhash <hash>
  x402-tester e2e
  x402-tester mock
  x402-tester facilitator https://facilitator.example.com
  x402-tester x402scan https://example.com/paid-api
  x402-tester bazaar https://example.com/paid-api
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
  // A bad schema fails before any mock server starts: a typo in the
  // documented shape must never read as a passing check.
  let expectedSchema;
  if (schemaArg) {
    try {
      expectedSchema = await loadSchemaArg(schemaArg);
      assertValidSchema(expectedSchema);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  const report = await runPaidEndToEnd({ privateKey: signingKey, expectedSchema });
  emit(report, formatEndToEndReport, "Paid end-to-end test");
  settle(report, report.ok, "e2e");
}

async function runReplay() {
  const ephemeral = !key;
  const signingKey = key || generateTestKey();
  if (ephemeral) {
    console.error(
      "using a fresh throwaway test key (no funds, local only) — pass --key to use your own test key."
    );
  }
  const report = await runReplayCheck({ privateKey: signingKey });
  emit(report, formatReplayReport, "Replay protection check");
  settle(report, report.ok, "replay");
}

// Validate a saved paid response (e.g. captured from a real endpoint)
// against its documented shape, offline. Exit 0 only when it matches.
async function runSchemaCmd(file) {
  if (!schemaArg) {
    console.error("schema needs --schema <schema-file-or-JSON>");
    process.exitCode = 1;
    return;
  }
  let body;
  try {
    body = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    console.error(`cannot read response file '${file}': ${err.message}`);
    process.exitCode = 1;
    return;
  }
  let schema;
  try {
    schema = await loadSchemaArg(schemaArg);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  let validation;
  try {
    validation = validatePaidResponse(body, schema);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const report = { file, ok: validation.ok, errors: validation.errors };
  emit(report, () => formatSchemaReport(validation), "Paid response schema check");
  settle(report, validation.ok, "schema");
}

async function runBatchFromEntries(entries, invalid = []) {
  if (entries.length === 0 && invalid.length === 0) {
    console.error("no endpoints to check");
    process.exitCode = 1;
    return;
  }
  const report = await runBatch({ entries, invalid }, { retries, timeoutMs });
  emit(report, formatBatchReport, "Batch handshake check");
  settle(report, report.ok, "batch");
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
// --fixture supplies its own target, so it skips this fallback.
if (
  !url &&
  !fixtureName &&
  (cmd === "check" || cmd === "benchmark" || cmd === "ratelimit" || cmd === "pay" || cmd === "facilitator" || cmd === "x402scan" || cmd === "bazaar") &&
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
        probes,
        burst,
        ci,
        endpoints: config.endpoints ?? [],
        plugins: pluginPaths,
      },
      null,
      2
    )
  );
} else if (cmd === "fixtures" && !url) {
  // List the bundled example fixtures. --json / --report reuse the
  // same render path as every other report command.
  try {
    const fixtures = await listFixtures();
    const report = { count: fixtures.length, fixtures };
    emit(report, (r) => formatFixtureList(r.fixtures), "Example fixtures");
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
} else if (cmd === "check" && (url || fixtureName)) {
  // A fixture and a URL are two different targets — refuse to guess
  // which one the user meant.
  if (url && fixtureName) {
    console.error("error: --fixture cannot be combined with a URL — check one or the other");
    process.exitCode = 1;
  } else {
    // Load plugins before any network call: a bad plugin path fails
    // fast, instead of running a handshake whose custom checks then
    // silently never happen.
    let plugins = [];
    if (pluginPaths.length > 0) {
      try {
        plugins = await loadPlugins(pluginPaths);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exitCode = 1;
      }
    }
    if (process.exitCode !== 1) {
      let report = null;
      let formatFn = formatReport;
      if (fixtureName) {
        // Offline check: the recorded 402 body goes through the same
        // validation path as a live handshake, with no request made.
        try {
          const loaded = await loadFixture(fixtureName);
          report = checkFixture(loaded);
          formatFn = formatFixtureReport;
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exitCode = 1;
        }
      } else {
        report = await checkHandshake(url, { method, retries, timeoutMs });
      }
      if (report) {
        if (report.ok && plugins.length > 0) {
          const results = await runPlugins(plugins, {
            url: report.url,
            method: report.method,
            handshake: report,
            requirements: report.requirements,
            price: report.price,
          });
          report = applyPluginResults(report, results);
        } else if (!report.ok && plugins.length > 0) {
          // Plugins check the handshake's content, so there is nothing
          // for them to judge when the handshake itself failed.
          console.error(
            `skipping ${plugins.length} plugin check${plugins.length === 1 ? "" : "s"}: handshake failed`
          );
        }
        emit(report, formatFn, "Handshake check");
        settle(report, report.ok, "check");
      }
    }
  }
} else if (cmd === "compare") {
  // Two URLs: the first is the parsed positional, the second is the
  // first positional among the flags (flags may precede or follow it).
  const candidates = url ? [url, ...positionalArgs(flags)] : positionalArgs(flags);
  const [urlA, urlB, ...extra] = candidates;
  if (!urlA || !urlB || extra.length > 0) {
    console.error("compare needs exactly two URLs: x402-tester compare <urlA> <urlB>");
    process.exitCode = 1;
  } else {
    const report = await compareEndpoints(urlA, urlB, { method, retries, timeoutMs });
    emit(report, formatCompareReport, "Handshake comparison");
    settle(report, report.ok, "compare");
  }
} else if (cmd === "benchmark" && url) {
  const report = await runBenchmark(url, { probes, method, retries, timeoutMs });
  emit(report, formatBenchmarkReport, "Latency benchmark");
  settle(report, report.ok, "benchmark");
} else if (cmd === "ratelimit" && url) {
  // --retries is deliberately NOT passed: retrying would re-ask a
  // 429 and hide the behaviour being measured (see ratelimit.js).
  const report = await probeRateLimit(url, { burst, method, timeoutMs });
  emit(report, formatRateLimitReport, "Rate-limit probe");
  settle(report, report.ok, "ratelimit");
} else if (cmd === "batch") {
  await runBatchCmd(url);
} else if (cmd === "pay" && url) {
  await runPay(url);
} else if (cmd === "e2e" && !url) {
  await runE2E();
} else if (cmd === "replay" && !url) {
  await runReplay();
} else if (cmd === "schema" && url) {
  await runSchemaCmd(url);
} else if (cmd === "mock" && !url) {
  await runMock();
} else if (cmd === "facilitator" && url) {
  const report = await checkFacilitator(url, { retries, timeoutMs });
  emit(report, formatFacilitatorReport, "Facilitator check");
  settle(report, report.reachable, "facilitator");
} else if (cmd === "x402scan" && url) {
  const report = await checkX402scan(url, { retries, timeoutMs });
  emit(report, formatX402scanReport, "Discovery check");
  settle(report, report.listed, "x402scan");
} else if (cmd === "bazaar" && url) {
  const report = await checkBazaar(url, { retries, timeoutMs });
  emit(report, formatBazaarReport, "Discovery check");
  settle(report, report.listed, "bazaar");
} else {
  usage();
  process.exitCode = cmd ? 1 : 0;
}
