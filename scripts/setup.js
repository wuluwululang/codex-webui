#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installBundledSkill, resolveUserSkillsRoot } from "../server/skill-install.js";
import { readTokenStore, resolveDataDir, tokenStorePath } from "../server/token-store.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

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
const skill = installBundledSkill({
  repoRoot,
  dataDir,
  skillsRoot: resolveUserSkillsRoot(),
  force: process.env.CODEX_MOBILE_FORCE_SKILL_INSTALL === "1"
});
console.log(`Data directory: ${dataDir}`);
console.log(`Token store: ${tokenStorePath(dataDir)}`);
console.log(`Enabled tokens: ${store.tokens.filter((entry) => !entry.disabled).length}`);
console.log(`Skill ${skill.status}: ${skill.destinationDir}`);
console.log("Codex detects skill changes automatically. Restart Codex if it does not appear.");
console.log(`Codex project folder: ${repoRoot}`);
console.log("Setup does not register a Codex local project. Open this folder in the Codex desktop app with Ctrl+O.");
console.log("Setup complete. Run npm start and scan the terminal QR code.");
