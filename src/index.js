#!/usr/bin/env node
import { checkHandshake, formatReport } from "./handshake.js";

const args = process.argv.slice(2);
const [cmd, url, ...flags] = args;

let method = "GET";
// support `--method POST` and `--method=POST` (plus `-m` shorthand)
for (let i = 0; i < flags.length; i++) {
  if ((flags[i] === "--method" || flags[i] === "-m") && flags[i + 1]) {
    method = flags[i + 1].toUpperCase();
  }
  const m = flags[i].match(/^--?m(?:ethod)?=(.+)$/i);
  if (m) method = m[1].toUpperCase();
}

function usage() {
  console.log(`x402-tester — dev toolkit for x402 payment endpoints

Usage:
  x402-tester check <url> [--method <METHOD>]

Options:
  --method, -m   HTTP method for the handshake probe (default: GET).
                 Some paid endpoints are POST-only and answer GET with an
                 empty 402 body — retry them with --method POST.

Examples:
  x402-tester check https://example.com/paid-api
  x402-tester check https://example.com/rugcheck --method POST
`);
}

if (cmd === "check" && url) {
  const report = await checkHandshake(url, { method });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} else {
  usage();
  process.exitCode = cmd ? 1 : 0;
}
