#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readTokenStore, resolveDataDir, tokenStorePath } from "../server/token-store.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node.js 20 or newer is required. Current: ${process.version}`);
  process.exit(1);
}

const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";
const codex = spawnSync(codexCommand, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (codex.error || codex.status !== 0) {
  console.warn("Warning: Codex CLI was not found on PATH. The desktop app bundled binary may still be detected on Windows.");
} else {
  console.log(`Codex: ${(codex.stdout || codex.stderr).trim()}`);
}

const dataDir = resolveDataDir();
const store = readTokenStore(dataDir);
console.log(`Data directory: ${dataDir}`);
console.log(`Token store: ${tokenStorePath(dataDir)}`);
console.log(`Enabled tokens: ${store.tokens.filter((entry) => !entry.disabled).length}`);
console.log("Setup complete. Run npm start and scan the terminal QR code.");
