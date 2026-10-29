/**
 * Paid-response schema validation.
 *
 * After a payment, the endpoint serves the resource — but nothing in
 * the x402 handshake says what that response looks like. This module
 * checks a paid response against its documented shape, so an endpoint
 * that pays fine yet returns the wrong fields (a renamed key, a string
 * where a number was promised, a missing nested object) fails loudly
 * instead of breaking clients silently.
 *
 * The schema language is a dependency-free subset of JSON Schema —
 * enough to document a real API response, small enough to audit:
 *   type (string or array of types), required, properties,
 *   additionalProperties (boolean, or a schema for the extra keys),
 *   items, enum, const, minimum, maximum, minLength, maxLength,
 *   pattern, minItems, maxItems.
 * Anything outside the subset is ignored, so a full JSON Schema
 * document still validates on the keywords above rather than erroring.
 *
 * Errors carry JSON paths (`$.items[2].price`) so a failure points at
 * the exact field, not just "schema mismatch".
 */

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** A JSON value is a "number" if it is an integer or a float. */
function matchesType(value, type) {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeOf(value) === type;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Check that a schema document itself is well-formed before it is
 * used: it must be an object, and any `type` it (or a nested schema)
 * names must be a known type. A bad schema throws instead of passing
 * every response — a typo in the documented shape must never read as
 * a passing check.
 */
export function assertValidSchema(schema, path = "$schema") {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`invalid schema at ${path}: schema must be an object`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) {
      if (!TYPES.has(t)) {
        throw new Error(`invalid schema at ${path}: unknown type '${t}'`);
      }
    }
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error(`invalid schema at ${path}: 'required' must be an array`);
  }
  if (schema.properties !== undefined) {
    if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      throw new Error(`invalid schema at ${path}: 'properties' must be an object`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      assertValidSchema(sub, `${path}.properties.${key}`);
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties === "object" &&
    schema.additionalProperties !== null
  ) {
    assertValidSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.items !== undefined) {
    assertValidSchema(schema.items, `${path}.items`);
  }
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern);
    } catch {
      throw new Error(`invalid schema at ${path}: 'pattern' is not a valid regular expression`);
    }
  }
}

function checkValue(value, schema, path, errors) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `expected type ${types.join(" or ")}, got ${typeOf(value)}`,
      });
      // A wrong-typed value cannot satisfy the keywords below either;
      // stop here so one bad field yields one clear error, not a pile.
      return;
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `expected constant ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => deepEqual(value, v))) {
    errors.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}` });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `string is shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `string is longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `number ${value} is below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `number ${value} is above maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `array has fewer than minItems ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `array has more than maxItems ${schema.maxItems} items` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => checkValue(item, schema.items, `${path}[${i}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) {
        errors.push({ path: `${path}.${key}`, message: `missing required property '${key}'` });
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) checkValue(value[key], sub, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties !== undefined) {
      const extra = Object.keys(value).filter((k) => !(k in properties));
      if (schema.additionalProperties === false) {
        for (const key of extra) {
          errors.push({ path: `${path}.${key}`, message: `additional property '${key}' is not allowed` });
        }
      } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
        for (const key of extra) {
          checkValue(value[key], schema.additionalProperties, `${path}.${key}`, errors);
        }
      }
    }
  }
}

/**
 * Validate a paid response body against its documented schema.
 * Returns { ok, errors } where errors is a list of { path, message }.
 * Throws on a malformed schema (see assertValidSchema) — never on a
 * mismatching response, which is a failed check, not a crash.
 */
export function validatePaidResponse(body, schema) {
  assertValidSchema(schema);
  const errors = [];
  checkValue(body, schema, "$", errors);
  return { ok: errors.length === 0, errors };
}

export function formatSchemaReport(report) {
  const lines = [
    `paid response schema check: ${report.ok ? "PASS" : "FAIL"}`,
  ];
  if (report.ok) {
    lines.push("response matches the documented shape");
  } else {
    lines.push(`${report.errors.length} mismatch${report.errors.length === 1 ? "" : "es"}:`);
    for (const e of report.errors) lines.push(`  ${e.path}: ${e.message}`);
  }
  return lines.join("\n");
}
