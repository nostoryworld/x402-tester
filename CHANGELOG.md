# Changelog

All notable changes to x402-tester are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-12

The first stable release, built over 30 days of daily increments. Everything
below shipped as a tested, single-commit step on `main`.

### Added

- `check` command: validate a 402 handshake — status, body shape, payment
  requirements, and a human-readable summary (Day 1).
- Payment-requirement normalisation across x402 v1 (`paymentRequirements`)
  and v2 (`accepts`) shapes, plus a `--method` flag for POST-only endpoints
  that answer GET 402s with an empty body (Day 2).
- Human-readable price formatting: asset decimals resolved so real token
  amounts are shown instead of raw units (Day 3).
- Facilitator reachability check: probe the facilitator's `/verify` endpoint
  and report whether it answers (Day 4).
- x402scan discovery check: report whether the endpoint is listed on
  x402scan (Day 5).
- `pay` command: sign an x402 payment payload with viem (EVM, local test
  key only) (Day 6).
- Paid end-to-end test flow against a mock facilitator — no real funds
  involved (Day 7).
- Solana payment flow support on devnet (Day 8).
- JSON report output via `--json` (Day 9).
- Markdown report export via `--report md` (Day 10).
- Batch mode: check many endpoints listed in a file (Day 11).
- Config file support (`x402-tester.json`) (Day 12).
- Retry and timeout policy options (`--retries`, `--timeout`) (Day 13).
- Latency benchmark mode: p50/p95 over N probes (Day 14).
- Paid-response schema validation: does the paid response match the
  documented shape? (Day 15).
- CDP Bazaar discovery check (Day 16).
- Price sanity checks: flag dust-level or whale-level mispricing (Day 17).
- CI mode: strict exit codes plus GitHub Actions annotations (Day 18).
- GitHub Action wrapper so repos can test their own x402 endpoints in CI
  (Day 19).
- Custom check plugin system (user-supplied check functions) (Day 20).
- HTML report output (Day 21).
- Compare mode: diff the handshakes of two endpoints (Day 22).
- Rate-limit behaviour probe: does the endpoint 429 gracefully? (Day 23).
- Signed-payment replay protection check (Day 24).
- Example fixtures for well-known x402 endpoints, runnable offline with
  `x402-tester check --fixture <name>` (Day 25).
- npm publish preparation: package metadata, `files` allowlist, and
  `prepublishOnly` running the test suite (Day 26).
- Docs: troubleshooting guide for common handshake failures
  (`docs/troubleshooting.md`) (Day 27).
- Docs: "how x402 payments work" explainer (`docs/how-x402-payments-work.md`)
  walking the full flow with a real recorded 402 and the tool's own mock
  flow (Day 28).

### Changed

- Version bumped from 0.1.0 to 1.0.0: the public CLI surface is now stable.

[Unreleased]: https://github.com/nostoryworld/x402-tester/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nostoryworld/x402-tester/releases/tag/v1.0.0
