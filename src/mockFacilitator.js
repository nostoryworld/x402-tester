/**
 * Mock x402 facilitator for local end-to-end testing (no real funds).
 *
 * A real facilitator's `/verify` endpoint checks that a signed payment
 * payload is well-formed and would settle on-chain. This mock does the
 * same checks locally: it recovers the EIP-712 TransferWithAuthorization
 * signer with viem and validates the authorization against the payment
 * requirement — signature validity, amount, payee, asset, network, and
 * the validity window — without ever touching a chain.
 *
 * `POST /verify`  — x402 verify shape `{ x402Version, paymentPayload, paymentRequirements }`
 *                    → `{ isValid, invalidReason? }`
 * `POST /settle`  — verifies first, then returns a mock settlement receipt.
 *                    The `transaction` hash is fabricated (derived from the
 *                    payment nonce) and represents nothing on any chain.
 */

import { createServer } from "node:http";
import { recoverTypedDataAddress } from "viem";
import { AUTHORIZATION_TYPES, eip712Domain, chainIdFromNetwork } from "./pay.js";

/**
 * Verify one signed payment payload against the offered payment
 * requirements. Pure function — no network, no clock beyond `nowSec`.
 * Returns { isValid: true } or { isValid: false, invalidReason }.
 */
export async function verifyPaymentPayload(paymentPayload, paymentRequirements, { nowSec } = {}) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const invalid = (reason) => ({ isValid: false, invalidReason: reason });

  if (!paymentPayload || typeof paymentPayload !== "object") {
    return invalid("paymentPayload must be an object");
  }
  const inner = paymentPayload.payload;
  const auth = inner && inner.authorization;
  if (!inner || typeof inner.signature !== "string" || !auth) {
    return invalid("paymentPayload is missing signature/authorization");
  }

  // the payment must match one offered requirement by network; the asset
  // is bound through the EIP-712 domain (verifyingContract) at signature
  // recovery time below.
  const list = Array.isArray(paymentRequirements)
    ? paymentRequirements
    : [paymentRequirements];
  const req =
    list.find((r) => r && r.network === paymentPayload.network) ??
    list.find((r) => r && typeof r === "object");
  if (!req) {
    return invalid("no payment requirement offered to verify against");
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
  let chainId;
  try {
    chainId = chainIdFromNetwork(req.network);
  } catch {
    return invalid(`mock facilitator only verifies EVM payments, got network "${req.network}"`);
  }
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
      // on any chain corresponds to this transaction hash.
      if (!verdict.isValid) {
        return sendJson(res, 200, { success: false, errorReason: verdict.invalidReason });
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
