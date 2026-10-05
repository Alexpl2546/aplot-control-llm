import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const binary = process.argv[2] ?? process.env.LLAMA_SERVER_EXE;
const port = Number(process.argv[3] ?? 45888);
if (!binary) {
  throw new Error("Usage: node scripts/router-smoke.mjs <llama-server.exe> [port]");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Choose an unused local TCP port between 1024 and 65535.");
}

const host = "127.0.0.1";
const routeId = "llama-control-smoke-route";
const tempDir = await mkdtemp(join(tmpdir(), "llama-control-router-smoke-"));
const presetPath = join(tempDir, "router-presets.ini");
const apiKey = process.env.LLAMA_ROUTER_SMOKE_API_KEY || randomUUID().replaceAll("-", "");
await writeFile(presetPath, [
  "version = 1",
  "",
  "[*]",
  "load-on-startup = false",
  "metrics = true",
  "",
  `[${routeId}]`,
  "model = C:/llama-control-do-not-load.gguf",
  "",
].join("\n"));

const args = [
  "--models-preset", presetPath,
  "--models-max", "1",
  "--models-autoload",
  "--host", host,
  "--port", String(port),
  "--no-webui",
  "--metrics",
  "--log-verbosity", "4",
  "--log-colors", "off",
];
const child = spawn(binary, args, {
  cwd: join(binary, ".."),
  windowsHide: true,
  stdio: "ignore",
  env: { ...process.env, LLAMA_API_KEY: apiKey, LLAMA_CACHE: join(tempDir, "cache") },
});
let exited = false;
child.once("exit", () => { exited = true; });
child.once("error", () => { exited = true; });

async function stopChild() {
  if (exited || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }
}

try {
  const endpoint = `http://${host}:${port}`;
  const deadline = Date.now() + 30_000;
  let health;
  while (Date.now() < deadline && !exited) {
    try {
      health = await fetch(`${endpoint}/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  if (!health) throw new Error("Router did not bind to the selected local port within 30 seconds.");

  const models = await fetch(`${endpoint}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await models.text();
  const routeListed = body.includes(routeId);
  const [metrics, slots] = await Promise.all([
    fetch(`${endpoint}/metrics`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) }),
    fetch(`${endpoint}/slots`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) }),
  ]);
  const unauthenticated = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(5_000) });

  console.log(`Router PID: ${child.pid}`);
  console.log(`GET /health: HTTP ${health.status}`);
  console.log(`GET /metrics: HTTP ${metrics.status}`);
  console.log(`GET /slots: HTTP ${slots.status}`);
  console.log(`GET /v1/models: HTTP ${models.status}; route listed=${routeListed}`);
  console.log(`GET /v1/models without key: HTTP ${unauthenticated.status}`);
  console.log("No completion/model-load request was sent; preset points to a deliberately missing GGUF.");

  if (!models.ok || !routeListed) throw new Error(`Router did not expose the configured route: ${body}`);
} finally {
  await stopChild();
  await rm(tempDir, { recursive: true, force: true });
}
