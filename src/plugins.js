/**
 * Custom check plugins: user-supplied check functions that run after
 * a successful handshake check.
 *
 * A plugin is a JavaScript file that default-exports either:
 *
 *   - a function:  export default function checkNetwork(ctx) { ... }
 *   - an object with a `check` function (and an optional `name`):
 *       export default { name: "only-base", check: (ctx) => { ... } };
 *
 * The check function receives one context object:
 *
 *   {
 *     url,            // the endpoint that was checked
 *     method,         // the HTTP method used for the handshake probe
 *     handshake,      // the full handshake report (see handshake.js)
 *     requirements,   // the first payment requirement from the 402 body
 *     price,          // the human-readable price string, if any
 *   }
 *
 * and returns one of:
 *
 *   - nothing / undefined / true            → the check passed
 *   - false                                 → failed ("check failed")
 *   - a string                              → failed, with that message
 *   - { ok: true }                          → passed
 *   - { ok: true, warning: "..." }          → passed, with a warning
 *     (a warning is appended to the report's warnings, so it fails
 *     the run under --ci strict mode, exactly like a built-in warning)
 *   - { ok: false, message: "..." }         → failed, with that message
 *     (`error` is accepted as an alias for `message`)
 *   - { warning: "..." }                    → passed, with a warning
 *     (no `ok` field needed when the only outcome is a warning)
 *   - { message: "..." } / { error: "..." } → failed, with that message
 *
 * A check that throws, returns a promise that rejects, or returns any
 * other shape does not crash the run: it becomes a failed plugin
 * result naming the plugin and the problem, so one broken plugin can
 * never hide the handshake result or the other plugins' results.
 *
 * Loading is fail-closed, by contrast: a plugin path that cannot be
 * imported, or a file that exports neither a function nor a
 * `{ check }` object, is a PluginError raised before any check runs —
 * a typo'd plugin path must never silently mean "no custom checks".
 *
 * Trust boundary: a plugin file is arbitrary code run with the same
 * privileges as the CLI itself. Only load files you wrote or trust,
 * never a plugin handed to you by an untrusted endpoint or stranger.
 */

import { resolve, parse } from "node:path";
import { pathToFileURL } from "node:url";

export class PluginError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginError";
  }
}

function fallbackName(filePath) {
  return parse(filePath).name || filePath;
}

/**
 * Normalise one plugin check's return value into a result object
 * `{ name, ok, message?, warning? }`. Throws a PluginError on a shape
 * the contract does not define — runPlugin turns that into a failed
 * result instead of letting it propagate.
 */
export function normalizePluginResult(raw, plugin) {
  const name = plugin.name;
  if (raw === undefined || raw === null || raw === true) {
    return { name, ok: true };
  }
  if (raw === false) {
    return { name, ok: false, message: "check failed" };
  }
  if (typeof raw === "string") {
    if (!raw.trim()) {
      throw new PluginError(
        `plugin '${name}' returned an empty string (expected a failure message, or nothing for a pass)`
      );
    }
    return { name, ok: false, message: raw };
  }
  if (typeof raw === "object") {
    const message =
      typeof raw.message === "string" && raw.message.trim()
        ? raw.message
        : typeof raw.error === "string" && raw.error.trim()
          ? raw.error
          : undefined;
    const warning =
      typeof raw.warning === "string" && raw.warning.trim()
        ? raw.warning
        : undefined;
    if (typeof raw.ok === "boolean") {
      const result = { name, ok: raw.ok };
      if (message) result.message = message;
      if (warning) result.warning = warning;
      if (!raw.ok && !message) result.message = "check failed";
      return result;
    }
    if (warning && !message) return { name, ok: true, warning };
    if (message) return { name, ok: false, message };
    throw new PluginError(
      `plugin '${name}' returned an object with neither 'ok', 'message', 'error', nor 'warning'`
    );
  }
  throw new PluginError(
    `plugin '${name}' returned an unsupported value (${typeof raw}); ` +
      `return nothing, a boolean, a string message, or a result object`
  );
}

/**
 * Load one plugin file. Relative paths resolve against the working
 * directory (so `--plugin ./my-check.mjs` and a config entry behave
 * the same wherever the CLI is invoked from). Throws PluginError on
 * an import failure or an export that is not a function / `{ check }`.
 */
export async function loadPlugin(pluginPath) {
  const resolved = resolve(pluginPath);
  let mod;
  try {
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new PluginError(
      `cannot load plugin '${pluginPath}': ${err.message}`
    );
  }
  const exported = mod.default !== undefined ? mod.default : mod;
  if (typeof exported === "function") {
    // An anonymous default export (`export default () => ...`) gets
    // the name "default" from the engine — that is not a useful
    // plugin name, so it falls back to the file stem like a nameless
    // object export does.
    const name =
      exported.name && exported.name !== "default"
        ? exported.name
        : fallbackName(resolved);
    return { path: resolved, name, check: exported };
  }
  if (
    exported !== null &&
    typeof exported === "object" &&
    typeof exported.check === "function"
  ) {
    const name =
      typeof exported.name === "string" && exported.name.trim()
        ? exported.name.trim()
        : fallbackName(resolved);
    return { path: resolved, name, check: exported.check };
  }
  throw new PluginError(
    `plugin '${pluginPath}' must default-export a function or an object ` +
      `with a 'check' function`
  );
}

/**
 * Load every plugin path in order, skipping exact duplicates (the
 * same file listed twice — e.g. once in config and once on the CLI —
 * runs once, not twice). Throws on the first unloadable plugin.
 */
export async function loadPlugins(pluginPaths) {
  const plugins = [];
  const seen = new Set();
  for (const pluginPath of pluginPaths || []) {
    const plugin = await loadPlugin(pluginPath);
    if (seen.has(plugin.path)) continue;
    seen.add(plugin.path);
    plugins.push(plugin);
  }
  return plugins;
}

/**
 * Run one plugin's check against the context. Execution failures
 * (throw, rejection, bad return shape) become a failed result, never
 * an exception — see the module header.
 */
export async function runPlugin(plugin, context) {
  try {
    const raw = await plugin.check(context);
    return normalizePluginResult(raw, plugin);
  } catch (err) {
    return {
      name: plugin.name,
      ok: false,
      message: `plugin error: ${err.message}`,
    };
  }
}

/**
 * Run every loaded plugin in order against the same context, and
 * return the results in that order. Sequential, like batch mode:
 * deterministic, and a slow plugin cannot starve the others of order.
 */
export async function runPlugins(plugins, context) {
  const results = [];
  for (const plugin of plugins || []) {
    results.push(await runPlugin(plugin, context));
  }
  return results;
}

/**
 * Fold plugin results into a handshake report. Plugin failures flip
 * `ok` to false; plugin warnings join the report's warnings (so
 * --ci strict mode fails on them, and CI annotations pick them up
 * via the warnings channel). Returns a new report object — the
 * original handshake report is left untouched.
 */
export function applyPluginResults(report, results) {
  const pluginResults = results || [];
  const warnings = [...(report.warnings || [])];
  for (const result of pluginResults) {
    if (result.warning) {
      warnings.push(`plugin ${result.name}: ${result.warning}`);
    }
  }
  return {
    ...report,
    ok: report.ok && pluginResults.every((r) => r.ok),
    warnings,
    plugins: pluginResults,
  };
}
