import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const action = readFileSync(path.join(root, "action.yml"), "utf8");

const VALID_402 = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "base",
      payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amount: "20000",
      maxTimeoutSeconds: 60,
    },
  ],
};

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

// Run the exact command the action's check step runs (fail-on-warning
// on, so `--ci` is present), against a local endpoint.
async function runActionCommand(url, method = "GET") {
  return run(process.execPath, [
    path.join(root, "src/index.js"),
    "check",
    url,
    "--method",
    method,
    "--ci",
  ]);
}

test("action.yml is a composite action with a required endpoint input", () => {
  assert.match(action, /using:\s*composite/);
  assert.match(action, /endpoint:\s*\n\s*description:/);
  assert.match(action, /endpoint:[\s\S]*?required:\s*true/);
  assert.match(action, /method:[\s\S]*?default:\s*GET/);
  assert.match(action, /args:[\s\S]*?default:\s*""/);
  assert.match(action, /fail-on-warning:[\s\S]*?default:\s*"true"/);
  assert.match(action, /node-version:[\s\S]*?default:\s*"20"/);
});

test("action.yml pins setup-node and installs deps from its own checkout", () => {
  // Pinned, not floating: a floating major could change behaviour
  // under every consumer without a commit here.
  assert.match(action, /uses:\s*actions\/setup-node@v4/);
  assert.match(action, /npm ci --prefix "\$\{\{ github\.action_path \}\}"/);
  assert.match(
    action,
    /node "\$\{\{ github\.action_path \}\}\/src\/index\.js" check/
  );
  assert.ok(
    existsSync(path.join(root, "src/index.js")),
    "the entry point action.yml runs must exist"
  );
});

test("action.yml wires endpoint, method, args and --ci through to the CLI", () => {
  assert.match(action, /"\$\{\{ inputs\.endpoint \}\}"/);
  assert.match(action, /--method "\$\{\{ inputs\.method \}\}"/);
  assert.match(action, /\$\{\{ inputs\.args \}\}/);
  // --ci only when fail-on-warning is true; a plain `--ci` flag in
  // the run line would make the input a no-op.
  assert.match(
    action,
    /if \[ "\$\{\{ inputs\.fail-on-warning \}\}" = "true" \]; then\s*\n\s*FLAGS="--ci"/
  );
  assert.match(action, /\$FLAGS/);
});

test("action.yml reports the check outcome even when the check fails", () => {
  assert.match(action, /id:\s*check/);
  assert.match(action, /id:\s*result/);
  assert.match(action, /if:\s*always\(\)/);
  assert.match(action, /steps\.check\.outcome/);
  assert.match(action, /outputs:[\s\S]*?result:[\s\S]*?steps\.result\.outputs\.result/);
});

test("the action's check command passes a healthy endpoint", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(VALID_402));
  });
  try {
    const { stdout } = await runActionCommand(
      `http://127.0.0.1:${srv.address().port}/paid-api`
    );
    assert.match(stdout, /OK/);
  } finally {
    srv.close();
  }
});

test("the action's check command fails a non-402 endpoint", async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    await assert.rejects(runActionCommand(
      `http://127.0.0.1:${srv.address().port}/paid-api`
    ));
  } finally {
    srv.close();
  }
});
