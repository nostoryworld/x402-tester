# How x402 payments work

x402 is a protocol that turns HTTP's long-unused `402 Payment Required`
status into a working pay-per-call system. A client asks for a resource
without paying; the server answers `402` with a machine-readable price
list; the client signs a payment for exactly that price and retries the
same request with the signed payment attached; the server checks the
payment with a facilitator and serves the resource. No account, no API
key, no subscription — one signed payment buys one call.

This guide explains the flow end to end. Every claim in it is grounded
in what this tool actually does: the commands in
[Try it yourself](#try-it-yourself) run the real flow against local
mocks or the bundled fixtures, and the 402 example below is a recorded
response from a live public endpoint.

## The idea in 30 seconds

Normal web APIs authenticate you first and bill you later. x402 flips
that: the server tells you the price *before* you pay, in the HTTP
response itself, and the payment is a signed message — not a
transaction you broadcast. The client signs off-chain (free, instant),
sends the signature with the request, and a third party called the
**facilitator** verifies the signature and later moves the money
on-chain. The server never touches your wallet and never sees your
private key.

## The four actors

| Actor | Role |
| --- | --- |
| **Client** (you, or your code) | Wants the resource; holds a wallet key and signs the payment |
| **Resource server** | Owns the API; sets the price, checks payments, serves the resource |
| **Facilitator** | Trusted third party that verifies signed payments (`/verify`) and settles them on-chain (`/settle`) |
| **Chain** | Where the money actually moves, when the facilitator settles |

The client and the server never transact with each other directly.
Both of them talk to the facilitator, which is what makes the flow
trustless for the client (the server cannot invent a payment) and safe
for the server (it only serves the resource after the facilitator says
the payment is good).

## The flow, step by step

```text
Client                Resource server              Facilitator
  │  1. GET /paid-api        │                           │
  │ ───────────────────────► │                           │
  │  2. 402 + payment options│                           │
  │ ◄─────────────────────── │                           │
  │  3. sign payment (local, off-chain)                  │
  │  4. GET /paid-api + X-PAYMENT header                 │
  │ ───────────────────────► │                           │
  │                          │  5. POST /verify          │
  │                          │ ─────────────────────────►│
  │                          │  { isValid: true }        │
  │                          │ ◄─────────────────────────│
  │  6. 200 + resource       │                           │
  │ ◄─────────────────────── │                           │
  │                          │  (later) POST /settle     │
  │                          │ ─────────────────────────►│
  │                          │  { success: true, transaction: "0x…" } │
  │                          │ ◄─────────────────────────│
```

### Step 1 — the unpaid request

The client makes an ordinary request, exactly as it would to a free
endpoint. Nothing special is sent: no credentials, no wallet address,
no payment header. The server's payment middleware intercepts it
before the handler runs.

### Step 2 — the 402 answer

The server answers `402 Payment Required` with a JSON body that
describes how to pay. This is the whole contract — if this body is
wrong, no client can ever pay, which is why `x402-tester check`
validates it. Here is a real one, recorded from the X Pay UUID
generator (`examples/xpay-uuid.json`, captured 2026-11-08):

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://www.api-xpay.com/x402/uuid",
    "description": "Generate a random UUID v4",
    "mimeType": "application/json",
    "serviceName": "X Pay"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "5000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x589a2314a2E05F45e40C4823Da3Ba58D421dB3d8",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USD Coin",
        "version": "2"
      }
    }
  ]
}
```

Each field in the payment option means something concrete:

| Field | Meaning | In this example |
| --- | --- | --- |
| `scheme` | How payment works — almost always `exact` (pay exactly this amount) | `"exact"` |
| `network` | Which chain, as `eip155:<chainId>` (EVM) or a Solana network | `"eip155:8453"` — Base |
| `amount` | Price in **raw token units**, as a string — not token units | `"5000"` |
| `asset` | Token contract address (or asset identifier) | USDC on Base |
| `payTo` | Address that receives the payment | `0x589a…` |
| `maxTimeoutSeconds` | How long a signed payment stays valid | `60` seconds |

`x402Version` tells the client which shape to expect: `2` uses
`accepts` with `amount`; `1` uses `paymentRequirements` with
`maxAmountRequired`. See [v1 vs v2](#v1-vs-v2) below.

**Amounts are in raw units.** That is the single most misunderstood
part of the protocol. USDC has 6 decimals, so the price in token units
is `amount ÷ 10⁶`: `"5000"` is 0.005 USDC, `"1000"` is 0.001 USDC,
`"20000"` is 0.02 USDC. Real prices from the bundled fixtures:

| Endpoint | `amount` | Price |
| --- | --- | --- |
| TBS Weather & Climate API | `"1000"` | 0.001 USDC |
| OneSource block height | `"1000"` | 0.001 USDC |
| X Pay UUID generator | `"5000"` | 0.005 USDC |
| AX1 token verdict | `"20000"` | 0.02 USDC |

An endpoint that means 0.02 USDC but writes `"2"` is charging
0.000002 USDC; one that writes `"20000000000000000000"` is charging
2×10¹³ USDC. Both are decimals bugs, and `check` flags them as
dust/whale warnings.

A server may offer several payment options (different assets,
networks, or schemes). The client picks one — conventionally the
first — and signs for exactly that option.

### Step 3 — the client signs (off-chain, free)

The client builds a payment authorization for the chosen option and
signs it with its wallet key. Nothing is broadcast and no gas is paid:
a signature is just bytes produced locally.

On EVM chains the signature is an **EIP-712 `TransferWithAuthorization`**
(EIP-3009) — the same signed authorization the USDC contract itself
understands. Its fields:

| Field | Meaning |
| --- | --- |
| `from` | The payer's address |
| `to` | Must equal the option's `payTo` |
| `value` | Must equal the option's `amount`, in raw units |
| `validAfter` | The authorization is not valid before this time (the tool uses now − 30s, so a slightly stale clock still works) |
| `validBefore` | The authorization expires at this time: now + `maxTimeoutSeconds` |
| `nonce` | A fresh random 32-byte value — this is what makes the payment single-use |

The signature covers an EIP-712 domain naming the token (`name:
"USD Coin"`, `version: "2"`), the chain id, and the asset contract as
`verifyingContract` — so a signature made for one token, chain, or
payee cannot be replayed against another. That name and version come
from the option's `extra` field (see the example above); when an
option carries no `extra`, the tool defaults to `"USD Coin"` / `"2"`.

The validity window is short by design. For the X Pay option above,
`maxTimeoutSeconds` is 60, so a payment signed right now is valid for
90 seconds in total (30 seconds of `validAfter` slack plus 60 seconds
of timeout). That is the whole point of `maxTimeoutSeconds`: a signed
payment is a perishable ticket, not an open-ended permission. A client
that signs and then waits too long must sign again.

This is what `x402-tester pay` does — against the live X Pay endpoint,
with a throwaway test key:

```text
x402 payment signed for: https://www.api-xpay.com/x402/uuid
payer: 0x0043f76D3b37e36cA60c0b1a63E41e40eF7f41C6
payTo: 0x589a2314a2E05F45e40C4823Da3Ba58D421dB3d8
amount: 5000 atomic units (eip155:8453)
valid: 2026-11-11T08:09:37.000Z → 2026-11-11T08:11:07.000Z
nonce: 0xb2936ecd5f91aa6035d98d216df32b7ff62be76939328730078e1bf626632fd7
```

Note the `valid:` window: 90 seconds, exactly as the arithmetic above
predicts. The signature itself is a normal EIP-712 signature over
those six fields — the payee, the amount, and the window are all
inside the signed message, so none of them can be altered afterwards
without invalidating the signature.

### Step 4 — the paid request

The client repeats the original request, this time carrying the signed
payment in a header: the base64-encoded JSON payment payload.

- x402 v1: the `X-PAYMENT` header.
- x402 v2: the `PAYMENT-SIGNATURE` header.

The payload itself is small — the version, the scheme, the network,
and the signature plus the authorization it covers. The server reads
the header, decodes it, and — crucially — does **not** trust it yet.

### Step 5 — the facilitator verifies

The server sends the signed payment and the payment option it offered
to the facilitator's `POST /verify`:

```json
{
  "x402Version": 2,
  "paymentPayload": { "...": "the signed payment from the header" },
  "paymentRequirements": [ { "...": "the option the server offered" } ]
}
```

The facilitator answers `{ "isValid": true }` or
`{ "isValid": false, "invalidReason": "…" }`. It checks:

- the signature is a valid EIP-712 `TransferWithAuthorization` and
  recovers to the claimed payer;
- the amount matches the offered price exactly — not more, not less;
- the payee matches the offered `payTo`;
- the network matches the offered network;
- the current time is inside the `validAfter`/`validBefore` window;
- the payment has not already been settled (see
  [Replay protection](#replay-protection-one-payment-one-settlement)).

Only when the facilitator says the payment is valid does the server
serve the resource. If verification fails, the server answers 402
again with the reason — the client can fix the problem (wrong amount,
expired payment, wrong network) and retry with a fresh signature.

Two properties of `/verify` matter. First, verifying does **not**
spend the payment: the client may verify pre-flight and the server
verifies again, and both checks pass — only settling marks a payment
spent. Second, the facilitator is the only party that needs to
understand signatures and chains; the resource server just asks "is
this good?" and acts on the answer.

### Step 6 — serve, then settle

Once verified, the server answers `200` with the resource — the same
response the unpaid request would have received, had it been free.
Separately, the facilitator's `POST /settle` submits the signed
authorization on-chain (for EVM, the token contract's
`transferWithAuthorization`) and returns a receipt with the
transaction hash. Settlement is what actually moves the money; until
it happens, the payment is only a signed promise. The server (or the
facilitator, depending on the deployment) decides when to settle —
typically right after serving the resource.

## Replay protection: one payment, one settlement

A signed payment is just data, so it can be copied. What stops the
same signature buying the resource twice is the **nonce**. The
facilitator (and the token contract, on-chain) records each
authorization nonce once it settles, and refuses to settle the same
nonce again. A second `/verify` of an already-settled payment fails
with "payment has already been settled — this authorization was
already used (replay)".

This is a property the *server and facilitator* must enforce, not the
client — and it is testable. `x402-tester replay` signs one payment,
settles it, then sends the exact same signed payment again against
local mocks:

```text
[✓] handshake — 402 with 1 payment option(s): eip155:8453, 1000 atomic units
[✓] sign — payment signed by 0x6fDA… for 1000 atomic units (nonce 0xed30969f…)
[✓] first paid request — HTTP 200 — resource received: "Hello from the mock paid endpoint …"
[✓] settle — facilitator settled the payment (tx 0xed30969f9c57fb87…) — nonce is now spent
[✓] replay — endpoint rejected the reused payment (HTTP 402: payment rejected: payment has already been settled …)

verdict: PROTECTED — the endpoint refused to serve the same signed payment twice
```

An endpoint that serves the resource twice for one authorization has
no replay protection: every signed payment it accepts is an unlimited
free pass.

## v1 vs v2

| | x402 v1 | x402 v2 |
| --- | --- | --- |
| Payment options key | `paymentRequirements` | `accepts` |
| Price field | `maxAmountRequired` | `amount` |
| Payment header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Network format | Often a bare name (`"base"`) | `eip155:<chainId>` (e.g. `"eip155:8453"`) |

The two versions describe the same deal — same scheme, same fields,
same signing — and this tool normalizes them into one shape, so a
client (or a check) does not care which version a server speaks. If
you are building a server today, use v2.

## The Solana variant

The flow is identical; only step 3 changes. Instead of an EIP-712
authorization, the client signs a **Solana transaction** — a
versioned transaction whose instructions include an SPL
`TransferChecked` moving the exact amount of the exact mint to the
exact destination, with the client as fee payer — and sends the
base64-encoded wire transaction as the payment payload. The
facilitator validates the transaction layout (v0 message, fee-payer
slot, program whitelist, matching mint/amount/destination, valid payer
signature) and checks blockhash recency against an RPC. The
`x402-tester pay` command signs Solana endpoints the same way it signs
EVM ones, given a base58 secret key or JSON byte array.

## Who pays gas?

The client never pays gas to sign — signing happens off-chain, in the
client, for free. The on-chain transfer happens once, at settle time,
when the facilitator submits the signed authorization to the chain.
That submission is the only transaction in the whole flow, which is
why x402 works for micropayments: a $0.001 API call does not need a
$0.01 transaction from the buyer.

## What can go wrong

Almost every failure in this flow shows up first as a bad 402, a
rejected verification, or a paid request that still answers 402. Each
has a concrete cause and fix in
[docs/troubleshooting.md](troubleshooting.md) — search it for the
exact error line. The short version:

- **No 402 at all** — the payment middleware is not on that route, or
  auth runs before payment.
- **402 with no usable options** — missing `accepts` /
  `paymentRequirements`, or a required field (`scheme`, `network`,
  `payTo`, `asset`, `amount`) absent.
- **Facilitator rejects the payment** — read `invalidReason`: wrong
  amount, wrong payee, wrong network, expired window, or a replayed
  nonce.
- **Paid request still 402s** — the payment was not accepted; check
  replay, expiry, and that the header carries the exact payload the
  facilitator verified.

## Try it yourself

Everything below runs with no wallet, no funds, and (except for the
`pay` example) no network. The mock flow is the same six steps, with
a local facilitator and a local endpoint standing in for the real
ones.

See a real 402 and its price, offline:

```sh
x402-tester fixtures
x402-tester check --fixture xpay-uuid
```

```text
x402 handshake check: https://www.api-xpay.com/x402/uuid
fixture: xpay-uuid — offline check against the recorded 402 response (captured 2026-11-08) via live 402 probe
status: OK (0ms, GET)
x402 version: v2
scheme: exact | network: eip155:8453
payTo: 0x589a2314a2E05F45e40C4823Da3Ba58D421dB3d8
price: 0.005 USDC
warning: server included an error field: PAYMENT-SIGNATURE header is required
```

Sign a payment for a live endpoint (local only — nothing is sent, no
funds move):

```sh
x402-tester pay https://www.api-xpay.com/x402/uuid
```

Walk all six steps against local mocks:

```sh
x402-tester e2e
```

```text
x402 paid end-to-end test (mock facilitator — no real funds)
endpoint: http://127.0.0.1:34041
facilitator: http://127.0.0.1:41445

[✓] handshake — 402 with 1 payment option(s): eip155:8453, 1000 atomic units
[✓] sign — payment signed by 0x3AA1… for 1000 atomic units
[✓] verify — mock facilitator accepted the signed payment
[✓] paid request — HTTP 200 — resource received: "Hello from the mock paid endpoint — this response was 'paid …"

result: PASS (4/4 steps)
```

Prove replay protection holds:

```sh
x402-tester replay
```

And if you want to point your own client at a paid endpoint and a
facilitator by hand, `x402-tester mock` starts both on localhost until
you stop it with Ctrl-C.

## FAQ

**Do I need an account or an API key to use an x402 endpoint?**
No. The wallet signature *is* the credential, and it is created fresh
for each payment. There is nothing to register and no key to leak.

**Can one payment buy many calls?**
Not under the `exact` scheme: one signed authorization settles once
and buys one call. Each call needs its own signed payment. (Some
endpoints also offer a `batch-settlement` scheme that bundles several
authorizations into one settlement — the OneSource fixture lists both.)

**What happens if I sign and then never send the paid request?**
Nothing. An unsigned-on-chain authorization is inert: no funds move
until the facilitator settles it, and it expires when `validBefore`
passes. The server never sees it.

**Can a payment be refunded?**
The protocol has no refund step — once settled, the transfer is final
on-chain. A server that wants refunds must implement them itself
(a separate transfer back). Verify before you settle: that is what
`/verify` is for.

**What if the facilitator is down?**
The endpoint cannot verify payments, so paid requests fail even
though the handshake is perfect. Check the facilitator separately
before concluding the endpoint is broken:

```sh
x402-tester facilitator https://facilitator.example.com
```

Any HTTP answer — even a 4xx rejecting the empty probe — means it is
alive; only a transport failure reports unreachable.

**Is x402 only USDC on Base?**
No. USDC on Base is the most common combination today (every bundled
fixture uses it), but the protocol is asset- and chain-agnostic: any
token on any network the server offers. This tool signs EVM
(`eip155:<chainId>`) and Solana networks.

**Where is the price set, and who can change it?**
The server sets it, in the 402 body, per request. A server may change
its price at any time — but a client only ever pays the price it saw
in the 402 it signed against, because the amount is inside the signed
message.
