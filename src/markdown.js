/**
 * Markdown report export (`--report md`).
 *
 * Every command that prints a structured report (check, pay, e2e,
 * facilitator, x402scan) can render the same report object as Markdown
 * for pasting into issues, PRs, or docs. The renderer is generic: it
 * walks the report object, so new report fields show up with no extra
 * work. Scalar fields become a table, nested objects become
 * subsections, and arrays of objects become one subsection per item.
 * No private key material ever reaches a report object (see output.js),
 * so nothing here can leak it either.
 */

function cell(value) {
  const raw = typeof value === "bigint" ? value.toString() : String(value);
  // one line per cell: collapse newlines, escape table pipes
  const flat = raw.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  return flat.includes("`") ? flat : `\`${flat}\``;
}

function isScalar(value) {
  return (
    value === null ||
    ["string", "number", "boolean", "bigint"].includes(typeof value)
  );
}

/**
 * Render one object as a Markdown table plus subsections for its
 * nested values. `level` is the heading depth for subsections.
 */
function renderObject(obj, lines, level) {
  const scalars = Object.entries(obj).filter(
    ([, v]) => v !== undefined && isScalar(v)
  );
  if (scalars.length > 0) {
    lines.push("| field | value |", "| --- | --- |");
    for (const [key, value] of scalars) {
      lines.push(`| ${key} | ${cell(value)} |`);
    }
    lines.push("");
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || isScalar(value)) continue;
    const heading = "#".repeat(Math.min(level, 6));
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${heading} ${key}`, "", "_(none)_", "");
      } else if (value.every(isScalar)) {
        lines.push(`${heading} ${key}`, "");
        for (const item of value) lines.push(`- ${cell(item)}`);
        lines.push("");
      } else {
        value.forEach((item, i) => {
          lines.push(`${heading} ${key} ${i + 1}`, "");
          if (item !== null && typeof item === "object") {
            renderObject(item, lines, level + 1);
          } else {
            lines.push(`- ${cell(item)}`, "");
          }
        });
      }
    } else if (value !== null && typeof value === "object") {
      lines.push(`${heading} ${key}`, "");
      renderObject(value, lines, level + 1);
    }
  }
}

/**
 * Render a report object as Markdown. `title` heads the document; a
 * top-level boolean `ok` field also gets a pass/fail status line.
 */
export function toMarkdown(report, title = "x402-tester report") {
  const lines = [`# ${title}`, ""];
  if (report !== null && typeof report === "object") {
    if (typeof report.ok === "boolean") {
      lines.push(`**Status:** ${report.ok ? "✅ pass" : "❌ fail"}`, "");
    }
    renderObject(report, lines, 2);
  } else {
    lines.push(cell(report), "");
  }
  // trim trailing blank lines, but keep the body intact
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
