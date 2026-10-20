/**
 * Signs an x402 payment payload with viem (EVM only, local test key only).
 *
 * Flow: the tool probes an endpoint's 402 handshake, picks a payable
 * `exact`-scheme EVM requirement, and signs an EIP-712
 * TransferWithAuthorization (EIP-3009) against the asset contract. The
 * result is the JSON payment payload that clients base64-encode into the
 * `X-PAYMENT` (v1) / `PAYMENT-SIGNATURE` (v2) request header.
 *
 * Safety: signing is purely local — this module never broadcasts anything,
 * never talks to an RPC, and never moves funds. Keys come from the
 * `--key` flag, the X402_TEST_KEY env var, or a freshly generated
 * throwaway key (default). Real keys with real funds do not belong here;
 * Day 7 wires the resulting payload into a mock facilitator end-to-end.
 */

import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

/** CAIP-2 `eip155:<chainId>` → numeric chain id. Plain numeric strings work too. */
export function chainIdFromNetwork(network) {
  const raw = String(network || "").trim();
  const m = raw.match(/^eip155:(\d+)$/);
  const id = m ? Number(m[1]) : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`not an EVM network: "${network}" (expected eip155:<chainId>)`);
  }
  return id;
}

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function randomNonceHex() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (
    "0x" +
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * EIP-712 domain for the authorization signature. `extra` on the
 * requirement may carry the domain (name/version, and verifyingContract
 * for Circle Gateway entries that sign against the GatewayWallet
 * contract instead of the token contract).
 */
export function eip712Domain(requirement) {
  const extra = requirement.extra && typeof requirement.extra === "object"
    ? requirement.extra
    : {};
  return {
    name: extra.name || "USD Coin",
    version: extra.version || "2",
    chainId: chainIdFromNetwork(requirement.network),
    verifyingContract: extra.verifyingContract || requirement.asset,
  };
}

/**
 * Build the TransferWithAuthorization message fields for a requirement.
 * `nowSec` is injectable so tests can pin the validity window.
 */
export function buildAuthorization(requirement, from, { nowSec } = {}) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const value = BigInt(String(requirement.amount));
  if (value <= 0n) {
    throw new Error(`payment amount must be positive, got "${requirement.amount}"`);
  }
  const timeout = Number(requirement.maxTimeoutSeconds ?? 600);
  return {
    from,
    to: requirement.payTo,
    value,
    validAfter: BigInt(now - 30),
    validBefore: BigInt(now + timeout),
    nonce: randomNonceHex(),
  };
}

function assertSignable(requirement) {
  if (!requirement || typeof requirement !== "object") {
    throw new Error("no payment requirement to sign for");
  }
  if (requirement.scheme !== "exact") {
    throw new Error(
      `unsupported scheme "${requirement.scheme}" (only "exact" can be signed)`
    );
  }
  // throws when the network is not EVM
  chainIdFromNetwork(requirement.network);
  for (const field of ["payTo", "asset", "amount"]) {
    if (requirement[field] === undefined || requirement[field] === null || requirement[field] === "") {
      throw new Error(`payment requirement is missing "${field}"`);
    }
  }
}

/**
 * Sign a payment payload for one normalized requirement.
 * Returns { payload, signature, authorization, account, header } where
 * `header` is the base64(JSON(payload)) value to send as X-PAYMENT.
 */
export async function signPayment(requirement, privateKey, { nowSec } = {}) {
  assertSignable(requirement);
  const account = privateKeyToAccount(privateKey);
  const domain = eip712Domain(requirement);
  const authorization = buildAuthorization(requirement, account.address, { nowSec });

  const signature = await account.signTypedData({
    domain,
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const payload = {
    x402Version: requirement.version ?? 2,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };

  return {
    payload,
    signature,
    authorization,
    domain,
    account,
    header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  };
}

/** Recover the signer address from a signed payload (verification helper). */
export async function recoverPayer(signed) {
  return recoverTypedDataAddress({
    domain: signed.domain,
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: signed.authorization,
    signature: signed.signature,
  });
}

/** Decode a base64 payment header back to the payload object. */
export function decodePaymentHeader(header) {
  return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
}

/** A throwaway local test key. Zero funds, zero history — safe to sign with. */
export function generateTestKey() {
  return generatePrivateKey();
}

/**
 * Pick the first requirement this signer can handle: scheme "exact"
 * on an EVM network. Throws when nothing matches.
 */
export function pickSignableRequirement(requirements) {
  const list = Array.isArray(requirements) ? requirements : [];
  for (const req of list) {
    if (req.scheme !== "exact") continue;
    try {
      chainIdFromNetwork(req.network);
      return req;
    } catch {
      continue;
    }
  }
  throw new Error(
    "no signable payment requirement found (need scheme \"exact\" on an eip155 network)"
  );
}
