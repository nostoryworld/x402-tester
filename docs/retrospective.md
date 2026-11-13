# Retrospective: 30 days of x402-tester

Thirty days, one tested increment a day, from an empty repo to a released
v1.0.0. This page is the honest record of what the month produced, what
worked, what did not, and what we would do differently.

## What shipped

- **30 days, 30 commits** on `main`, 16 October – 13 November 2026, each
  one a real, tested increment. No filler commits, no empty pushes.
- **15 commands**: `check`, `fixtures`, `compare`, `benchmark`,
  `ratelimit`, `batch`, `pay`, `e2e`, `replay`, `schema`, `mock`,
  `facilitator`, `x402scan`, `bazaar`, `config`.
- **26 source modules** (6,295 lines) and **31 test files** (5,881 lines):
  **402 tests in 58 suites, all passing**.
- **4 bundled example fixtures** — recorded 402 responses from real public
  x402 endpoints, runnable offline with `x402-tester check --fixture <name>`.
- **3 report formats** (human-readable, `--json`, `--report md|html`),
  batch mode, config file, retry/timeout policy, CI mode with GitHub
  Actions annotations, and a GitHub Action wrapper.
- **3 guides**: this retrospective, `docs/troubleshooting.md`,
  `docs/how-x402-payments-work.md`.
- **v1.0.0 released** on Day 29, with a changelog and npm publish
  preparation. The package is not yet published to npm — that is the
  first item on the [v2 roadmap](v2-roadmap.md).

## What worked

- **One small increment a day, every day.** The daily cap forced small
  scopes. Nothing in the repo is a half-finished mega-feature; every day
  landed complete, tested, and shippable on its own.
- **The mock facilitator (Day 7).** Paid flows are the riskiest part of
  x402 to test, and the mock made them testable with no funds at all.
  Every paid-flow feature since — `pay`, `e2e`, `replay`, schema
  validation — builds on it.
- **Fixtures from real endpoints (Day 25).** Recording real 402 responses
  and checking them offline caught shape differences (v1 vs v2, empty
  bodies on GET) that invented examples never would have.
- **Docs tests.** The troubleshooting guide and the protocol explainer
  have tests that fail if the guide's error strings or flags drift from
  the code. Guides rot silently without them; with them, a code change
  that renames an error forces the guide to follow.
- **Fail-closed discipline.** Broken tests or an empty diff meant no
  push, no exceptions. The rule was never bent, and the history shows
  it: every commit on `main` passed the suite at push time.

## What did not work, or is still weak

- **Live checks are slow and network-dependent.** The suite takes about
  23 seconds, most of it waiting on network probes. A test that needs
  the network is a test that can fail for reasons that have nothing to
  do with the code.
- **Discovery checks depend on third-party pages.** The x402scan and
  CDP Bazaar checks scrape or query pages this project does not control.
  If either site changes shape, the check breaks with no warning from
  the tool itself.
- **Solana is devnet-only.** The Solana payment flow (Day 8) signs and
  verifies against devnet. There is no mainnet path, and none is planned
  without a separate safety review.
- **No real settlement.** `pay` signs a payment and the mock facilitator
  accepts it, but the tool has never settled a payment against a real
  facilitator. Everything paid is simulated. That is the biggest gap
  between what the tool claims and what it has proven.
- **x402 v2 support is normalisation only.** The tool reads v2 `accepts`
  shapes and validates them, but the paid flow is still built around v1
  assumptions.
- **No watch mode.** Every check is a one-shot probe. There is no way to
  watch an endpoint over time and be told when its handshake changes.
- **The package is not published.** Publish preparation landed on Day 26,
  but v1.0.0 has not been pushed to npm, so nobody can install it with
  `npm install -g x402-tester` yet.

## Lessons for the next project

1. **Start with the mock, not the real thing.** The mock facilitator
   should have been Day 2, not Day 7 — every paid-flow day after it was
   faster because the mock existed.
2. **Record real responses early.** The fixtures caught real-world shape
   quirks. Invented test data hides exactly the differences that matter.
3. **Test the docs the same way as the code.** A guide that drifts from
   the tool is worse than no guide, because users trust it.
4. **Keep the daily scope ruthless.** The days that slipped were the
   ones where the item quietly grew ("and also…"). One item, one commit.
5. **Publish early.** Waiting until Day 26 to prepare publishing meant
   the release was a scramble. Next time, publish a 0.1.0 in week one
   and let real installs find the bugs.

## The numbers

| Measure | Value |
| --- | --- |
| Days / commits | 30 |
| Source modules | 26 |
| Source lines | 6,295 |
| Test files | 31 |
| Test lines | 5,881 |
| Tests (passing) | 402 in 58 suites |
| Example fixtures | 4 |
| Commands | 15 |
| Released version | 1.0.0 (Day 29) |

Where next: [v2 roadmap](v2-roadmap.md).
