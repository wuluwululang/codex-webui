#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installBundledSkill, resolveUserSkillsRoot } from "../server/skill-install.js";
import { resolveDataDir } from "../server/token-store.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const result = installBundledSkill({
  repoRoot,
  dataDir: resolveDataDir(),
  skillsRoot: resolveUserSkillsRoot(),
  force: process.env.CODEX_MOBILE_FORCE_SKILL_INSTALL === "1"
});

console.log(`Skill ${result.status}: ${result.destinationDir}`);
console.log("Codex detects skill changes automatically. Restart Codex if it does not appear.");
