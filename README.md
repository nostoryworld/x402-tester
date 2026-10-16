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
```

Example output for a healthy endpoint:

```
x402 handshake check: https://example.com/paid-api
status: OK (212ms)
scheme: exact | network: base
payTo: 0xB3f5...de9
price: 20000 (raw units) of 0x8335...1300
```

Exit code is `0` when the handshake is valid, `1` otherwise — so it drops straight into CI.

## What it checks

- Endpoint answers unpaid requests with HTTP 402 (not 200, not a redirect)
- The 402 body is valid JSON with a non-empty `accepts` array (x402 v2) or `paymentRequirements` (v1)
- The first payment requirement carries `scheme`, `network`, `payTo`, `asset`, and `amount`
- Warns on multiple payment options and server-reported error fields

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
