#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installPath = path.join(skillDir, "install.json");
let repoRoot = path.resolve(skillDir, "..", "..", "..");

if (existsSync(installPath)) {
  const install = JSON.parse(readFileSync(installPath, "utf8"));
  repoRoot = path.resolve(String(install.repoRoot || ""));
}

const tokenManager = path.join(repoRoot, "scripts", "token-manager.js");
if (!existsSync(tokenManager)) {
  console.error(`Codex WebUI token manager was not found at ${tokenManager}. Re-run npm run setup in the repository.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [tokenManager, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit"
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
