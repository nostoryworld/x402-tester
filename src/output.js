/**
 * Machine-readable report output (`--json`) and Markdown export
 * (`--report md`).
 *
 * Every command that prints a structured report (check, pay, e2e,
 * facilitator, x402scan) can emit the same report as JSON for piping
 * into jq, CI jobs, or dashboards, or as Markdown for pasting into
 * issues, PRs, or docs. The JSON shape is exactly the report object
 * the command built — nothing is added or dropped, except that
 * `undefined` fields are omitted (JSON semantics) and BigInts are
 * stringified so they never crash the encoder.
 */

import { toMarkdown } from "./markdown.js";

function bigIntSafe(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Render a report as human-readable text (default), as pretty-printed
 * JSON (when `json` is true), or as Markdown (when `markdown` is
 * true). Returns the string; the caller prints it. Combining JSON and
 * Markdown output is an error — the CLI rejects it up front, and this
 * guard covers direct API use.
 */
export function renderReport(
  report,
  formatText,
  { json = false, markdown = false, title } = {}
) {
  if (json && markdown) {
    throw new Error("cannot combine --json and --report md output");
  }
  if (json) return JSON.stringify(report, bigIntSafe, 2);
  if (markdown) return toMarkdown(report, title);
  return formatText(report);
}

/**
 * Curated JSON-safe report for a signed EVM payment (see pay.js).
 * The raw `signed` object carries the viem account and a BigInt-bearing
 * authorization, so we pick only the fields a consumer needs: the
 * payment details, the wire payload, the signature, and the ready-to-send
 * base64 payment header. No private key material is included.
 */
export function payJsonReport(url, method, signed) {
  const auth = signed.payload.payload.authorization;
  return {
    url,
    method,
    network: signed.payload.network,
    scheme: signed.payload.scheme,
    payer: auth.from,
    payTo: auth.to,
    amount: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce,
    signature: signed.signature,
    payload: signed.payload,
    header: signed.header,
  };
}

/**
 * Curated JSON-safe report for a signed Solana payment (see solana.js).
 * The raw `signed` object carries the Keypair and the full Transaction —
 * both hold the secret key — so we pick only the fields a consumer
 * needs. No private key material is included.
 */
export function solanaPayJsonReport(url, method, requirement, signed) {
  return {
    url,
    method,
    network: signed.payload.network,
    scheme: signed.payload.scheme,
    payer: signed.payer,
    payTo: requirement.payTo,
    amount: requirement.amount,
    asset: requirement.asset,
    feePayer: signed.feePayer,
    transactionSignature: signed.signature,
    payload: signed.payload,
    header: signed.header,
  };
}
