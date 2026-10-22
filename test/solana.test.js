import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  parseSolanaNetwork,
  isSolanaNetwork,
  parseSolanaSecretKey,
  generateSolanaTestKeypair,
  buildSolanaPaymentTx,
  signSolanaPayment,
  decodeSolanaPaymentHeader,
  verifySolanaTransaction,
  verifyTransactionSignature,
  defaultRpcForNetwork,
  fetchRecentBlockhash,
} from "../src/solana.js";
import {
  verifyPaymentPayload,
  startMockFacilitator,
} from "../src/mockFacilitator.js";
import { normalizeRequirement } from "../src/requirements.js";

// Deterministic fixtures — throwaway keys, no funds, no history.
const seed = (start) =>
  Uint8Array.from({ length: 32 }, (_, i) => (start + i) % 256);
const PAYER = Keypair.fromSeed(seed(1));
const FEEPAYER = Keypair.fromSeed(seed(101));
const RECIPIENT = Keypair.fromSeed(seed(201)).publicKey;
// Deterministic fixture mint (a test-only SPL mint — stands in for any devnet token).
const MINT = bs58.encode(seed(77));
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8B91K9zXhNf8dKQeRZJg8xX"; // fixed fixture (never fetched)
const BLOCKHASH_2 = bs58.encode(seed(55)); // second fixed fixture, guaranteed 32 bytes

const SOL_RAW = {
  scheme: "exact",
  network: "solana:devnet",
  payTo: RECIPIENT.toBase58(),
  asset: MINT,
  amount: "2500",
  maxTimeoutSeconds: 300,
  extra: { feePayer: FEEPAYER.publicKey.toBase58(), decimals: 6 },
  version: 1,
};
const SOL_REQ = normalizeRequirement(SOL_RAW, 1);

async function signedSolana(req = SOL_REQ, opts = {}) {
  return signSolanaPayment(req, PAYER, {
    blockhash: BLOCKHASH,
    ...opts,
  });
}

describe("parseSolanaNetwork", () => {
  it("parses named and dashed Solana networks", () => {
    assert.equal(parseSolanaNetwork("solana:devnet"), "devnet");
    assert.equal(parseSolanaNetwork("solana-devnet"), "devnet");
    assert.equal(parseSolanaNetwork("solana:mainnet-beta"), "mainnet-beta");
    assert.equal(parseSolanaNetwork("solana-mainnet-beta"), "mainnet-beta");
    assert.equal(parseSolanaNetwork("solana:testnet"), "testnet");
  });
  it("parses CAIP-2 chain ids", () => {
    assert.equal(
      parseSolanaNetwork("solana:EtW49hu8EwHWjc5ptVu9womQzPEz1aWw"),
      "devnet"
    );
    assert.equal(
      parseSolanaNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
      "mainnet-beta"
    );
  });
  it("rejects non-Solana networks", () => {
    assert.throws(() => parseSolanaNetwork("eip155:8453"), /not a Solana network/);
    assert.throws(() => parseSolanaNetwork("solana:mainnet"), /not a Solana network/);
    assert.throws(() => parseSolanaNetwork(""), /not a Solana network/);
  });
  it("isSolanaNetwork is a boolean probe", () => {
    assert.equal(isSolanaNetwork("solana:devnet"), true);
    assert.equal(isSolanaNetwork("solana-devnet"), true);
    assert.equal(isSolanaNetwork("eip155:8453"), false);
  });
});

describe("parseSolanaSecretKey", () => {
  it("accepts a base58 64-byte secret key", () => {
    const kp = parseSolanaSecretKey(bs58.encode(PAYER.secretKey));
    assert.ok(kp.publicKey.equals(PAYER.publicKey));
  });
  it("accepts a JSON array of 64 bytes", () => {
    const kp = parseSolanaSecretKey(JSON.stringify([...PAYER.secretKey]));
    assert.ok(kp.publicKey.equals(PAYER.publicKey));
  });
  it("accepts a base58 32-byte seed", () => {
    const s = seed(1);
    const kp = parseSolanaSecretKey(bs58.encode(s));
    assert.ok(kp.publicKey.equals(PAYER.publicKey));
  });
  it("rejects garbage, short keys, and empty input", () => {
    assert.throws(() => parseSolanaSecretKey(""), /empty Solana secret key/);
    assert.throws(() => parseSolanaSecretKey("0xdeadbeef"), /base58 secret key/);
    assert.throws(
      () => parseSolanaSecretKey(bs58.encode(new Uint8Array(5))),
      /decoded to 5 bytes/
    );
    assert.throws(
      () => parseSolanaSecretKey(JSON.stringify([1, 2, 3])),
      /exactly 64 bytes/
    );
  });
});

describe("generateSolanaTestKeypair", () => {
  it("produces a fresh keypair each call", () => {
    const a = generateSolanaTestKeypair();
    const b = generateSolanaTestKeypair();
    assert.ok(!a.publicKey.equals(b.publicKey));
    assert.equal(a.secretKey.length, 64);
  });
});

describe("buildSolanaPaymentTx", () => {
  it("builds the x402 Solana instruction layout with the right parties", async () => {
    const tx = await buildSolanaPaymentTx(SOL_REQ, PAYER.publicKey, {
      blockhash: BLOCKHASH,
      feePayer: FEEPAYER.publicKey.toBase58(),
      decimals: 6,
    });
    assert.equal(tx.message.version, 0);
    assert.equal(tx.message.recentBlockhash, BLOCKHASH);
    assert.ok(tx.message.staticAccountKeys[0].equals(FEEPAYER.publicKey));

    const ixs = tx.message.compiledInstructions;
    const keys = tx.message.staticAccountKeys;
    assert.equal(ixs.length, 3);

    // [0] setComputeUnitLimit(50_000)
    assert.ok(keys[ixs[0].programIdIndex].equals(ComputeBudgetProgram.programId));
    const limit = Buffer.from(ixs[0].data);
    assert.equal(limit[0], 2);
    assert.equal(limit.readUInt32LE(1), 50_000);
    // [1] setComputeUnitPrice(1)
    assert.ok(keys[ixs[1].programIdIndex].equals(ComputeBudgetProgram.programId));
    const price = Buffer.from(ixs[1].data);
    assert.equal(price[0], 3);
    assert.equal(Number(price.readBigUInt64LE(1)), 1);
    // [2] TransferChecked: amount, mint, source/dest ATAs, payer authority
    assert.ok(keys[ixs[2].programIdIndex].equals(TOKEN_PROGRAM_ID));
    const data = Buffer.from(ixs[2].data);
    assert.equal(data[0], 12);
    assert.equal(data.readBigUInt64LE(1), 2500n);
    assert.equal(data[9], 6);
    const accounts = ixs[2].accountKeyIndexes.map((i) => keys[i]);
    const expectedSource = await getAssociatedTokenAddress(
      new PublicKey(MINT),
      PAYER.publicKey
    );
    const expectedDest = await getAssociatedTokenAddress(
      new PublicKey(MINT),
      RECIPIENT
    );
    assert.ok(accounts[0].equals(expectedSource));
    assert.ok(accounts[1].equals(new PublicKey(MINT)));
    assert.ok(accounts[2].equals(expectedDest));
    assert.ok(accounts[3].equals(PAYER.publicKey));
  });

  it("adds a recipient ATA creation instruction when asked", async () => {
    const tx = await buildSolanaPaymentTx(SOL_REQ, PAYER.publicKey, {
      blockhash: BLOCKHASH,
      feePayer: FEEPAYER.publicKey.toBase58(),
      decimals: 6,
      createRecipientAta: true,
    });
    assert.equal(tx.message.compiledInstructions.length, 4);
  });

  it("rejects a missing blockhash, zero amounts, and bad addresses", async () => {
    await assert.rejects(
      buildSolanaPaymentTx(SOL_REQ, PAYER.publicKey, { decimals: 6 }),
      /recent blockhash is required/
    );
    await assert.rejects(
      buildSolanaPaymentTx(
        { ...SOL_REQ, amount: "0" },
        PAYER.publicKey,
        { blockhash: BLOCKHASH }
      ),
      /must be positive/
    );
    await assert.rejects(
      buildSolanaPaymentTx(
        { ...SOL_REQ, payTo: "not-an-address" },
        PAYER.publicKey,
        { blockhash: BLOCKHASH }
      ),
      /not a valid Solana address/
    );
  });
});

describe("signSolanaPayment", () => {
  it("signs a payload whose client signature verifies; fee-payer slot stays empty", async () => {
    const signed = await signedSolana();
    assert.equal(signed.payload.x402Version, 1);
    assert.equal(signed.payload.scheme, "exact");
    assert.equal(signed.payload.network, "solana:devnet");
    assert.equal(signed.payer, PAYER.publicKey.toBase58());
    assert.equal(signed.feePayer, FEEPAYER.publicKey.toBase58());

    const tx = signed.transaction;
    const keys = tx.message.staticAccountKeys;
    const clientIdx = keys.findIndex((k) => k.equals(PAYER.publicKey));
    assert.ok(clientIdx > 0);
    // fee-payer slot (index 0) is empty — the facilitator co-signs later
    assert.ok(tx.signatures[0].every((b) => b === 0));
    assert.ok(verifyTransactionSignature(tx, PAYER.publicKey));
    assert.equal(signed.signature, bs58.encode(tx.signatures[clientIdx]));
  });

  it("signs the fee-payer slot too when the payer is the fee payer", async () => {
    const selfPaid = { ...SOL_REQ, extra: { feePayer: PAYER.publicKey.toBase58(), decimals: 6 } };
    const signed = await signedSolana(selfPaid);
    const keys = signed.transaction.message.staticAccountKeys;
    const payerIdx = keys.findIndex((k) => k.equals(PAYER.publicKey));
    assert.equal(payerIdx, 0);
    assert.ok(!signed.transaction.signatures[0].every((b) => b === 0));
    assert.ok(verifyTransactionSignature(signed.transaction, PAYER.publicKey));
  });

  it("round-trips through the base64 payment header", async () => {
    const signed = await signedSolana();
    const decoded = decodeSolanaPaymentHeader(signed.header);
    assert.deepEqual(decoded.payload, signed.payload);
    assert.ok(
      Buffer.from(decoded.transaction.message.serialize()).equals(
        Buffer.from(signed.transaction.message.serialize())
      )
    );
  });

  it("prefers extra.recentBlockhash over an RPC fetch", async () => {
    const req = { ...SOL_REQ, extra: { ...SOL_REQ.extra, recentBlockhash: BLOCKHASH_2 } };
    const signed = await signSolanaPayment(req, PAYER); // no blockhash, no rpcUrl
    assert.equal(signed.transaction.message.recentBlockhash, BLOCKHASH_2);
  });

  it("fails clearly when no blockhash is available and the RPC is unreachable", async () => {
    const req = { ...SOL_REQ, extra: { feePayer: FEEPAYER.publicKey.toBase58(), decimals: 6 } };
    await assert.rejects(
      signSolanaPayment(req, PAYER, { rpcUrl: "http://127.0.0.1:1/" }),
      /could not reach Solana RPC/
    );
  });

  it("rejects non-exact schemes and non-Solana networks", async () => {
    await assert.rejects(
      signedSolana({ ...SOL_REQ, scheme: "permit2" }),
      /unsupported scheme/
    );
    await assert.rejects(
      signedSolana({ ...SOL_REQ, network: "eip155:8453" }),
      /not a Solana network/
    );
  });
});

describe("verifySolanaTransaction", () => {
  it("accepts a well-formed signed payment", async () => {
    const signed = await signedSolana();
    const verdict = await verifySolanaTransaction(signed.transaction, SOL_REQ);
    assert.equal(verdict.isValid, true);
    assert.equal(verdict.payer, PAYER.publicKey.toBase58());
    assert.equal(verdict.signature, signed.signature);
  });

  it("rejects amount, mint, and destination mismatches", async () => {
    const tampered = await signSolanaPayment(
      { ...SOL_REQ, amount: "9999" },
      PAYER,
      { blockhash: BLOCKHASH }
    );
    await assert.rejects(
      verifySolanaTransaction(tampered.transaction, SOL_REQ),
      /does not match required amount/
    );
    const otherMint = await signSolanaPayment(
      { ...SOL_REQ, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      PAYER,
      { blockhash: BLOCKHASH }
    );
    await assert.rejects(
      verifySolanaTransaction(otherMint.transaction, SOL_REQ),
      /does not match required asset/
    );
  });

  it("rejects a corrupted payer signature", async () => {
    const signed = await signedSolana();
    const keys = signed.transaction.message.staticAccountKeys;
    const idx = keys.findIndex((k) => k.equals(PAYER.publicKey));
    signed.transaction.signatures[idx][0] ^= 1; // flip one signature bit
    await assert.rejects(
      verifySolanaTransaction(signed.transaction, SOL_REQ),
      /signature is invalid/
    );
  });
});

describe("decodeSolanaPaymentHeader", () => {
  it("rejects payloads without a transaction", () => {
    assert.throws(
      () => decodeSolanaPaymentHeader(Buffer.from(JSON.stringify({ nope: 1 })).toString("base64")),
      /missing payload.transaction/
    );
  });
});

describe("defaultRpcForNetwork / fetchRecentBlockhash", () => {
  it("maps clusters to their public RPC", () => {
    assert.equal(defaultRpcForNetwork("solana:devnet"), "https://api.devnet.solana.com");
    assert.equal(
      defaultRpcForNetwork("solana:mainnet-beta"),
      "https://api.mainnet-beta.solana.com"
    );
  });
  it("fetchRecentBlockhash reports unreachable RPCs", async () => {
    await assert.rejects(
      fetchRecentBlockhash("http://127.0.0.1:1/"),
      /could not reach Solana RPC/
    );
  });
});

describe("mock facilitator — Solana payments", () => {
  it("verifies a valid Solana payment payload (pure)", async () => {
    const signed = await signedSolana();
    const verdict = await verifyPaymentPayload(signed.payload, [SOL_RAW]);
    assert.equal(verdict.isValid, true);
    assert.equal(verdict.payer, PAYER.publicKey.toBase58());
    assert.equal(verdict.signature, signed.signature);
  });

  it("rejects when the requirement amount differs", async () => {
    const signed = await signedSolana();
    const verdict = await verifyPaymentPayload(signed.payload, [
      { ...SOL_RAW, amount: "1" },
    ]);
    assert.equal(verdict.isValid, false);
    assert.match(verdict.invalidReason, /does not match required amount/);
  });

  it("rejects garbage transactions", async () => {
    const verdict = await verifyPaymentPayload(
      {
        x402Version: 1,
        scheme: "exact",
        network: "solana:devnet",
        payload: { transaction: "aGVsbG8=" },
      },
      [SOL_RAW]
    );
    assert.equal(verdict.isValid, false);
    assert.match(verdict.invalidReason, /not a valid serialized Solana transaction/);
  });

  it("POST /verify and /settle accept a Solana payment over HTTP", async () => {
    const fac = await startMockFacilitator();
    try {
      const signed = await signedSolana();
      const post = async (path, body) => {
        const res = await fetch(`${fac.url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.json();
      };
      const verifyBody = await post("/verify", {
        x402Version: 1,
        paymentPayload: signed.payload,
        paymentRequirements: [SOL_RAW],
      });
      assert.equal(verifyBody.isValid, true);
      const settleBody = await post("/settle", {
        x402Version: 1,
        paymentPayload: signed.payload,
        paymentRequirements: [SOL_RAW],
      });
      assert.equal(settleBody.success, true);
      assert.equal(settleBody.transaction, signed.signature);
      assert.equal(settleBody.network, "solana:devnet");
      assert.equal(settleBody.payer, PAYER.publicKey.toBase58());
      assert.equal(settleBody.mock, true);
    } finally {
      await fac.close();
    }
  });
});
