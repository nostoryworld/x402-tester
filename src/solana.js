/**
 * Solana payment support for x402 `exact`-scheme requirements (devnet-first).
 *
 * How Solana x402 payments work (per the x402 Solana exact scheme):
 * the client builds a VersionedTransaction (v0 message) that pays the
 * recipient in an SPL token — compute-budget instructions followed by a
 * TransferChecked — and signs it with the token-authority key only. The
 * fee-payer slot belongs to the facilitator (`extra.feePayer` on the
 * requirement), which co-signs and broadcasts after /verify. The payment
 * payload sent in the PAYMENT-SIGNATURE header is:
 *
 *   { x402Version, scheme: "exact", network, payload: { transaction } }
 *
 * where `transaction` is the base64-encoded serialized wire transaction
 * (message bytes + signatures).
 *
 * Safety: signing is purely local — this module never broadcasts anything.
 * Keys come from the `--key` flag (base58 secret key or JSON byte array),
 * the X402_SOLANA_TEST_KEY env var, or a freshly generated throwaway
 * keypair (default). Real keys with real funds do not belong here.
 */

import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";

/** CAIP-2 `solana:<chainId>` → cluster name. */
const SOLANA_CHAIN_IDS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "mainnet-beta",
  "EtW49hu8EwHWjc5ptVu9womQzPEz1aWw": "devnet",
  "4uhcVjyU9pJ3uomEp8PoFGei3nAtLEJd": "testnet",
};

const SOLANA_CLUSTERS = new Set(["devnet", "testnet", "mainnet-beta"]);

/** Well-known SPL mints, for decimals defaults and friendlier reports. */
export const KNOWN_MINTS = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6, cluster: "mainnet-beta" },
};

/** Default public RPC per Solana cluster (used for fresh blockhashes). */
export const CLUSTER_RPCS = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/** Default devnet RPC used to fetch a fresh blockhash when none is given. */
export const DEFAULT_DEVNET_RPC = CLUSTER_RPCS.devnet;

/** Public RPC for the requirement's cluster (blockhash source of last resort). */
export function defaultRpcForNetwork(network) {
  return CLUSTER_RPCS[parseSolanaNetwork(network)] ?? CLUSTER_RPCS.devnet;
}

/**
 * Parse a Solana network identifier into a cluster name.
 * Accepts `solana:devnet`, `solana-devnet`, and CAIP-2 `solana:<chainId>`.
 */
export function parseSolanaNetwork(network) {
  const raw = String(network || "").trim();
  const m = raw.match(/^solana:(.+)$/i);
  if (m && SOLANA_CHAIN_IDS[m[1]]) {
    return SOLANA_CHAIN_IDS[m[1]];
  }
  const named = raw.toLowerCase().replace(/^solana[:\-]/, "");
  if (SOLANA_CLUSTERS.has(named)) {
    return named;
  }
  throw new Error(
    `not a Solana network: "${network}" (expected solana:devnet, solana:testnet or solana:mainnet-beta)`
  );
}

/** True when the network identifier names a Solana cluster. */
export function isSolanaNetwork(network) {
  try {
    parseSolanaNetwork(network);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a Solana signing key: base58-encoded 64-byte secret key (the
 * format `solana-keygen` and wallet exports use), a base58 32-byte seed,
 * or a JSON array of 64 bytes. Returns a Keypair.
 */
export function parseSolanaSecretKey(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("empty Solana secret key");
  }
  if (raw.startsWith("[")) {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new Error("Solana --key JSON array is not valid JSON");
    }
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(
        "Solana --key JSON array must hold exactly 64 bytes (the secret key)"
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  let bytes;
  try {
    bytes = bs58.decode(raw);
  } catch {
    throw new Error(
      "Solana --key must be a base58 secret key or a JSON array of 64 bytes"
    );
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(
    `Solana --key decoded to ${bytes.length} bytes (expected a 64-byte secret key or a 32-byte seed)`
  );
}

/** A throwaway local test keypair. Zero funds, zero history. */
export function generateSolanaTestKeypair() {
  return Keypair.generate();
}

function assertSolanaSignable(requirement) {
  if (!requirement || typeof requirement !== "object") {
    throw new Error("no payment requirement to sign for");
  }
  if (requirement.scheme !== "exact") {
    throw new Error(
      `unsupported scheme "${requirement.scheme}" (only "exact" can be signed)`
    );
  }
  // throws when the network is not Solana
  parseSolanaNetwork(requirement.network);
  for (const field of ["payTo", "asset", "amount"]) {
    if (requirement[field] === undefined || requirement[field] === null || requirement[field] === "") {
      throw new Error(`payment requirement is missing "${field}"`);
    }
  }
  for (const field of ["payTo", "asset"]) {
    try {
      new PublicKey(requirement[field]);
    } catch {
      throw new Error(`payment requirement "${field}" is not a valid Solana address: "${requirement[field]}"`);
    }
  }
}

/** Fetch a fresh blockhash from a Solana JSON-RPC endpoint. */
export async function fetchRecentBlockhash(rpcUrl, { timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLatestBlockhash",
        params: [{ commitment: "finalized" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`could not reach Solana RPC ${rpcUrl}: ${err.message}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* fall through to the missing-hash error */
  }
  const hash = body && body.result && body.result.value && body.result.value.blockhash;
  if (typeof hash !== "string" || !hash) {
    throw new Error(
      `Solana RPC ${rpcUrl} returned no blockhash: ${JSON.stringify(body).slice(0, 120)}`
    );
  }
  return hash;
}

/**
 * Build the unsigned x402 Solana payment transaction: a v0
 * VersionedTransaction whose fee-payer slot is the facilitator
 * (`feePayer`, from the requirement's extra.feePayer or the client's own
 * key) and whose instructions are the standard x402 Solana layout —
 * setComputeUnitLimit(50_000), setComputeUnitPrice(1), then an SPL
 * TransferChecked of `amount` atomic units from the payer's associated
 * token account to the payee's.
 *
 * `createRecipientAta` adds a CreateAssociatedTokenAccount instruction
 * for the payee when their ATA may not exist yet (needs the fee payer to
 * sign it later — only meaningful when the fee payer is someone else).
 */
export async function buildSolanaPaymentTx(
  requirement,
  clientPubkey,
  {
    blockhash,
    feePayer,
    decimals,
    createRecipientAta = false,
    tokenProgramId = TOKEN_PROGRAM_ID,
  } = {}
) {
  assertSolanaSignable(requirement);
  const amount = BigInt(String(requirement.amount));
  if (amount <= 0n) {
    throw new Error(`payment amount must be positive, got "${requirement.amount}"`);
  }
  if (!blockhash) {
    throw new Error(
      "a recent blockhash is required — pass --blockhash, use --rpc to fetch one, " +
        "or rely on the requirement's extra.recentBlockhash when the endpoint provides it"
    );
  }
  const dec = Number(decimals ?? 6);
  if (!Number.isInteger(dec) || dec < 0 || dec > 255) {
    throw new Error(`token decimals must be an integer 0–255, got "${decimals}"`);
  }

  const payer = new PublicKey(clientPubkey);
  const recipient = new PublicKey(requirement.payTo);
  const mint = new PublicKey(requirement.asset);
  const feePayerKey = feePayer ? new PublicKey(feePayer) : payer;

  const sourceAta = await getAssociatedTokenAddress(mint, payer, false, tokenProgramId);
  const destAta = await getAssociatedTokenAddress(mint, recipient, false, tokenProgramId);

  // x402 Solana exact instruction layout: compute budget, then the transfer.
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ];
  if (createRecipientAta) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        feePayerKey,
        destAta,
        recipient,
        mint,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  instructions.push(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destAta,
      payer,
      amount,
      dec,
      [],
      tokenProgramId
    )
  );

  const message = new TransactionMessage({
    payerKey: feePayerKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Index of a pubkey in the transaction's static account keys. */
function accountIndex(tx, pubkey) {
  const keys = tx.message.staticAccountKeys;
  const i = keys.findIndex((k) => k.equals(pubkey));
  if (i < 0) throw new Error("pubkey is not part of the transaction");
  return i;
}

/** True when the signature slot at `index` holds a real (non-empty) signature. */
export function hasSignature(tx, index) {
  const sig = tx.signatures[index];
  return !!sig && sig.length === 64 && !sig.every((b) => b === 0);
}

/**
 * Verify one ed25519 signature slot of a VersionedTransaction against the
 * message bytes. Returns true/false (never throws on bad signatures).
 */
export function verifyTransactionSignature(tx, pubkey) {
  const i = accountIndex(tx, new PublicKey(pubkey));
  const sig = tx.signatures[i];
  if (!hasSignature(tx, i)) return false;
  return nacl.sign.detached.verify(
    tx.message.serialize(),
    sig,
    new PublicKey(pubkey).toBytes()
  );
}

/**
 * Sign a payment payload for one normalized Solana requirement.
 * The client signs as token authority only; the fee-payer slot stays
 * empty for the facilitator to co-sign (unless the fee payer IS the
 * client, in which case it is signed too).
 *
 * `secretKeyInput` is a Keypair, a base58 secret key, or a JSON byte
 * array. The blockhash resolves from `blockhash`, then the
 * requirement's extra.recentBlockhash, then `rpcUrl` (pass null to
 * never fetch; the CLI defaults to the requirement's cluster RPC).
 *
 * Returns { payload, signature, transaction, feePayer, payer, header }
 * where `header` is the base64(JSON(payload)) value for PAYMENT-SIGNATURE.
 */
export async function signSolanaPayment(
  requirement,
  secretKeyInput,
  { blockhash, feePayer, decimals, rpcUrl, createRecipientAta, timeoutMs } = {}
) {
  assertSolanaSignable(requirement);
  const keypair =
    secretKeyInput instanceof Keypair
      ? secretKeyInput
      : parseSolanaSecretKey(secretKeyInput);
  const extra = requirement.extra && typeof requirement.extra === "object"
    ? requirement.extra
    : {};

  const resolvedBlockhash =
    blockhash ??
    extra.recentBlockhash ??
    (rpcUrl ? await fetchRecentBlockhash(rpcUrl, { timeoutMs }) : null);
  const resolvedFeePayer =
    feePayer ?? extra.feePayer ?? keypair.publicKey.toBase58();
  const resolvedDecimals =
    decimals ??
    extra.decimals ??
    (KNOWN_MINTS[requirement.asset] || {}).decimals ??
    6;

  const tx = await buildSolanaPaymentTx(requirement, keypair.publicKey, {
    blockhash: resolvedBlockhash,
    feePayer: resolvedFeePayer,
    decimals: resolvedDecimals,
    createRecipientAta,
  });

  tx.sign([keypair]);

  const wire = Buffer.from(tx.serialize()).toString("base64");
  const clientIdx = accountIndex(tx, keypair.publicKey);
  const signature = bs58.encode(tx.signatures[clientIdx]);

  const payload = {
    x402Version: requirement.version ?? 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: { transaction: wire },
  };

  return {
    payload,
    signature,
    transaction: tx,
    feePayer: resolvedFeePayer,
    payer: keypair.publicKey.toBase58(),
    keypair,
    header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  };
}

/** Decode a base64 Solana payment header back to { payload, transaction }. */
export function decodeSolanaPaymentHeader(header) {
  const payload = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  const wire = payload && payload.payload && payload.payload.transaction;
  if (typeof wire !== "string") {
    throw new Error("Solana payment payload is missing payload.transaction");
  }
  return {
    payload,
    transaction: VersionedTransaction.deserialize(Buffer.from(wire, "base64")),
  };
}

/** Token program ids accepted for the TransferChecked instruction. */
export const SOLANA_TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/** Program ids allowed inside an x402 Solana payment transaction. */
const ALLOWED_PROGRAMS = new Set([
  ...SOLANA_TOKEN_PROGRAMS.map((p) => p.toBase58()),
  ComputeBudgetProgram.programId.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
]);

const TRANSFER_CHECKED_DISCRIMINATOR = 12;

/**
 * Validate a signed Solana payment transaction against the offered
 * requirement: v0 message, fee-payer slot, whitelist-only programs, a
 * TransferChecked whose mint/amount/destination match, and a valid payer
 * signature. Returns { isValid: true, signature, payer } or throws with
 * the reason. Local-only — no chain access (blockhash recency is NOT
 * checked; a live facilitator checks that against its RPC).
 */
export async function verifySolanaTransaction(tx, requirement) {
  const fail = (reason) => {
    throw new Error(reason);
  };
  if (!(tx instanceof VersionedTransaction)) fail("not a Solana VersionedTransaction");
  if (tx.message.version !== 0) fail("transaction must use a v0 message");

  const keys = tx.message.staticAccountKeys;
  const extra = requirement.extra && typeof requirement.extra === "object"
    ? requirement.extra
    : {};
  if (extra.feePayer && keys[0].toBase58() !== String(extra.feePayer)) {
    fail(`fee payer ${keys[0].toBase58()} does not match required feePayer ${extra.feePayer}`);
  }

  let mint, amount, source, dest, authority, tokenProgram;
  let found = false;
  for (const cix of tx.message.compiledInstructions) {
    const programId = keys[cix.programIdIndex];
    if (!ALLOWED_PROGRAMS.has(programId.toBase58())) {
      fail(`transaction uses unexpected program ${programId.toBase58()}`);
    }
    if (!SOLANA_TOKEN_PROGRAMS.some((p) => p.equals(programId))) continue;
    const data = Buffer.from(cix.data);
    if (data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) continue;
    if (found) fail("transaction has more than one token transfer");
    found = true;
    tokenProgram = programId;
    amount = data.readBigUInt64LE(1);
    const accounts = cix.accountKeyIndexes.map((i) => keys[i]);
    [source, mint, dest, authority] = accounts;
  }
  if (!found) fail("transaction has no SPL Token TransferChecked instruction");

  if (String(amount) !== String(requirement.amount)) {
    fail(`transfer amount ${amount} does not match required amount ${requirement.amount}`);
  }
  if (mint.toBase58() !== String(requirement.asset)) {
    fail(`transfer mint ${mint.toBase58()} does not match required asset ${requirement.asset}`);
  }
  const expectedDest = await getAssociatedTokenAddress(
    mint,
    new PublicKey(requirement.payTo),
    false,
    tokenProgram
  );
  if (!dest.equals(expectedDest)) {
    fail("transfer destination is not the payTo associated token account");
  }
  const expectedSource = await getAssociatedTokenAddress(
    mint,
    authority,
    false,
    tokenProgram
  );
  if (!source.equals(expectedSource)) {
    fail("transfer source is not the payer's associated token account");
  }

  const authIdx = keys.findIndex((k) => k.equals(authority));
  if (!hasSignature(tx, authIdx)) fail("payer signature is missing");
  const valid = nacl.sign.detached.verify(
    tx.message.serialize(),
    tx.signatures[authIdx],
    authority.toBytes()
  );
  if (!valid) fail("payer signature is invalid");

  return {
    isValid: true,
    signature: bs58.encode(tx.signatures[authIdx]),
    payer: authority.toBase58(),
  };
}
