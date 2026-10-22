/**
 * Mock x402 facilitator for local end-to-end testing (no real funds).
 *
 * A real facilitator's `/verify` endpoint checks that a signed payment
 * payload is well-formed and would settle on-chain. This mock does the
 * same checks locally, for both supported payment families:
 *
 * - EVM: recovers the EIP-712 TransferWithAuthorization signer with
 *   viem and validates the authorization against the payment
 *   requirement — signature validity, amount, payee, asset, network,
 *   and the validity window.
 * - Solana: deserializes the base64 wire VersionedTransaction from the
 *   payload and validates the x402 exact-scheme layout — v0 message,
 *   fee-payer slot, program whitelist, a TransferChecked whose
 *   mint/amount/destination match the requirement, and a valid payer
 *   signature. Blockhash recency is NOT checked (needs an RPC); a live
 *   facilitator checks that.
 *
 * Nothing ever touches a chain.
 *
 * `POST /verify`  — x402 verify shape `{ x402Version, paymentPayload, paymentRequirements }`
 *                    → `{ isValid, invalidReason? }`
 * `POST /settle`  — verifies first, then returns a mock settlement receipt.
 *                    EVM transaction hashes are fabricated (derived from
 *                    the payment nonce); Solana receipts echo the
 *                    transaction's real signature, which represents
 *                    nothing on any chain until a facilitator broadcasts it.
 */

import { createServer } from "node:http";
import { recoverTypedDataAddress } from "viem";
import { AUTHORIZATION_TYPES, eip712Domain, chainIdFromNetwork } from "./pay.js";
import {
  isSolanaNetwork,
  verifySolanaTransaction,
} from "./solana.js";
import { VersionedTransaction } from "@solana/web3.js";

/**
 * Verify one signed payment payload against the offered payment
 * requirements, dispatching to the EVM or Solana verifier by the
 * requirement's network family. Pure function — no network, no clock
 * beyond `nowSec`.
 * Returns { isValid: true } or { isValid: false, invalidReason }.
 */
export async function verifyPaymentPayload(paymentPayload, paymentRequirements, { nowSec } = {}) {
  const invalid = (reason) => ({ isValid: false, invalidReason: reason });

  if (!paymentPayload || typeof paymentPayload !== "object") {
    return invalid("paymentPayload must be an object");
  }

  const list = Array.isArray(paymentRequirements)
    ? paymentRequirements
    : [paymentRequirements];
  // the payment must match one offered requirement by network
  const req =
    list.find((r) => r && r.network === paymentPayload.network) ??
    list.find((r) => r && typeof r === "object");
  if (!req) {
    return invalid("no payment requirement offered to verify against");
  }

  if (isSolanaNetwork(req.network)) {
    return verifySolanaPayload(paymentPayload, req);
  }
  try {
    chainIdFromNetwork(req.network);
  } catch {
    return invalid(
      `unsupported network "${req.network}" (mock verifies eip155 and solana networks only)`
    );
  }
  return verifyEvmPayload(paymentPayload, req, { nowSec });
}

/**
 * Verify one signed Solana payment payload: the inner payload must
 * carry a base64 wire transaction, which is validated against the
 * requirement (see verifySolanaTransaction in solana.js).
 */
async function verifySolanaPayload(paymentPayload, req) {
  const invalid = (reason) => ({ isValid: false, invalidReason: reason });
  const inner = paymentPayload.payload;
  const b64 =
    inner && typeof inner.transaction === "string" ? inner.transaction : null;
  if (!b64) {
    return invalid(
      "paymentPayload is missing payload.transaction (the Solana exact scheme wants a base64 wire transaction)"
    );
  }
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  } catch {
    return invalid("payload.transaction is not a valid serialized Solana transaction");
  }
  try {
    const { signature, payer } = await verifySolanaTransaction(tx, req);
    return { isValid: true, signature, payer, solana: true };
  } catch (err) {
    return invalid(err.message);
  }
}

/**
 * Verify one signed EVM payment payload: recover the EIP-712
 * TransferWithAuthorization signer and validate the authorization
 * against the requirement — signature validity, amount, payee, asset,
 * network, and the validity window. The asset is bound through the
 * EIP-712 domain (verifyingContract) at signature recovery time.
 */
async function verifyEvmPayload(paymentPayload, req, { nowSec } = {}) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const invalid = (reason) => ({ isValid: false, invalidReason: reason });

  const inner = paymentPayload.payload;
  const auth = inner && inner.authorization;
  if (!inner || typeof inner.signature !== "string" || !auth) {
    return invalid("paymentPayload is missing signature/authorization");
  }

  for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) {
    if (auth[field] === undefined || auth[field] === null || auth[field] === "") {
      return invalid(`authorization is missing "${field}"`);
    }
  }

  if (String(auth.value) !== String(req.amount)) {
    return invalid(
      `authorization value ${auth.value} does not match required amount ${req.amount}`
    );
  }
  if (String(auth.to).toLowerCase() !== String(req.payTo).toLowerCase()) {
    return invalid(
      `authorization payee ${auth.to} does not match required payTo ${req.payTo}`
    );
  }
  const chainId = chainIdFromNetwork(req.network);
  if (chainIdFromNetwork(paymentPayload.network) !== chainId) {
    return invalid("payment network does not match the offered requirement");
  }

  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  if (BigInt(now) < validAfter) {
    return invalid("authorization is not yet valid (validAfter is in the future)");
  }
  if (BigInt(now) > validBefore) {
    return invalid("authorization has expired (validBefore is in the past)");
  }

  // recover the signer and confirm it is the claimed payer
  const domain = eip712Domain(req);
  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter,
        validBefore,
        nonce: auth.nonce,
      },
      signature: inner.signature,
    });
  } catch {
    return invalid("signature is not a valid EIP-712 TransferWithAuthorization signature");
  }
  if (recovered.toLowerCase() !== String(auth.from).toLowerCase()) {
    return invalid(
      `signature recovers to ${recovered}, not the claimed payer ${auth.from}`
    );
  }

  return { isValid: true };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`request body is not valid JSON: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Start a mock facilitator on 127.0.0.1. Options:
 *   port          — bind port (0 = ephemeral)
 *   nowSec        — pin the verification clock (tests)
 *   alwaysReject  — every /verify fails (tests the unhappy path)
 * Returns { url, close() }.
 */
export async function startMockFacilitator({ port = 0, nowSec, alwaysReject = false } = {}) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        return sendJson(res, 200, { ok: true, mock: true });
      }
      if (req.method !== "POST" || (req.url !== "/verify" && req.url !== "/settle")) {
        return sendJson(res, 404, { error: "mock facilitator: want POST /verify or POST /settle" });
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { isValid: false, invalidReason: err.message });
      }

      if (alwaysReject) {
        const reason = "mock facilitator is configured to reject every payment";
        return req.url === "/verify"
          ? sendJson(res, 200, { isValid: false, invalidReason: reason })
          : sendJson(res, 200, { success: false, errorReason: reason });
      }

      const verdict = await verifyPaymentPayload(
        body.paymentPayload,
        body.paymentRequirements,
        { nowSec }
      );

      if (req.url === "/verify") {
        return sendJson(res, 200, verdict);
      }

      // /settle — mock only: verify, then fabricate a receipt. Nothing
      // on any chain corresponds to the EVM transaction hash; Solana
      // receipts echo the payment transaction's real signature, which
      // still represents nothing until a facilitator broadcasts it.
      if (!verdict.isValid) {
        return sendJson(res, 200, { success: false, errorReason: verdict.invalidReason });
      }
      if (verdict.solana) {
        return sendJson(res, 200, {
          success: true,
          transaction: verdict.signature,
          network: body.paymentPayload.network,
          payer: verdict.payer,
          mock: true,
        });
      }
      const auth = body.paymentPayload.payload.authorization;
      return sendJson(res, 200, {
        success: true,
        transaction: `0x${String(auth.nonce).replace(/^0x/, "")}`.slice(0, 66),
        network: body.paymentPayload.network,
        payer: auth.from,
        mock: true,
      });
    } catch (err) {
      sendJson(res, 500, { isValid: false, invalidReason: `mock facilitator error: ${err.message}` });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port: boundPort } = server.address();
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
