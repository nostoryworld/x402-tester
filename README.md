# x402-tester

Dev toolkit for testing [x402](https://x402.org) payment endpoints. Point it at a paid API and it tells you whether the payment handshake is healthy — before you wire up a wallet.

## Why

The x402 flow starts with a handshake: you hit an endpoint unpaid, it must answer `402 Payment Required` with a machine-readable description of how to pay. When that handshake is malformed, every client integration fails in confusing ways. This tool validates the contract so endpoint developers catch mistakes early.

## Install

```sh
npm install -g x402-tester
# or run from source:
node src/index.js check <url>
```

## Usage

```sh
x402-tester check https://example.com/paid-api
# every check also runs price sanity: dust (< 0.001 token units) or
# whale (> 1,000,000 token units) prices are flagged as warnings in the
# report (and in --json as priceSanity) without failing the check.
# some endpoints are POST-only — probe them with a different method:
x402-tester check https://example.com/paid-api --method POST
# probe the facilitator behind the handshake (any answer, even a 4xx, means it's alive):
x402-tester facilitator https://facilitator.example.com
# check whether your endpoint's host shows up in x402scan's marketplace (exit 0 = listed):
x402-tester x402scan https://example.com/paid-api
# check whether your endpoint's exact URL is listed in Coinbase's CDP
# Bazaar catalog (exit 0 = listed; UNKNOWN if the catalog can't be fully scanned):
x402-tester bazaar https://example.com/paid-api
# sign an x402 payment payload for an endpoint (EVM exact-scheme via
# EIP-712, or Solana exact-scheme via a signed SPL transfer transaction).
# Signs locally with a throwaway test key — nothing is sent, no funds move:
x402-tester pay https://example.com/paid-api
# or sign with your own test key (X402_TEST_KEY also works):
x402-tester pay https://example.com/paid-api --key 0xYOUR_TEST_KEY
# Solana endpoints (network solana:devnet etc.): --key takes a base58
# secret key or JSON byte array (X402_SOLANA_TEST_KEY also works). A fresh
# devnet blockhash is fetched automatically; pin one with --blockhash:
x402-tester pay https://example.com/solana-api --blockhash <BLOCKHASH>
# benchmark an endpoint's handshake latency over N sequential probes
# (min, mean, p50, p95, max — only successful handshakes count):
x402-tester benchmark https://example.com/paid-api --probes 20
# run the full paid flow end to end against local mock servers —
# handshake, sign, facilitator /verify, paid request. No chain, no funds:
x402-tester e2e
# with --schema, the paid response is also validated against its
# documented shape as a fifth step (a mismatch fails the run):
x402-tester e2e --schema '{"type":"object","required":["resource"],"properties":{"resource":{"type":"string"}}}'
# or validate a saved paid response offline (e.g. captured from a real
# endpoint) against a schema file — exit 0 only when every field matches:
x402-tester schema paid-response.json --schema response-schema.json
# start a mock facilitator + mock paid endpoint on localhost for manual
# testing (curl your own client against them); stops on Ctrl-C:
x402-tester mock
```

Example output for a healthy endpoint:

```
x402 handshake check: https://example.com/paid-api
status: OK (212ms)
scheme: exact | network: base
payTo: 0xB3f5...de9
price: 0.02 USDC
```

Exit code is `0` when the handshake is valid, `1` otherwise — so it drops straight into CI.

## Config file

Drop an `x402-tester.json` in your project root (or any parent directory — it's discovered upward) and stop repeating flags:

```json
{
  "method": "POST",
  "json": true,
  "endpoints": [
    "https://example.com/paid-api",
    "POST https://example.com/post-only-api"
  ]
}
```

Supported keys: `method`, `json`, `report` (`"md"`), `rpc`, `blockhash`, `decimals`, `port`, `endpointPort`, `retries`, `timeoutMs`, `probes`, `endpoints`. Probe flags: `--retries N` retries only transient failures (transport errors, 429/502/503/504) and `--timeout N` sets the per-attempt timeout in milliseconds (default 15000). A command run without a URL checks the first configured endpoint; `batch` run without a file checks all of them. Precedence: CLI flags beat the config file, which beats built-in defaults. Run `x402-tester config` to inspect the resolved settings, or point at a specific file with `--config <path>`. Signing keys are never read from config — use `--key` or `X402_TEST_KEY` / `X402_SOLANA_TEST_KEY`.

## What it checks

- Endpoint answers unpaid requests with HTTP 402 (not 200, not a redirect)
- The 402 body is valid JSON with a non-empty `accepts` array (x402 v2) or `paymentRequirements` (v1)
- The first payment requirement carries `scheme`, `network`, `payTo`, `asset`, and `amount`
- Warns on multiple payment options and server-reported error fields
- With `--schema`, the paid response must match its documented shape: `e2e` checks the live paid response, and `schema` checks a saved response file. Supported keywords: `type`, `required`, `properties`, `additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems` — failures name the exact field (`$.items[1].price`)

## Roadmap

See [ROADMAP.md](ROADMAP.md) — the project ships one real increment per day: paid end-to-end test flows, discovery-listing checks, report formats, CI integration, and more.

## Development

```sh
npm test   # runs the test suite (Node's built-in runner, no deps)
```

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Odemakinde Ezekiel Temitayo](https://github.com/nostoryworld) with Muse. I run several live x402 services; this is the harness I wish existed when I started testing them.
