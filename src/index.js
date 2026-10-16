#!/usr/bin/env node
import { checkHandshake, formatReport } from "./handshake.js";

const [, , cmd, url] = process.argv;

function usage() {
  console.log(`x402-tester — dev toolkit for x402 payment endpoints

Usage:
  x402-tester check <url>    Validate the 402 handshake of a paid endpoint

Examples:
  x402-tester check https://example.com/paid-api
`);
}

if (cmd === "check" && url) {
  const report = await checkHandshake(url);
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} else {
  usage();
  process.exitCode = cmd ? 1 : 0;
}
