/**
 * Config file support: `x402-tester.json`.
 *
 * The file lives in the working directory (or any parent directory —
 * discovery walks upward, like git) and supplies defaults for the
 * options a user would otherwise repeat on every invocation:
 *
 *   {
 *     "method": "POST",
 *     "json": true,
 *     "report": "md",
 *     "rpc": "https://api.devnet.solana.com",
 *     "blockhash": "…",
 *     "decimals": 6,
 *     "port": 4021,
 *     "endpointPort": 4022,
 *     "endpoints": [
 *       "https://example.com/paid-api",
 *       "POST https://example.com/post-only-api"
 *     ]
 *   }
 *
 * Precedence is strict: CLI flags beat the config file, which beats
 * built-in defaults. A command run without a URL or batch file falls
 * back to the first entry of `endpoints` (or the whole list for
 * `batch`).
 *
 * Deliberately NOT supported here: signing keys. A private key in a
 * checked-in JSON file is a footgun — keys stay on the command line
 * (--key) or in the environment (X402_TEST_KEY /
 * X402_SOLANA_TEST_KEY), and an unknown `key` entry is rejected with
 * the allowed-key list so the mistake is visible.
 *
 * Validation is fail-closed: unknown keys, wrong types, and bad
 * values are ConfigErrors, reported before any command runs — a
 * typo in the config must never silently change what gets tested.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILENAME = "x402-tester.json";

const KNOWN_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export const CONFIG_KEYS = [
  "method",
  "json",
  "report",
  "rpc",
  "blockhash",
  "decimals",
  "port",
  "endpointPort",
  "endpoints",
];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(source, message) {
  throw new ConfigError(
    source ? `invalid config in ${source}: ${message}` : message
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkPort(value, key, source) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(source, `'${key}' must be an integer port between 1 and 65535`);
  }
  return value;
}

/**
 * Validate raw parsed JSON and return a normalised config containing
 * only the keys that were present (method uppercased). Never throws
 * on anything but a ConfigError.
 */
export function parseConfig(raw, source = null) {
  if (!isPlainObject(raw)) {
    fail(source, "top level must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) {
      fail(
        source,
        `unknown key '${key}' (allowed: ${CONFIG_KEYS.join(", ")}). ` +
          `Signing keys are not read from config — pass --key or set ` +
          `X402_TEST_KEY / X402_SOLANA_TEST_KEY instead.`
      );
    }
  }
  const config = {};
  if (raw.method !== undefined) {
    if (typeof raw.method !== "string" || !raw.method.trim()) {
      fail(source, "'method' must be a non-empty string");
    }
    const method = raw.method.trim().toUpperCase();
    if (!KNOWN_METHODS.has(method)) {
      fail(source, `unknown HTTP method '${raw.method}'`);
    }
    config.method = method;
  }
  if (raw.json !== undefined) {
    if (typeof raw.json !== "boolean") {
      fail(source, "'json' must be true or false");
    }
    config.json = raw.json;
  }
  if (raw.report !== undefined) {
    if (raw.report === "json") {
      fail(
        source,
        `'report' does not accept 'json' — use "json": true instead`
      );
    }
    if (raw.report !== "md") {
      fail(source, `'report' must be 'md'`);
    }
    config.report = raw.report;
  }
  if (raw.rpc !== undefined) {
    if (typeof raw.rpc !== "string" || !raw.rpc.trim()) {
      fail(source, "'rpc' must be a non-empty string");
    }
    config.rpc = raw.rpc.trim();
  }
  if (raw.blockhash !== undefined) {
    if (typeof raw.blockhash !== "string" || !raw.blockhash.trim()) {
      fail(source, "'blockhash' must be a non-empty string");
    }
    config.blockhash = raw.blockhash.trim();
  }
  if (raw.decimals !== undefined) {
    if (!Number.isInteger(raw.decimals) || raw.decimals < 0) {
      fail(source, "'decimals' must be a non-negative integer");
    }
    config.decimals = raw.decimals;
  }
  if (raw.port !== undefined) config.port = checkPort(raw.port, "port", source);
  if (raw.endpointPort !== undefined) {
    config.endpointPort = checkPort(raw.endpointPort, "endpointPort", source);
  }
  if (raw.endpoints !== undefined) {
    if (!Array.isArray(raw.endpoints) || raw.endpoints.length === 0) {
      fail(source, "'endpoints' must be a non-empty array of strings");
    }
    for (const entry of raw.endpoints) {
      if (typeof entry !== "string" || !entry.trim()) {
        fail(source, "'endpoints' entries must be non-empty strings");
      }
      const parts = entry.trim().split(/\s+/);
      const urlToken = parts.length === 2 ? parts[1] : parts[0];
      if (parts.length === 2 && !KNOWN_METHODS.has(parts[0].toUpperCase())) {
        fail(source, `endpoint '${entry}' carries unknown method '${parts[0]}'`);
      }
      if (parts.length > 2) {
        fail(
          source,
          `endpoint '${entry}' must be '<url>' or '<METHOD> <url>'`
        );
      }
      let parsed = null;
      try {
        parsed = new URL(urlToken);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        fail(source, `endpoint '${entry}' is not an http(s) URL`);
      }
    }
    config.endpoints = raw.endpoints.map((e) => e.trim());
  }
  return config;
}

/**
 * Read and validate a config file at an explicit path. Missing files
 * and bad JSON are ConfigErrors (an explicit path must exist and
 * parse — silently ignoring it would hide a typo'd path).
 */
export async function loadConfigFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config file '${path}': ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid JSON in config file '${path}': ${err.message}`);
  }
  return parseConfig(raw, `'${path}'`);
}

/**
 * Walk upward from `startDir` looking for x402-tester.json. Returns
 * the first path found, or null when no ancestor holds one.
 */
export async function findConfigFile(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // absent here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the effective config: an explicit path wins and must load;
 * otherwise auto-discover upward from `startDir`. Returns
 * `{ config, path }` with `path` null when no file was found.
 */
export async function resolveConfig({ explicitPath = null, startDir = process.cwd() } = {}) {
  if (explicitPath) {
    return { config: await loadConfigFile(explicitPath), path: explicitPath };
  }
  const path = await findConfigFile(startDir);
  if (!path) return { config: {}, path: null };
  return { config: await loadConfigFile(path), path };
}
