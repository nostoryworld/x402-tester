#!/usr/bin/env node
import { checkHandshake, formatReport } from "./handshake.js";
import { checkFacilitator, formatFacilitatorReport } from "./facilitator.js";
import { checkX402scan, formatX402scanReport } from "./x402scan.js";
import {
  signPayment,
  pickSignableRequirement,
  generateTestKey,
} from "./pay.js";

const args = process.argv.slice(2);
const [cmd, url, ...flags] = args;

let method = "GET";
let key = process.env.X402_TEST_KEY || null;
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

function usage() {
  console.log(`x402-tester — dev toolkit for x402 payment endpoints

Usage:
  x402-tester check <url> [--method <METHOD>]
  x402-tester pay <url> [--method <METHOD>] [--key <0x...>]
  x402-tester facilitator <facilitator-url>
  x402-tester x402scan <url>

Options:
  --method, -m   HTTP method for the handshake probe (default: GET).
                 Some paid endpoints are POST-only and answer GET with an
                 empty 402 body — retry them with --method POST.
  --key          Private key used to sign the payment (also reads
                 X402_TEST_KEY). Omit it and a throwaway test key is
                 generated for the run — it has no funds and signs only
                 locally, so nothing can move.

Commands:
  check          Validate the 402 handshake of a paid endpoint.
  pay            Sign an x402 payment payload for an endpoint (EVM,
                 exact-scheme requirements only). Signs locally and prints
                 the payload + base64 X-PAYMENT header; sends nothing.
  facilitator    Probe a facilitator's /verify endpoint: an empty POST
                 proves it's alive (a 4xx rejecting the probe is the
                 expected healthy answer).
  x402scan       Check whether an endpoint's host is listed on x402scan's
                 public marketplace (exit 0 = listed).

Examples:
  x402-tester check https://example.com/paid-api
  x402-tester check https://example.com/rugcheck --method POST
  x402-tester pay https://example.com/paid-api
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
  const ephemeral = !key;
  const signingKey = key || generateTestKey();
  if (ephemeral) {
    console.error(
      "warning: no --key given — signing with a fresh throwaway test key (no funds, local only)."
    );
  }
  try {
    const signed = await signPayment(requirement, signingKey);
    console.log(formatPayReport(signed));
  } catch (err) {
    console.error(`cannot sign: ${err.message}`);
    process.exitCode = 1;
  }
}

if (cmd === "check" && url) {
  const report = await checkHandshake(url, { method });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} else if (cmd === "pay" && url) {
  await runPay(url);
} else if (cmd === "facilitator" && url) {
  const report = await checkFacilitator(url);
  console.log(formatFacilitatorReport(report));
  process.exitCode = report.reachable ? 0 : 1;
} else if (cmd === "x402scan" && url) {
  const report = await checkX402scan(url);
  console.log(formatX402scanReport(report));
  process.exitCode = report.listed ? 0 : 1;
} else {
  usage();
  process.exitCode = cmd ? 1 : 0;
}
