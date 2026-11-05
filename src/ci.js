/**
 * CI mode: strict exit codes plus GitHub Actions annotations (`--ci`).
 *
 * A plain `check` already exits 1 on failure, but CI needs two more
 * things. First, warnings must be able to fail a run: a dust- or
 * whale-priced endpoint passes the handshake yet should not pass a
 * deploy gate, so in CI mode any warning in the report turns the
 * exit code to 1 even when the check itself passed ("strict"). Second,
 * failures must surface where CI looks: each failure and warning is
 * also emitted as a GitHub Actions workflow command
 * (`::error::…` / `::warning::…`) so it appears as an annotation on
 * the run instead of buried in log text.
 *
 * Annotations always go to stderr, never stdout. That keeps
 * `--json` output parseable when piped to jq in a CI step — the JSON
 * on stdout is untouched, the annotations ride along on stderr, and
 * GitHub parses workflow commands from both streams.
 *
 * This module is pure except for `emitCiAnnotations`, which takes an
 * injectable `write` so tests never touch the real stderr. It knows
 * every report shape the CLI produces (single check, batch, compare,
 * benchmark, end-to-end steps, schema errors, facilitator reachability,
 * discovery listings) and derives pass/fail from the report itself, so
 * the CLI cannot accidentally report one verdict in text and another to CI.
 */

const LEVELS = new Set(["error", "warning", "notice"]);

/**
 * Escape a workflow-command message: % first (so later replacements
 * are not re-escaped), then carriage returns and newlines. A raw
 * newline inside an annotation would split it into two log lines and
 * GitHub would only parse the first.
 */
export function escapeAnnotationData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Escape a workflow-command property value: the data escapes plus
 * `:` and `,` (both delimit properties in the `::level k=v,k=v::`
 * prefix, so a raw one would corrupt the annotation).
 */
export function escapeAnnotationProperty(value) {
  return escapeAnnotationData(value)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/**
 * Format one GitHub Actions workflow command, e.g.
 * `::error title=x402-tester::handshake failed` or
 * `::warning::price sanity: …`. Throws on an unknown level so a typo
 * never emits a line GitHub silently ignores.
 */
export function formatAnnotation(level, message, { title, file, line, endLine } = {}) {
  if (!LEVELS.has(level)) {
    throw new Error(`unknown annotation level '${level}' (expected error, warning, or notice)`);
  }
  const props = [];
  if (file !== undefined) props.push(`file=${escapeAnnotationProperty(file)}`);
  if (line !== undefined) props.push(`line=${escapeAnnotationProperty(line)}`);
  if (endLine !== undefined) props.push(`endLine=${escapeAnnotationProperty(endLine)}`);
  if (title !== undefined) props.push(`title=${escapeAnnotationProperty(title)}`);
  const prefix = props.length > 0 ? ` ${props.join(",")}` : "";
  return `::${level}${prefix}::${escapeAnnotationData(message)}`;
}

/**
 * Derive pass/fail from a report, whatever its shape. `ok` wins when
 * present; facilitator reports carry `reachable`, discovery reports
 * carry `listed`, end-to-end reports carry per-step `ok` flags.
 * A report with no failure signal at all counts as passed — inventing
 * a failure for an unknown shape would fail CI runs for no reason.
 */
export function reportPassed(report) {
  if (!report || typeof report !== "object") return false;
  if (typeof report.ok === "boolean") return report.ok;
  if (typeof report.reachable === "boolean") return report.reachable;
  if (typeof report.listed === "boolean") return report.listed;
  if (Array.isArray(report.steps)) {
    return report.steps.length > 0 && report.steps.every((s) => s.ok);
  }
  if (Array.isArray(report.results)) {
    return report.results.length > 0 && report.results.every((r) => r.ok);
  }
  return true;
}

/**
 * True when the report carries any warning — a top-level `warnings`
 * array, warnings inside batch results, or differences in a compare
 * report (a staging/production drift is a warning, so --ci fails the
 * run on it like any other warning). Other report shapes have no
 * warning channel, so they never trigger strict mode.
 */
export function hasWarnings(report) {
  if (!report || typeof report !== "object") return false;
  if (Array.isArray(report.warnings) && report.warnings.length > 0) return true;
  if (Array.isArray(report.differences) && report.differences.length > 0) return true;
  if (Array.isArray(report.results)) {
    return report.results.some(
      (r) => Array.isArray(r.warnings) && r.warnings.length > 0
    );
  }
  return false;
}

function withUrl(url, message) {
  return url ? `${url}: ${message}` : message;
}

/**
 * Collect the annotations for a report: one `error` per failure and
 * one `warning` per warning, in report order. A passing report yields
 * only its warnings (which is exactly what strict mode then fails on);
 * a report with no failures and no warnings yields nothing. Returns
 * annotation objects `{ level, message, title }` — formatting is
 * `formatAnnotation`'s job, so callers can filter or re-render.
 */
export function collectAnnotations(report, { command } = {}) {
  const title = command ? `x402-tester ${command}` : "x402-tester";
  const annotations = [];
  if (!report || typeof report !== "object") return annotations;

  // Batch: one annotation per result, so a failing entry is visible
  // without opening the full report.
  if (Array.isArray(report.results)) {
    for (const result of report.results) {
      if (!result.ok) {
        annotations.push({
          level: "error",
          message: withUrl(result.url, result.error || "check failed"),
          title,
        });
      }
      for (const w of result.warnings || []) {
        annotations.push({
          level: "warning",
          message: withUrl(result.url, w),
          title,
        });
      }
    }
    return annotations;
  }

  // End-to-end: one annotation per failed step; the step detail
  // already says what went wrong, so it is the message.
  if (Array.isArray(report.steps)) {
    for (const step of report.steps) {
      if (!step.ok) {
        annotations.push({
          level: "error",
          message: `${step.name}: ${step.detail || "step failed"}`,
          title,
        });
      }
    }
    return annotations;
  }

  // Benchmark: one annotation per failed probe.
  if (Array.isArray(report.failures)) {
    for (const failure of report.failures) {
      annotations.push({
        level: "error",
        message: `probe ${failure.probe} failed: ${failure.error || "probe failed"}`,
        title,
      });
    }
    if (annotations.length === 0 && !reportPassed(report)) {
      annotations.push({ level: "error", message: "benchmark failed", title });
    }
    return annotations;
  }

  // Schema validation: one annotation per mismatched field.
  if (Array.isArray(report.errors)) {
    for (const err of report.errors) {
      const detail = err.path ? `${err.path}: ${err.message}` : err.message;
      annotations.push({
        level: "error",
        message: withUrl(report.file, detail),
        title,
      });
    }
    return annotations;
  }

  // Compare: one error per failing side, one warning per differing
  // payment term. A difference is a warning so --ci fails the run on
  // staging/production drift, like any other warning. The "handshake"
  // difference entry is the failure itself, already reported as an
  // error above, so it is not also warned about.
  if (Array.isArray(report.differences) && report.a && report.b) {
    for (const [side, url] of [
      ["a", report.urlA],
      ["b", report.urlB],
    ]) {
      const sideReport = report[side];
      if (!sideReport.ok) {
        annotations.push({
          level: "error",
          message: withUrl(url, sideReport.error || "handshake failed"),
          title,
        });
      }
    }
    for (const d of report.differences) {
      if (d.field === "handshake") continue;
      annotations.push({
        level: "warning",
        message: `${d.field}: ${d.a ?? "(not set)"} vs ${d.b ?? "(not set)"}`,
        title,
      });
    }
    return annotations;
  }

  // Plugin failures: one error per failed plugin, so the annotation
  // names the plugin. When a plugin failure is the only failure (the
  // handshake itself passed, so there is no error/diagnosis), it
  // replaces the generic "check failed" line rather than doubling it.
  const pluginFailures = Array.isArray(report.plugins)
    ? report.plugins.filter((p) => !p.ok)
    : [];
  if (!reportPassed(report) && (report.error || report.diagnosis || pluginFailures.length === 0)) {
    const detail = report.error || report.diagnosis || "check failed";
    annotations.push({
      level: "error",
      message: withUrl(report.url, detail),
      title,
    });
  }
  for (const plugin of pluginFailures) {
    annotations.push({
      level: "error",
      message: withUrl(
        report.url,
        `plugin ${plugin.name}: ${plugin.message || "check failed"}`
      ),
      title,
    });
  }
  for (const w of report.warnings || []) {
    annotations.push({
      level: "warning",
      message: withUrl(report.url, w),
      title,
    });
  }
  return annotations;
}

/**
 * The exit code for a report. Without CI mode this is just pass/fail;
 * with CI mode a passing report that carries warnings also exits 1
 * (strict), so a dust-priced endpoint cannot slip through a gate.
 */
export function ciExitCode(report, { ci = false } = {}) {
  if (!reportPassed(report)) return 1;
  if (ci && hasWarnings(report)) return 1;
  return 0;
}

/**
 * Emit a report's annotations (stderr by default, so `--json` output
 * on stdout stays parseable). Returns the annotation objects, so
 * callers and tests can see what was emitted without reading stderr.
 */
export function emitCiAnnotations(
  report,
  { command, write = (line) => process.stderr.write(`${line}\n`) } = {}
) {
  const annotations = collectAnnotations(report, { command });
  for (const a of annotations) {
    write(formatAnnotation(a.level, a.message, { title: a.title }));
  }
  return annotations;
}
