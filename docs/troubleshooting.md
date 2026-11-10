# Troubleshooting x402 handshakes

Every failure below is written against the exact output `x402-tester`
prints, so you can search this page for the error line you saw. Each
entry follows the same shape: what you saw, what it means, how to fix
it, and the command that proves the fix.

## How to read a failure

A failed `check` prints a `status: FAIL` line and an `error:` line, and
exits `1`:

```text
x402 handshake check: https://example.com/paid-api
status: FAIL (212ms, GET)
error: expected HTTP 402 Payment Required, got 200
```

- The `error:` line is the verdict — start here.
- `warning:` lines are not failures on their own (but they do fail the
  run under `--ci` — see [Warnings fail under `--ci`](#warnings-fail-under---ci)).
- Add `--json` to get the same report as machine-readable JSON
  (`error`, `status`, `attempts`, `priceSanity`), which is what to
  paste into a bug report.

## Quick reference

| Error | Most likely cause | Fix |
| --- | --- | --- |
| `expected HTTP 402 Payment Required, got 200` | Endpoint serves the resource unpaid | Wire the payment middleware onto that route |
| `expected HTTP 402 Payment Required, got 401` / `403` | Auth runs before payment | Return 402 before auth, or exempt the unpaid probe |
| `expected HTTP 402 Payment Required, got 404` | Wrong URL | Check the path; compare with the documented endpoint |
| `expected HTTP 402 Payment Required, got 405` | Wrong HTTP method | Probe with `--method POST` (or the method the endpoint expects) |
| `expected HTTP 402 Payment Required, got 429` / `502` / `503` / `504` | Transient failure | Retry with `--retries 2 --timeout 30000` |
| `402 response has an empty body` | Endpoint only describes payment on another method | Retry with `--method POST` |
| `402 response body is not valid JSON` | 402 body is HTML or plain text | Return a JSON 402 body (see [a healthy 402](#what-a-healthy-402-looks-like)) |
| `402 response contains no payment requirements` | No `accepts` (v2) / `paymentRequirements` (v1) array | Add a non-empty payment-options array |
| `first payment requirement is missing: …` | A required field is absent | Fill in the missing field (see table below) |
| `request failed: …` | DNS, refused connection, or timeout | Check the host/port; raise `--timeout`; retry |
| `price sanity: option N … dust-level price` / `whale-level price` | Decimals bug in `amount` | Fix the raw-unit amount (see [price sanity](#price-sanity-dust-and-whale-warnings)) |
| `could not determine the x402 version` | No `x402Version` and no recognised array key | Set `x402Version: 2` (or `1`) |
| `facilitator unreachable: …` | Facilitator down or unreachable | Check the facilitator URL and its `/verify` endpoint |
| `cannot sign: …` | Signing failed | Fix the handshake first, then the key (see [signing](#signing-failures-cannot-sign)) |
| `facilitator rejected it: …` | Signed payment failed `/verify` | Read the `invalidReason`; check amount, network, expiry |
| Paid request still answers 402 | Payment not accepted | Check replay, expiry, and the `X-PAYMENT` header |

## Handshake failures

### Got 200 instead of 402

```text
error: expected HTTP 402 Payment Required, got 200
```

The endpoint answered the unpaid request with the resource itself.
No x402 client can ever pay for it, because no client ever sees a
price. This is the most common failure in a new integration and it is
always server-side.

**Fix:** the payment middleware is not running for this route. Check
that it is mounted on the exact path and method you probed — a
middleware registered after the route handler, or only on `GET` when
the endpoint is `POST`, silently serves content unpaid. If the route is
deliberately free, it is not an x402 endpoint; don't point the tool
at it.

**Re-check:**

```sh
x402-tester check https://example.com/paid-api
```

### Got 401 or 403 instead of 402

```text
error: expected HTTP 402 Payment Required, got 401
```

An auth layer answered before the payment layer. An unpaid x402
client has no credentials yet, so it can never get past this to see
the price.

**Fix:** order the middleware so the payment check runs first and
returns 402 for unpaid requests. If the endpoint genuinely needs both
auth and payment, the 402 must still come first — the client pays,
then authenticates on the paid request.

### Got 404 instead of 402

```text
error: expected HTTP 402 Payment Required, got 404
```

**Fix:** the URL does not exist on that server. Double-check the path against
the endpoint's own docs, including trailing slashes and version
prefixes (`/api/v1/...`). A 404 is never a payment problem.

### Got 405 instead of 402

```text
error: expected HTTP 402 Payment Required, got 405
```

The endpoint exists but rejects the method used for the probe. Many
x402 endpoints are POST-only and answer `405` (or an empty-body 402)
to `GET`.

**Fix:** probe with the method the endpoint expects:

```sh
x402-tester check https://example.com/paid-api --method POST
```

### Got a 3xx redirect instead of 402

The unpaid request was redirected — usually to a login page, a
landing page, or the same resource under another path — instead of
being answered with a 402. A client that follows the redirect ends up
with content (or a login form) and no price.

**Fix:** the payment middleware must answer the unpaid request
directly with 402 on the requested URL, not redirect it. Redirects
belong on the paid flow, after a payment has been verified.

### Got 429, 502, 503, or 504 instead of 402

```text
error: expected HTTP 402 Payment Required, got 503
```

These are transient: rate limiting (429), a bad gateway (502), the
service being unavailable (503), or an upstream timeout (504). The
endpoint may be fine a second later — cold starts and deploys cause
exactly this.

**Fix:** retry before concluding anything:

```sh
x402-tester check https://example.com/paid-api --retries 2 --timeout 30000
```

`--retries` only retries transport failures and 429/502/503/504. A
402, a 200, or any other 4xx is a definitive answer and is never
re-asked, so retrying cannot turn a real verdict into a different
one. If the status persists across retries, the problem is the
service, not the probe: check its uptime and logs.

### Empty 402 body

```text
error: 402 response has an empty body (probed with GET). Some endpoints
only describe payment on a specific method — retry with --method POST.
```

The endpoint did return 402, but with no body, so there is nothing
to validate. This is the signature of a POST-only endpoint probed
with GET: the framework returns a bare 402 for the wrong method and
only describes payment on the right one.

**Fix:** probe with the method the endpoint expects. `check` sends an
empty JSON body (`{}`) with POST/PUT/PATCH, so a POST probe is safe
to run against a read endpoint:

```sh
x402-tester check https://example.com/paid-api --method POST
```

If the body is still empty on the right method, the server is
returning a bare 402 — it must include the payment description (see
[a healthy 402](#what-a-healthy-402-looks-like)).

### Body is not valid JSON

```text
error: 402 response body is not valid JSON
```

The 402 body is HTML (usually a framework error page), plain text,
or truncated JSON. Clients parse the 402 as JSON to find the price;
anything else is unusable.

**Fix:** confirm with `curl` what the endpoint actually returns:

```sh
curl -i https://example.com/paid-api
```

Look for `content-type: application/json` and a JSON body. Common
causes: an error page from a reverse proxy, a JSON body cut off by a
size limit, or a `text/html` 402 from a framework's default error
handler. The fix is server-side: return the payment description as
JSON with the right content type.

### No payment requirements

```text
error: 402 response contains no payment requirements (expected a
non-empty `accepts` (v2) or `paymentRequirements` (v1) array)
```

The body parsed as JSON, but it carries no payment options: neither
an `accepts` array (x402 v2) nor a `paymentRequirements` array (x402
v1), or the array is empty.

**Fix:** include one of the two arrays, non-empty. A v2 response
uses `accepts` with `amount`; a v1 response uses
`paymentRequirements` with `maxAmountRequired`. See
[a healthy 402](#what-a-healthy-402-looks-like) for a minimal
example of each shape.

### Missing fields in the first payment requirement

```text
error: first payment requirement is missing: asset, amount
```

The first payment option is missing one or more of the five fields
every client needs. Only the first option is validated — if it is
incomplete, the check fails even when a later option is fine, so put
the option you want clients to use first.

| Field | Meaning | Example |
| --- | --- | --- |
| `scheme` | Payment scheme, almost always `exact` | `"exact"` |
| `network` | Chain, as `eip155:<chainId>` (EVM) or a Solana network | `"eip155:8453"` (Base) |
| `payTo` | Address that receives the payment | `"0x…" ` |
| `asset` | Token contract address (or asset identifier) | USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `amount` | Price in raw token units, as a string | `"20000"` = 0.02 USDC (6 decimals) |

**Fix:** add the missing field(s) to the first entry of `accepts`
(or `paymentRequirements`). `maxTimeoutSeconds` is optional but
recommended — without it, clients guess how long a signed payment
stays valid (the tool's own mock flow uses 300 seconds).

### Request failed: DNS, refused, or timeout

```text
error: request failed: getaddrinfo ENOTFOUND example.com
error: request failed: connect ECONNREFUSED 127.0.0.1:3000
error: request failed: request timed out after 15000ms
```

The probe never got an HTTP answer at all.

**Fix:** read the cause after `request failed:` and act on it:

- `ENOTFOUND` / `getaddrinfo` — DNS cannot resolve the host. Check
  the spelling, and whether the host exists at all.
- `ECONNREFUSED` — nothing is listening on that host and port. The
  server is down, or the port in the URL is wrong (a local server on
  `:3000` probed at the default `:443`, for example).
- `request timed out after 15000ms` — the server accepted the
  connection but did not answer within the per-attempt timeout
  (default 15 seconds). Slow cold starts do this; raise the timeout
  and retry:

```sh
x402-tester check https://example.com/paid-api --timeout 60000 --retries 2
```

Each attempt gets its own timeout, so `--timeout 60000 --retries 2`
allows up to three 60-second attempts. The `(after N attempts)`
suffix on the error tells you retries actually ran.

## Price sanity: dust and whale warnings

```text
warning: price sanity: option 1 (0.000001 USDC) — under 0.001 USDC —
dust-level price, likely a decimals bug
warning: price sanity: option 1 (2000000 USDC) — over 1,000,000 USDC
for one call — whale-level price, likely a decimals bug
```

These are warnings, not failures — the handshake is valid — but
they almost always mean the price is wrong by orders of magnitude.
The `amount` field is in **raw token units**, not token units: for a
6-decimal token like USDC, `amount` is the price multiplied by
10⁶.

| Intended price | Correct `amount` (USDC, 6 decimals) | Wrong `amount` | What the tool reports |
| --- | --- | --- | --- |
| 0.02 USDC | `"20000"` | `"2"` (0.000002 USDC) | DUST |
| 0.02 USDC | `"20000"` | `"20000000000000000000"` (2×10¹³ USDC) | WHALE |
| 0.001 USDC | `"1000"` | `"1"` (0.000001 USDC) | DUST |

**Fix:** compute the raw amount as `price × 10^decimals` and check
it against the asset's real decimals — USDC and USDT use 6, most
other ERC-20s use 18. A price that looks right in token units and
wrong in raw units is a decimals bug, not a pricing decision. Real
examples from the bundled fixtures: TBS Weather charges 0.001 USDC
as `amount: "1000"`, AX1 charges 0.02 USDC as `amount: "20000"`.

## Other warnings

### Could not determine the x402 version

```text
warning: could not determine the x402 version from the response;
treated generically
```

The body has a usable payment-options array, but no `x402Version`
field, so the tool cannot tell v1 from v2 and treats the response
generically. **Fix:** set `x402Version: 2` (or `1`) at the top level
of the 402 body. The check passes either way; the field just removes
the ambiguity for every client, not only this tool.

### Multiple payment options offered

```text
warning: 3 payment options offered; validated the first
```

The endpoint offers several ways to pay and only the first was
validated.

**Fix:** none needed — this is informational. Just make sure the first
option is the one you want clients to take, because that is the one
every client sees first.

## Beyond the handshake

### Facilitator unreachable

```text
x402 facilitator check: https://facilitator.example.com
status: UNREACHABLE (15234ms)
error: facilitator unreachable: request timed out after 15000ms
```

The facilitator's `/verify` endpoint never answered. Note what
counts as reachable here: **any** HTTP status — even a 4xx rejecting
the empty probe payload — proves the facilitator is up. Only a
transport failure (DNS, refused, timeout) reports unreachable.

**Fix:** check the facilitator base URL first (a trailing path or a
typo'd host is the usual cause), then the facilitator service
itself. A facilitator that answers `/verify` with 5xx is reported
reachable-but-unhealthy — up, but not usable. If your endpoint's
`accepts` entry names a facilitator, that is the URL to probe; the
handshake alone cannot tell you whether it is alive.

### Signing failures (`cannot sign:`)

```text
error: cannot sign: handshake failed — expected HTTP 402 Payment Required, got 200
error: cannot sign: bad Solana key — …
error: cannot sign: could not reach Solana RPC https://api.devnet.solana.com: …
```

`pay` signs locally and sends nothing, so a signing failure is
always about the inputs, not the chain. **Fix:** match the message
after `cannot sign:` to the cause below:

- `cannot sign: handshake failed — …` — fix the handshake first;
  there is nothing to sign for. Run `check` against the same URL and
  work through its error.
- `not an EVM network: "…"` — the requirement's `network` is not an
  `eip155:<chainId>` network, so EVM signing does not apply. Solana
  endpoints (network `solana:devnet`, etc.) are signed with the
  Solana flow instead.
- `payment amount must be positive` — the requirement's `amount` is
  zero or negative; a zero-price endpoint needs no payment.
- Bad key — EVM keys must be `0x` followed by 64 hex characters
  (`--key 0x…` or `X402_TEST_KEY`); Solana keys must be a base58
  secret key or a JSON byte array (`--key …` or
  `X402_SOLANA_TEST_KEY`). Never use a key holding real funds — the
  tool signs with a throwaway test key when no key is given.
- `could not reach Solana RPC …` — the RPC endpoint is down or the
  URL is wrong; pass a working one with `--rpc`. A stale blockhash
  fails the same way: a fresh one is fetched automatically, or pin
  one with `--blockhash`.

### Paid request still answers 402

The handshake passes, the payment signs, but the paid request comes
back 402. **Fix:** work through the paid flow with `e2e` against the
local mocks first — if that passes, the problem is in the real
endpoint or facilitator, not the flow:

- `expected 402 with accepts, got HTTP <status>` — the `e2e`
  handshake step failed the same way a `check` would; work through
  the matching entry under [Handshake failures](#handshake-failures).
- `expected HTTP 200 with the resource, got HTTP <status>` — the
  paid request itself failed (or the endpoint answered something
  other than the resource). Check the status: a 402 here means the
  payment was not accepted (see the replay/expiry points below), a
  4xx/5xx means the endpoint errored on the paid call.
- `facilitator rejected it: <invalidReason>` — `/verify` said no.
  Read the `invalidReason`: a wrong amount or asset, the wrong
  network, or an expired payment (`maxTimeoutSeconds` elapsed
  between signing and the paid request) are the usual causes.
- `endpoint served the resource again for the same signed payment
  (HTTP 200) — one authorization bought the resource twice` — the
  endpoint has no replay protection. The same signed payment must
  only settle once; track settled payments (by nonce or signature)
  and reject repeats with a 4xx.
- `replay attempt answered HTTP 5xx — not a clean rejection, so protection cannot be confirmed` — the endpoint errored instead of
  rejecting the replay; a 4xx is the expected answer for a reused
  payment.
- The `X-PAYMENT` header must carry the exact signed payload the
  facilitator verified — re-encoding it, or sending it on a different
  URL or method than the one signed for, breaks verification.

### Paid response does not match its schema

```text
error: $.items[1].price: expected number, got string
```

With `--schema`, the paid response is validated against its
documented shape and failures name the exact field (`$.items[1].price`).
**Fix:** align the response with the schema, or the schema with the
response — one of them is stale. Validate a saved response offline
first, without hitting the endpoint again:

```sh
x402-tester schema paid-response.json --schema response-schema.json
```

### Warnings fail under `--ci`

Under `--ci`, a check that passes with warnings exits `1` instead of
`0`, and failures and warnings are emitted as GitHub Actions
annotations (`::error::` / `::warning::`) on stderr. So a
dust/whale price warning, a missing `x402Version`, or a plugin
warning that is harmless locally fails the CI gate. That is the
point: in CI, warnings are defects. **Fix:** fix the warning or, if
it is genuinely acceptable, don't run that check under `--ci`.

### Plugin and config errors

- `error: cannot load plugin …` (or a plugin path error before any
  check runs) — the `--plugin` path is wrong or the file does not
  default-export a check function. **Fix:** check the path and the
  export shape. A plugin path that cannot be loaded fails before any
  check runs, so a typo never silently skips your custom checks.
- A plugin that throws or returns a bad shape fails only itself,
  never the whole run — the report names the plugin.
- Config file problems: run `x402-tester config` to see the resolved
  settings and which file they came from. A config file that exists
  but is not valid JSON is an error, not a silent fallback. CLI flags
  beat the config file, which beats built-in defaults.

### Discovery checks report UNKNOWN

`x402scan` and `bazaar` can report UNKNOWN when the catalog cannot
be fully scanned (network error or timeout mid-scan). **Fix:**
re-run the check — that is not a verdict on the endpoint. An
endpoint that is genuinely unlisted reports a clean "not listed"
instead.

## What a healthy 402 looks like

A minimal v2 response — the shape `check` validates:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "20000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x0000000000000000000000000000000000000000",
      "maxTimeoutSeconds": 300
    }
  ]
}
```

The v1 equivalent uses `paymentRequirements` with `maxAmountRequired`
instead of `amount`:

```json
{
  "x402Version": 1,
  "paymentRequirements": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "20000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x0000000000000000000000000000000000000000",
      "maxTimeoutSeconds": 300
    }
  ]
}
```

Compare against a known-good response before debugging your own:

```sh
x402-tester check --fixture tbs-weather-current
x402-tester check --fixture ax1-q-verdict --json
```

And reproduce the raw 402 exactly as a client sees it:

```sh
curl -i https://example.com/paid-api
curl -i -X POST -H 'content-type: application/json' -d '{}' https://example.com/paid-api
```

If the raw response looks right but `check` still fails, run the
full paid flow against the local mocks to isolate whether the fault
is in the handshake or later in the flow:

```sh
x402-tester e2e
```

Still stuck? Paste the full `check --json` output into the issue —
it carries the status, the error, the requirement, and the price
sanity verdict in one block.
