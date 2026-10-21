# x402-tester — 30-day build roadmap

One genuine, tested increment per day. Each day ships as a single commit.
Checked boxes are done; the next unchecked day is always the one to build.

- [x] **Day 1** — Scaffold + 402 handshake validator (`check` command) with tests
- [x] **Day 2** — Normalize payment requirements: handle v1 `paymentRequirements` and v2 `accepts` shapes uniformly, with unit tests for both; add `--method` flag (POST-only endpoints like rugcheck answer GET 402s with an empty body)
- [x] **Day 3** — Human-readable price formatting: resolve asset decimals and show real token amounts instead of raw units
- [x] **Day 4** — Facilitator reachability check: probe the facilitator's `/verify` endpoint and report reachability
- [x] **Day 5** — x402scan discovery check: report whether the endpoint is listed on x402scan
- [x] **Day 6** — `pay` command: sign an x402 payment payload with viem (EVM, local test key only)
- [x] **Day 7** — Paid end-to-end test flow against a mock facilitator (no real funds)
- [ ] **Day 8** — Solana payment flow support on devnet
- [ ] **Day 9** — JSON report output (`--json` flag)
- [ ] **Day 10** — Markdown report export (`--report md`)
- [ ] **Day 11** — Batch mode: check many endpoints listed in a file
- [ ] **Day 12** — Config file support (`x402-tester.json`)
- [ ] **Day 13** — Retry and timeout policy options (`--retries`, `--timeout`)
- [ ] **Day 14** — Latency benchmark mode: p50/p95 over N probes
- [ ] **Day 15** — Paid-response schema validation: does the paid response match the documented shape?
- [ ] **Day 16** — CDP Bazaar discovery check
- [ ] **Day 17** — Price sanity checks: flag dust-level or whale-level mispricing
- [ ] **Day 18** — CI mode: strict exit codes plus GitHub Actions annotations
- [ ] **Day 19** — GitHub Action wrapper so repos can test their own x402 endpoints in CI
- [ ] **Day 20** — Custom check plugin system (user-supplied check functions)
- [ ] **Day 21** — HTML report output
- [ ] **Day 22** — Compare mode: diff the handshakes of two endpoints
- [ ] **Day 23** — Rate-limit behavior probe (does the endpoint 429 gracefully?)
- [ ] **Day 24** — Signed-payment replay protection check
- [ ] **Day 25** — Example fixtures for well-known x402 endpoints
- [ ] **Day 26** — npm publish preparation (package metadata, files allowlist)
- [ ] **Day 27** — Docs: troubleshooting guide for common handshake failures
- [ ] **Day 28** — Docs: "how x402 payments work" explainer
- [ ] **Day 29** — v1.0.0 release prep: changelog and version bump
- [ ] **Day 30** — Retrospective on the 30 days + roadmap for v2
