#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTokenStore, resolveDataDir, tokenStorePath } from "../server/token-store.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node.js 20 or newer is required. Current: ${process.version}`);
  process.exit(1);
}

const codex = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex.cmd --version"], { encoding: "utf8" })
  : spawnSync("codex", ["--version"], { encoding: "utf8" });
if (codex.error || codex.status !== 0) {
  console.warn("Warning: Codex CLI was not found on PATH. The desktop app bundled binary may still be detected on Windows.");
} else {
  console.log(`Codex: ${(codex.stdout || codex.stderr).trim()}`);
}

const dataDir = resolveDataDir();
const store = readTokenStore(dataDir);
const cli = installCliCommand();
if (cli.error || cli.status !== 0) {
  console.error("Unable to install the global codex-webui command.");
  console.error((cli.stderr || cli.error?.message || "npm link failed").trim());
  process.exit(1);
}
console.log(`Data directory: ${dataDir}`);
console.log(`Token store: ${tokenStorePath(dataDir)}`);
console.log(`Enabled tokens: ${store.tokens.filter((entry) => !entry.disabled).length}`);
console.log("Command installed: codex-webui");
console.log("Global skill: not installed (run npm run skill:install to opt in).");
console.log(`Codex WebUI project folder: ${repoRoot}`);
console.log("Setup does not register a Codex local project. Open this folder in the Codex desktop app with Ctrl+O.");
console.log("Setup complete. Run npm start and scan the terminal QR code.");

function installCliCommand() {
  const options = { cwd: repoRoot, encoding: "utf8" };
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  if (npmExecPath) {
    return spawnSync(process.execPath, [npmExecPath, "link", "--silent"], options);
  }
  if (process.platform === "win32") {
    return spawnSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "npm.cmd link --silent"],
      options
    );
  }
  return spawnSync("npm", ["link", "--silent"], options);
}
