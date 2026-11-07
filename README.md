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
# diff the handshakes of two endpoints (e.g. staging vs production) —
# exit 0 when both handshakes are valid, even when the terms differ;
# under --ci a difference fails the run:
x402-tester compare https://staging.example.com/paid-api https://example.com/paid-api
# fire a burst of rapid requests (default 20) and report whether the
# endpoint throttles with 429s — and whether those 429s are graceful
# (a parseable Retry-After on every one). Exit 0 when the probe ran
# cleanly; "not rate limited" is a finding, not a failure:
x402-tester ratelimit https://example.com/paid-api --burst 20
# run the full paid flow end to end against local mock servers —
# handshake, sign, facilitator /verify, paid request. No chain, no funds:
x402-tester e2e
# with --schema, the paid response is also validated against its
# documented shape as a fifth step (a mismatch fails the run):
x402-tester e2e --schema '{"type":"object","required":["resource"],"properties":{"resource":{"type":"string"}}}'
# or validate a saved paid response offline (e.g. captured from a real
# endpoint) against a schema file — exit 0 only when every field matches:
x402-tester schema paid-response.json --schema response-schema.json
# replay protection check: sign one payment against local mocks, settle
# it, then send the exact same signed payment again — a protected
# endpoint rejects the replay (402); exit 0 only when it does:
x402-tester replay
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

## Custom checks (plugins)

Bring your own assertions to `check` with `--plugin <file>` (repeatable), or list them in `x402-tester.json` under `"plugins"` (config entries run first, CLI entries after; a file listed twice runs once). A plugin is a JS file that default-exports a function or a `{ name, check }` object; it runs only after a passing handshake, and receives the URL, method, handshake report, first payment requirement, and price:

```js
// only-base.mjs — fail any endpoint that does not settle on base
export default {
  name: "only-base",
  check: ({ requirements }) =>
    requirements.network === "base"
      ? { ok: true }
      : { ok: false, message: `expected base, got ${requirements.network}` },
};
```

```sh
x402-tester check https://example.com/paid-api --plugin ./only-base.mjs
```

A check may return nothing/`true` (pass), `false` (fail), a string (fail with that message), or a result object `{ ok, message?, warning? }` — a warning joins the report's warnings, so it fails the run under `--ci` like any built-in warning. A plugin that throws or returns a bad shape fails only itself, never the whole run; but a plugin path that cannot be loaded fails before any check runs, so a typo never silently skips your custom checks. Plugin results appear in the text report, `--json` (as `plugins`), and `--report md`, and plugin failures surface as `::error::` annotations under `--ci`. Plugins are arbitrary code run with the CLI's privileges — load only files you trust.

## CI mode

Add `--ci` to any report command (`check`, `batch`, `compare`, `benchmark`, `ratelimit`, `e2e`, `replay`, `schema`, `facilitator`, `x402scan`, `bazaar`) and it becomes a CI gate:

```sh
x402-tester check https://example.com/paid-api --ci
```

- Failures and warnings are emitted as GitHub Actions annotations (`::error::` / `::warning::`) on stderr, so they show up on the run — and `--json` output on stdout stays parseable when piped to `jq`.
- Exit codes are strict: a passing check that carries a warning (for example a dust- or whale-priced endpoint flagged by price sanity) exits `1` instead of `0`. Without `--ci`, warnings never fail a run.
- `ci` can also be set in `x402-tester.json` (`"ci": true`); the `--ci` flag beats the config file, as usual.

```yaml
- name: Check x402 handshake
  run: npx x402-tester check https://example.com/paid-api --ci
```

## GitHub Action

Use the wrapper directly in another repo's workflow — no npm publish needed, it runs the CLI from the action's own checkout:

```yaml
- uses: nostoryworld/x402-tester@v1
  with:
    endpoint: https://example.com/paid-api
```

| Input | Required | Default | Meaning |
|---|---|---|---|
| `endpoint` | yes | — | URL of the x402 endpoint to check |
| `method` | no | `GET` | HTTP method for the unpaid probe |
| `args` | no | — | Extra arguments passed to `x402-tester check` (for example `--retries 2 --timeout 10000`) |
| `fail-on-warning` | no | `true` | Fail the run when the check passes with warnings — adds `--ci` (strict exit codes + annotations) |
| `node-version` | no | `20` | Node.js version used to run the action |

The action exposes one output, `result` (`success` or `failure`), so later steps can branch on it:

```yaml
- uses: nostoryworld/x402-tester@v1
  id: handshake
  with:
    endpoint: https://example.com/paid-api
    method: POST
- if: steps.handshake.outputs.result == 'failure'
  run: echo "handshake gate failed"
```

Until a `v1` tag is cut, pin `@main` instead. The check itself is the same `check` command as the CLI, so a failing handshake fails the workflow step and the failure shows up as a GitHub annotation.

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

Supported keys: `method`, `json`, `ci`, `report` (`"md"` or `"html"`), `rpc`, `blockhash`, `decimals`, `port`, `endpointPort`, `retries`, `timeoutMs`, `probes`, `burst`, `endpoints`, `plugins` (custom-check plugin file paths, run by `check`). Probe flags: `--retries N` retries only transient failures (transport errors, 429/502/503/504) and `--timeout N` sets the per-attempt timeout in milliseconds (default 15000). `--burst N` sets the rate-limit probe size (default 20, max 100); `--retries` is ignored for `ratelimit`, since retrying would hide the 429s being measured. A command run without a URL checks the first configured endpoint; `batch` run without a file checks all of them. Precedence: CLI flags beat the config file, which beats built-in defaults. Run `x402-tester config` to inspect the resolved settings, or point at a specific file with `--config <path>`. Signing keys are never read from config — use `--key` or `X402_TEST_KEY` / `X402_SOLANA_TEST_KEY`.

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
