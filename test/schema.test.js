import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePaidResponse,
  assertValidSchema,
  formatSchemaReport,
} from "../src/schema.js";
import { runPaidEndToEnd } from "../src/endtoend.js";

const mockPaidBody = {
  resource: "Hello from the mock paid endpoint — this response was 'paid for'.",
  receipt: "verified by the mock facilitator, settled by nobody, worth nothing",
  paidBy: "0x0000000000000000000000000000000000000000",
};

describe("validatePaidResponse — types", () => {
  it("passes a matching shape and fails a wrong-typed field with its path", () => {
    const schema = {
      type: "object",
      required: ["resource"],
      properties: {
        resource: { type: "string" },
        paidBy: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      },
    };
    assert.deepEqual(validatePaidResponse(mockPaidBody, schema), { ok: true, errors: [] });
    const bad = validatePaidResponse({ ...mockPaidBody, resource: 42 }, schema);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors, [
      { path: "$.resource", message: "expected type string, got integer" },
    ]);
  });

  it("treats integers as numbers but not the reverse", () => {
    assert.equal(validatePaidResponse(3, { type: "number" }).ok, true);
    assert.equal(validatePaidResponse(3.5, { type: "integer" }).ok, false);
    assert.equal(validatePaidResponse(null, { type: "null" }).ok, true);
    assert.equal(validatePaidResponse([1], { type: "array" }).ok, true);
    assert.equal(validatePaidResponse(true, { type: "boolean" }).ok, true);
  });

  it("accepts a list of types", () => {
    assert.equal(validatePaidResponse("x", { type: ["string", "null"] }).ok, true);
    assert.equal(validatePaidResponse(null, { type: ["string", "null"] }).ok, true);
    assert.equal(validatePaidResponse(1, { type: ["string", "null"] }).ok, false);
  });

  it("reports a wrong-typed value once, not once per keyword", () => {
    const bad = validatePaidResponse(
      { count: "three" },
      { type: "object", properties: { count: { type: "integer", minimum: 1 } } }
    );
    assert.deepEqual(bad.errors, [
      { path: "$.count", message: "expected type integer, got string" },
    ]);
  });
});

describe("validatePaidResponse — object and array keywords", () => {
  it("flags missing required properties at their paths", () => {
    const bad = validatePaidResponse(
      { resource: "ok" },
      { type: "object", required: ["resource", "receipt"] }
    );
    assert.deepEqual(bad.errors, [
      { path: "$.receipt", message: "missing required property 'receipt'" },
    ]);
  });

  it("rejects additional properties when additionalProperties is false", () => {
    const bad = validatePaidResponse(
      { resource: "ok", surprise: true },
      {
        type: "object",
        properties: { resource: { type: "string" } },
        additionalProperties: false,
      }
    );
    assert.deepEqual(bad.errors, [
      { path: "$.surprise", message: "additional property 'surprise' is not allowed" },
    ]);
  });

  it("validates extra properties against an additionalProperties schema", () => {
    const schema = {
      type: "object",
      properties: { resource: { type: "string" } },
      additionalProperties: { type: "string" },
    };
    assert.equal(validatePaidResponse({ resource: "ok", a: "x" }, schema).ok, true);
    const bad = validatePaidResponse({ resource: "ok", a: 1 }, schema);
    assert.deepEqual(bad.errors, [
      { path: "$.a", message: "expected type string, got integer" },
    ]);
  });

  it("validates nested objects and array items with indexed paths", () => {
    const bad = validatePaidResponse(
      { user: { name: 7 }, items: [{ price: 10 }, { price: "free" }] },
      {
        type: "object",
        properties: {
          user: { type: "object", properties: { name: { type: "string" } } },
          items: { type: "array", items: { type: "object", properties: { price: { type: "number" } } } },
        },
      }
    );
    assert.deepEqual(bad.errors, [
      { path: "$.user.name", message: "expected type string, got integer" },
      { path: "$.items[1].price", message: "expected type number, got string" },
    ]);
  });
});

describe("validatePaidResponse — scalar keywords", () => {
  it("enforces enum, const, minimum/maximum and string length", () => {
    assert.equal(validatePaidResponse("paid", { enum: ["paid", "free"] }).ok, true);
    assert.equal(validatePaidResponse("other", { enum: ["paid", "free"] }).ok, false);
    assert.equal(validatePaidResponse(5, { const: 5 }).ok, true);
    assert.equal(validatePaidResponse(6, { const: 5 }).ok, false);
    assert.equal(
      validatePaidResponse(0, { type: "number", minimum: 1 }).errors[0].message,
      "number 0 is below minimum 1"
    );
    assert.equal(
      validatePaidResponse(11, { type: "number", maximum: 10 }).errors[0].message,
      "number 11 is above maximum 10"
    );
    assert.equal(validatePaidResponse("ab", { minLength: 3 }).ok, false);
    assert.equal(validatePaidResponse("abcd", { maxLength: 3 }).ok, false);
  });

  it("enforces pattern and array size", () => {
    assert.equal(validatePaidResponse("0xabc", { pattern: "^0x" }).ok, true);
    assert.equal(validatePaidResponse("abc", { pattern: "^0x" }).ok, false);
    assert.equal(validatePaidResponse([1], { minItems: 2 }).ok, false);
    assert.equal(validatePaidResponse([1, 2, 3], { maxItems: 2 }).ok, false);
  });
});

describe("assertValidSchema", () => {
  it("throws on a non-object schema, an unknown type, or a bad pattern", () => {
    assert.throws(() => assertValidSchema(null), /schema must be an object/);
    assert.throws(() => assertValidSchema([1]), /schema must be an object/);
    assert.throws(() => assertValidSchema({ type: "date" }), /unknown type 'date'/);
    assert.throws(
      () => assertValidSchema({ properties: { a: { type: "nope" } } }),
      /unknown type 'nope'/
    );
    assert.throws(() => assertValidSchema({ pattern: "(" }), /not a valid regular expression/);
    assert.throws(() => assertValidSchema({ required: "resource" }), /'required' must be an array/);
  });

  it("throws from validatePaidResponse on a bad schema, never passes it", () => {
    assert.throws(() => validatePaidResponse({}, { type: "date" }), /unknown type/);
  });
});

describe("formatSchemaReport", () => {
  it("renders PASS text and FAIL text with every mismatch path", () => {
    assert.match(formatSchemaReport({ ok: true, errors: [] }), /PASS/);
    const text = formatSchemaReport({
      ok: false,
      errors: [
        { path: "$.resource", message: "expected type string, got integer" },
        { path: "$.receipt", message: "missing required property 'receipt'" },
      ],
    });
    assert.match(text, /FAIL/);
    assert.match(text, /2 mismatches/);
    assert.match(text, /\$\.resource: expected type string, got integer/);
    assert.match(text, /\$\.receipt: missing required property 'receipt'/);
  });
});

describe("e2e schema step", () => {
  it("adds a passing schema step when the paid response matches", async () => {
    const report = await runPaidEndToEnd({
      expectedSchema: {
        type: "object",
        required: ["resource", "receipt", "paidBy"],
        properties: {
          resource: { type: "string" },
          receipt: { type: "string" },
          paidBy: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        },
        additionalProperties: false,
      },
    });
    assert.equal(report.ok, true);
    assert.equal(report.steps.length, 5);
    assert.equal(report.steps[4].name, "schema");
    assert.equal(report.steps[4].ok, true);
    assert.match(report.steps[4].detail, /matches the documented shape/);
    assert.deepEqual(report.schema, { ok: true, errors: [] });
    assert.match(formatSchemaReport(report.schema), /PASS/);
  });

  it("fails the run when the paid response mismatches, naming the field", async () => {
    const report = await runPaidEndToEnd({
      expectedSchema: {
        type: "object",
        required: ["resource", "transactionHash"],
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.steps.length, 5);
    assert.equal(report.steps[4].name, "schema");
    assert.equal(report.steps[4].ok, false);
    assert.match(report.steps[4].detail, /\$\.transactionHash: missing required property/);
    assert.equal(report.schema.ok, false);
  });

  it("reports an invalid schema as a failed schema step, not a crash", async () => {
    const report = await runPaidEndToEnd({
      expectedSchema: { type: "date" },
    });
    assert.equal(report.ok, false);
    assert.equal(report.steps[4].name, "schema");
    assert.match(report.steps[4].detail, /invalid schema: .*unknown type 'date'/);
  });
});
