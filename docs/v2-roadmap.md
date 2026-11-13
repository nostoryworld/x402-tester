# v2 roadmap

What comes after v1.0.0. Items are ordered by value, not by ease. Each one
names the gap it closes (see the [retrospective](retrospective.md)) and
what "done" looks like.

## 1. Publish 1.0.0 to npm

- **Why:** publish preparation landed on Day 26, but the package is not
  on npm yet, so nobody can install it with `npm install -g x402-tester`.
- **Done when:** `npm view x402-tester version` returns `1.0.0`, and the
  README install section is verified against a clean install.

## 2. Settle against a real facilitator

- **Why:** every paid flow today is simulated. `pay` signs and the mock
  facilitator accepts, but the tool has never settled a payment for real.
  That is the biggest gap between what the tool claims and what it has
  proven.
- **Done when:** `x402-tester e2e` gains a `--live-facilitator <url>` mode
  that settles a real payment of a few cents against a public facilitator
  on testnet, with a `--dry-run` default so nothing is spent by accident.

## 3. Watch mode

- **Why:** every check today is a one-shot probe. There is no way to
  watch an endpoint over time and be told when its handshake changes.
- **Done when:** `x402-tester watch <url> [--interval <seconds>]` re-runs
  `check` on a schedule, prints only changes, and exits non-zero on the
  first regression (CI-friendly, same exit-code contract as CI mode).

## 4. Full x402 v2 paid flow

- **Why:** v2 support today is normalisation only — the tool reads v2
  `accepts` shapes, but the paid flow is built around v1 assumptions.
- **Done when:** `pay` and `e2e` work end-to-end against a v2 `accepts`
  response, covered by fixtures recorded from a real v2 endpoint.

## 5. Mainnet-safe Solana

- **Why:** the Solana flow (Day 8) is devnet-only. There is no mainnet
  path, and none should exist without a separate safety review.
- **Done when:** a documented, reviewed `--network mainnet-beta` path
  exists with explicit confirmation prompts, hard spending caps, and a
  dry-run default — or the item is explicitly declined with the reason
  recorded here.

## 6. Discovery checks that do not scrape

- **Why:** the x402scan and CDP Bazaar checks depend on third-party pages
  this project does not control. If either site changes shape, the check
  breaks silently.
- **Done when:** each discovery check uses a stable API or feed where one
  exists, and fails loudly with a clear message where it still has to
  scrape, instead of reporting "not listed" on a parse failure.

## 7. Faster, hermetic tests

- **Why:** the suite takes about 23 seconds, most of it waiting on
  network probes. A test that needs the network can fail for reasons
  that have nothing to do with the code.
- **Done when:** the suite runs in under 5 seconds with no network
  access, and any test that does need the network is marked and skipped
  by default.

## 8. Plugin registry and examples

- **Why:** the plugin system (Day 20) works, but there is no shared
  place to find or publish custom checks.
- **Done when:** `docs/plugins.md` documents the plugin API with three
  worked examples (header check, schema check, price check), and the
  README links to it.

## 9. `check` against a local server

- **Why:** developers testing a paid endpoint on `localhost` currently
  fight the same network and discovery checks as a public URL.
- **Done when:** `check` detects loopback URLs, skips discovery checks
  automatically, and reports that it did so.

## 10. Release automation

- **Why:** releases are manual — version bump, changelog, tag, publish —
  and manual releases get skipped.
- **Done when:** tagging `v*` on `main` runs the suite, publishes to npm,
  and attaches the changelog section to a GitHub release, with no manual
  steps after the tag.

## Explicitly not in v2

- **Custody or key management.** The tool signs with a throwaway or
  user-supplied test key and never stores keys. That boundary stays.
- **A hosted service.** x402-tester is a CLI you run yourself, not a
  dashboard. Monitoring as a service is a different product.
- **Mainnet EVM payments by default.** Any real-money EVM path needs the
  same safety review as item 5, and stays opt-in behind explicit flags.
