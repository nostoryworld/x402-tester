/**
 * HTML report export (`--report html`).
 *
 * Every command that prints a structured report (check, pay, e2e,
 * facilitator, x402scan) can render the same report object as a
 * standalone HTML page for opening in a browser or attaching to a
 * run. The renderer is generic, mirroring markdown.js: it walks the
 * report object, so new report fields show up with no extra work.
 * Scalar fields become a table, nested objects become sections, and
 * arrays of objects become one section per item.
 *
 * The page is fully self-contained (inline CSS, no external assets)
 * and every value is HTML-escaped, so a hostile endpoint URL or
 * error string can never inject markup. No private key material ever
 * reaches a report object (see output.js), so nothing here can leak
 * it either.
 */

function escape(value) {
  const raw = typeof value === "bigint" ? value.toString() : String(value);
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isScalar(value) {
  return (
    value === null ||
    ["string", "number", "boolean", "bigint"].includes(typeof value)
  );
}

/**
 * Render one object as an HTML table plus sections for its nested
 * values. `level` is the heading depth for subsections (capped at 6).
 */
function renderObject(obj, parts, level) {
  const scalars = Object.entries(obj).filter(
    ([, v]) => v !== undefined && isScalar(v)
  );
  if (scalars.length > 0) {
    parts.push("<table><thead><tr><th>field</th><th>value</th></tr></thead><tbody>");
    for (const [key, value] of scalars) {
      parts.push(`<tr><td>${escape(key)}</td><td><code>${escape(value)}</code></td></tr>`);
    }
    parts.push("</tbody></table>");
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || isScalar(value)) continue;
    const tag = `h${Math.min(level, 6)}`;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push(`<${tag}>${escape(key)}</${tag}><p><em>none</em></p>`);
      } else if (value.every(isScalar)) {
        parts.push(`<${tag}>${escape(key)}</${tag}><ul>`);
        for (const item of value) parts.push(`<li><code>${escape(item)}</code></li>`);
        parts.push("</ul>");
      } else {
        value.forEach((item, i) => {
          parts.push(`<${tag}>${escape(key)} ${i + 1}</${tag}>`);
          if (item !== null && typeof item === "object") {
            renderObject(item, parts, level + 1);
          } else {
            parts.push(`<p><code>${escape(item)}</code></p>`);
          }
        });
      }
    } else if (value !== null && typeof value === "object") {
      parts.push(`<${tag}>${escape(key)}</${tag}>`);
      renderObject(value, parts, level + 1);
    }
  }
}

const STYLE = [
  "body{font-family:system-ui,-apple-system,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1f2937}",
  "h1{font-size:1.5rem;border-bottom:2px solid #e5e7eb;padding-bottom:.5rem}",
  "h2{font-size:1.25rem;margin-top:1.5rem}h3{font-size:1.1rem}h4{font-size:1rem}",
  "table{border-collapse:collapse;width:100%;margin:.5rem 0}",
  "th,td{border:1px solid #d1d5db;padding:.4rem .6rem;text-align:left;vertical-align:top}",
  "th{background:#f3f4f6}code{font-size:.9em;word-break:break-all}",
  ".status{display:inline-block;padding:.25rem .75rem;border-radius:9999px;font-weight:600}",
  ".pass{background:#dcfce7;color:#166534}.fail{background:#fee2e2;color:#991b1b}",
].join("\n");

/**
 * Render a report object as a standalone HTML document. `title`
 * heads the page; a top-level boolean `ok` field also gets a
 * pass/fail status badge.
 */
export function toHtml(report, title = "x402-tester report") {
  const parts = [];
  if (report !== null && typeof report === "object") {
    if (typeof report.ok === "boolean") {
      const cls = report.ok ? "pass" : "fail";
      const label = report.ok ? "✅ pass" : "❌ fail";
      parts.push(`<p><span class="status ${cls}">${label}</span></p>`);
    }
    renderObject(report, parts, 2);
  } else {
    parts.push(`<p><code>${escape(report)}</code></p>`);
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escape(title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    "</head>",
    "<body>",
    `<h1>${escape(title)}</h1>`,
    ...parts,
    "</body>",
    "</html>",
  ].join("\n");
}
