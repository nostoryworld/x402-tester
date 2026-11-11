import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const explainerPath = join(root, "docs", "how-x402-payments-work.md");
const explainer = readFileSync(explainerPath, "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cliSource = readFileSync(join(root, "src", "index.js"), "utf8");
const paySource = readFileSync(join(root, "src", "pay.js"), "utf8");
const facilitatorSource = readFileSync(
  join(root, "src", "mockFacilitator.js"),
  "utf8"
);

test("explainer exists and is structured", () => {
  assert.ok(existsSync(explainerPath), "docs/how-x402-payments-work.md must exist");
  assert.match(explainer, /^# How x402 payments work/m);
  assert.match(explainer, /## The flow, step by step/m);
  assert.match(explainer, /## Replay protection/m);
  assert.match(explainer, /## v1 vs v2/m);
  assert.match(explainer, /## Try it yourself/m);
  assert.match(explainer, /## FAQ/m);
  const sections = explainer.match(/^## /gm) ?? [];
  assert.ok(
    sections.length >= 8,
    `explainer should have several top-level sections, found ${sections.length}`
  );
});

test("explainer's annotated 402 matches the xpay-uuid fixture exactly", () => {
  // The worked example must be the recorded response, not a paraphrase:
  // every field the doc quotes has to match examples/xpay-uuid.json.
  const fixture = JSON.parse(
    readFileSync(join(root, "examples", "xpay-uuid.json"), "utf8")
  );
  const offered = fixture.response.accepts[0];
  assert.equal(fixture.response.x402Version, 2);
  for (const [field, value] of Object.entries(offered)) {
    if (field === "resource") continue; // long URL, not quoted in full
    if (field === "extra") {
      // object-valued: check the key and its name/version land in the doc
      assert.ok(explainer.includes('"extra"'), 'explainer must quote the fixture\'s "extra"');
      assert.ok(explainer.includes('"name": "USD Coin"'));
      assert.ok(explainer.includes('"version": "2"'));
      continue;
    }
    assert.ok(
      explainer.includes(`"${field}": "${value}"`) ||
        explainer.includes(`"${field}": ${value}`),
      `explainer must quote the fixture's ${field}: ${value}`
    );
  }
  assert.ok(
    explainer.includes("PAYMENT-SIGNATURE header is required"),
    "explainer must quote the fixture's error field"
  );
});

test("fixture prices in the explainer are arithmetically right", () => {
  // USDC has 6 decimals: price = amount / 10^6. The doc's price table
  // must agree with the recorded amounts in examples/*.json.
  const expected = {
    "tbs-weather-current": ["1000", "0.001 USDC"],
    "onesource-block-number": ["1000", "0.001 USDC"],
    "xpay-uuid": ["5000", "0.005 USDC"],
    "ax1-q-verdict": ["20000", "0.02 USDC"],
  };
  for (const [name, [amount, price]] of Object.entries(expected)) {
    const fixture = JSON.parse(
      readFileSync(join(root, "examples", `${name}.json`), "utf8")
    );
    const offered = fixture.response.accepts[0];
    assert.equal(
      String(offered.amount),
      amount,
      `${name} fixture amount must be ${amount}`
    );
    assert.ok(
      explainer.includes(`"${amount}"`) && explainer.includes(price),
      `explainer must pair amount ${amount} with price ${price}`
    );
    const computed = Number(amount) / 1e6;
    assert.equal(
      computed.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") ||
        computed.toString(),
      price.split(" ")[0],
      `amount ${amount} must compute to ${price}`
    );
  }
});

test("EIP-712 authorization fields match pay.js", () => {
  // The signing section must name the exact fields the tool signs
  // (AUTHORIZATION_TYPES in src/pay.js) — a renamed or missing field
  // would teach the wrong message shape.
  for (const field of [
    "from",
    "to",
    "value",
    "validAfter",
    "validBefore",
    "nonce",
  ]) {
    assert.ok(
      paySource.includes(`{ name: "${field}"`),
      `pay.js must define authorization field ${field}`
    );
    assert.ok(
      explainer.includes(`\`${field}\``),
      `explainer must document authorization field ${field}`
    );
  }
  assert.ok(explainer.includes("TransferWithAuthorization"));
  assert.ok(explainer.includes("EIP-712"));
  assert.ok(explainer.includes("EIP-3009"));
});

test("validity-window arithmetic matches the code", () => {
  // buildAuthorization: validAfter = now - 30, validBefore =
  // now + maxTimeoutSeconds. For the X Pay option (60s) the signed
  // payment is therefore valid for 90 seconds in total.
  assert.ok(paySource.includes("validAfter: BigInt(now - 30)"));
  assert.ok(paySource.includes("validBefore: BigInt(now + timeout)"));
  assert.ok(explainer.includes("maxTimeoutSeconds"));
  assert.ok(
    explainer.includes("90 seconds"),
    "explainer must work the X Pay 60s timeout out to a 90-second window"
  );
});

test("facilitator contract matches the mock facilitator", () => {
  // /verify takes { x402Version, paymentPayload, paymentRequirements }
  // and answers { isValid, invalidReason? }; /settle answers
  // { success, transaction }. The explainer must describe that
  // contract, including that /verify does not consume a payment.
  assert.ok(facilitatorSource.includes('"/verify"'));
  assert.ok(facilitatorSource.includes('"/settle"'));
  assert.ok(facilitatorSource.includes("isValid"));
  assert.ok(facilitatorSource.includes("invalidReason"));
  for (const phrase of [
    "POST /verify",
    "POST /settle",
    "isValid",
    "invalidReason",
    "spend the payment",
    "only settling marks a payment",
  ]) {
    assert.ok(
      explainer.includes(phrase),
      `explainer must cover the facilitator contract: "${phrase}"`
    );
  }
  assert.ok(explainer.includes("payment has already been settled"));
});

test("every CLI command the explainer tells readers to run exists", () => {
  // Keeps the walkthrough honest: a command the explainer recommends
  // must be one src/index.js actually implements.
  const commands = [...new Set(explainer.match(/x402-tester (check|pay|e2e|replay|mock|facilitator|fixtures)\b/g) ?? [])].map(
    (m) => m.replace("x402-tester ", "")
  );
  assert.ok(commands.length >= 5, `explainer should walk through CLI commands, found ${commands.length}`);
  for (const cmd of commands) {
    assert.ok(
      cliSource.includes(cmd),
      `explainer recommends x402-tester ${cmd}, but the CLI does not implement it`
    );
  }
  const flags = [...new Set(explainer.match(/--[a-z][a-z-]*/g) ?? [])];
  for (const flag of flags) {
    assert.ok(
      cliSource.includes(`"${flag}"`),
      `explainer recommends ${flag}, but the CLI does not parse it`
    );
  }
});

test("explainer's v1/v2 table matches the normalizer", () => {
  const requirementsSource = readFileSync(
    join(root, "src", "requirements.js"),
    "utf8"
  );
  assert.ok(requirementsSource.includes("maxAmountRequired"));
  assert.ok(requirementsSource.includes("accepts"));
  for (const term of [
    "paymentRequirements",
    "maxAmountRequired",
    "accepts",
    "X-PAYMENT",
    "PAYMENT-SIGNATURE",
  ]) {
    assert.ok(explainer.includes(term), `explainer must cover v1/v2 term ${term}`);
  }
});

test("README links to the explainer", () => {
  assert.ok(
    readme.includes("docs/how-x402-payments-work.md"),
    "README must link to docs/how-x402-payments-work.md"
  );
});

test("explainer ships in the npm package", () => {
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("docs"),
    'package.json "files" must include "docs" so the explainer ships with the package'
  );
});

test("explainer points to troubleshooting for failures", () => {
  assert.ok(
    explainer.includes("docs/troubleshooting.md"),
    "explainer must point readers at the troubleshooting guide for failures"
  );
});
