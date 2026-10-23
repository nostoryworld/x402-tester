#!/usr/bin/env node
import { checkHandshake, formatReport } from "./handshake.js";
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

const args = process.argv.slice(2);
let [cmd, url, ...flags] = args;

// `e2e` and `mock` take no URL — a leading flag was captured as `url`,
// so fold it back into the flags before parsing.
if ((cmd === "e2e" || cmd === "mock") && url && url.startsWith("-")) {
  flags = [url, ...flags];
  url = undefined;
}

let method = "GET";
let json = false;
let key = process.env.X402_TEST_KEY || null;
let solanaKey = process.env.X402_SOLANA_TEST_KEY || null;
let mockPort = 4021;
let endpointPort = 4022;
let rpcUrl; // undefined = the requirement's cluster RPC; --rpc overrides
let blockhash = null; // --blockhash pins it (skips the RPC fetch)
let decimals; // --decimals overrides the mint decimals (default: extra.decimals, then known mints, then 6)
// support `--method POST` and `--method=POST` (plus `-m` shorthand),
// plus `--key 0x...` / `--key=0x...` for the signing key
for (let i = 0; i < flags.length; i++) {
  if ((flags[i] === "--method" || flags[i] === "-m") && flags[i + 1]) {
    method = flags[i + 1].toUpperCase();
  }
  const m = flags[i].match(/^--?m(?:ethod)?=(.+)$/i);
  if (m) method = m[1].toUpperCase();
  if (flags[i] === "--key" && flags[i + 1]) key = flags[i + 1];
  const k = flags[i].match(/^--key=(.+)$/);
  if (k) key = k[1];
  if (flags[i] === "--port" && flags[i + 1]) mockPort = Number(flags[i + 1]);
  const p = flags[i].match(/^--port=(\d+)$/);
  if (p) mockPort = Number(p[1]);
  if (flags[i] === "--endpoint-port" && flags[i + 1]) endpointPort = Number(flags[i + 1]);
  const ep = flags[i].match(/^--endpoint-port=(\d+)$/);
  if (ep) endpointPort = Number(ep[1]);
  if (flags[i] === "--rpc" && flags[i + 1]) rpcUrl = flags[i + 1];
  const r = flags[i].match(/^--rpc=(.+)$/);
  if (r) rpcUrl = r[1];
  if (flags[i] === "--blockhash" && flags[i + 1]) blockhash = flags[i + 1];
  const b = flags[i].match(/^--blockhash=(.+)$/);
  if (b) blockhash = b[1];
  if (flags[i] === "--decimals" && flags[i + 1]) decimals = Number(flags[i + 1]);
  const d = flags[i].match(/^--decimals=(\d+)$/);
  if (d) decimals = Number(d[1]);
  // `--json` switches report commands (check, pay, e2e, facilitator,
  // x402scan) to machine-readable JSON output instead of human text
  if (flags[i] === "--json") json = true;
}

function emit(report, formatFn) {
  console.log(renderReport(report, formatFn, { json }));
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
  x402-tester check <url> [--method <METHOD>] [--json]
  x402-tester pay <url> [--method <METHOD>] [--key <0x...>] [--json]
  x402-tester e2e [--key <0x...>] [--json]
  x402-tester mock [--port <n>] [--endpoint-port <n>]
  x402-tester facilitator <facilitator-url> [--json]
  x402-tester x402scan <url> [--json]

Options:
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
  --port         Port for the mock facilitator (default: 4021).
  --endpoint-port
                 Port for the mock paid endpoint (default: 4022).
  --json         Machine-readable output: print the report object as
                 JSON instead of human-readable text. Works with check,
                 pay, e2e, facilitator and x402scan (not mock, which
                 runs an interactive server).

Commands:
  check          Validate the 402 handshake of a paid endpoint.
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

Examples:
  x402-tester check https://example.com/paid-api
  x402-tester check https://example.com/paid-api --json | jq .price
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
  const handshake = await checkHandshake(targetUrl, { method });
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
    emit(payJsonReport(url, method, signed), () => formatPayReport(signed));
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
      () => formatSolanaPayReport(signed, requirement)
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
  emit(report, formatEndToEndReport);
  process.exitCode = report.ok ? 0 : 1;
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

if (cmd === "check" && url) {
  const report = await checkHandshake(url, { method });
  emit(report, formatReport);
  process.exitCode = report.ok ? 0 : 1;
} else if (cmd === "pay" && url) {
  await runPay(url);
} else if (cmd === "e2e" && !url) {
  await runE2E();
} else if (cmd === "mock" && !url) {
  await runMock();
} else if (cmd === "facilitator" && url) {
  const report = await checkFacilitator(url);
  emit(report, formatFacilitatorReport);
  process.exitCode = report.reachable ? 0 : 1;
} else if (cmd === "x402scan" && url) {
  const report = await checkX402scan(url);
  emit(report, formatX402scanReport);
  process.exitCode = report.listed ? 0 : 1;
} else {
  usage();
  process.exitCode = cmd ? 1 : 0;
}
