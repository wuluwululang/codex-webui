import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_SKILL_NAME = "codex-webui-token-manager";

export function resolveUserSkillsRoot(env = process.env, homeDir = os.homedir()) {
  const explicit = String(env.CODEX_WEBUI_SKILLS_DIR || "").trim();
  return explicit ? path.resolve(explicit) : path.join(homeDir, ".agents", "skills");
}

export function bundledSkillPath(repoRoot) {
  return path.join(path.resolve(repoRoot), ".agents", "skills", MANAGED_SKILL_NAME);
}

export function skillInstallRecordPath(dataDir) {
  return path.join(path.resolve(dataDir), "skill-install.json");
}

export function installBundledSkill({
  repoRoot,
  dataDir,
  skillsRoot = resolveUserSkillsRoot(),
  force = false
}) {
  const sourceDir = bundledSkillPath(repoRoot);
  const destinationDir = path.join(path.resolve(skillsRoot), MANAGED_SKILL_NAME);
  if (!existsSync(path.join(sourceDir, "SKILL.md"))) {
    throw new Error(`Bundled skill is missing: ${sourceDir}`);
  }

  const record = readInstallRecord(dataDir);
  const managedDestination = record && samePath(record.destinationDir, destinationDir);
  let status = "installed";

  if (existsSync(destinationDir)) {
    const destinationStat = lstatSync(destinationDir);
    if (destinationStat.isSymbolicLink()) {
      if (samePath(realpathSync(destinationDir), sourceDir)) {
        writeInstallRecord(dataDir, { repoRoot, sourceDir, destinationDir, mode: "symlink" });
        return { status: "linked", sourceDir, destinationDir };
      }
      throw new Error(`Refusing to replace an unrelated skill symlink: ${destinationDir}`);
    }
    if (!destinationStat.isDirectory()) {
      throw new Error(`Skill destination is not a directory: ${destinationDir}`);
    }
    if (!managedDestination && !skillFilesMatch(sourceDir, destinationDir) && !force) {
      throw new Error(
        `An unmanaged ${MANAGED_SKILL_NAME} skill already exists at ${destinationDir}. `
        + "Move it aside or set CODEX_WEBUI_FORCE_SKILL_INSTALL=1 to replace matching files."
      );
    }
    status = managedDestination ? "updated" : "adopted";
  }

  mkdirSync(destinationDir, { recursive: true });
  copySkillFiles(sourceDir, destinationDir);
  writeFileSync(
    path.join(destinationDir, "install.json"),
    `${JSON.stringify({ version: 1, repoRoot: path.resolve(repoRoot) }, null, 2)}\n`,
    "utf8"
  );
  writeInstallRecord(dataDir, { repoRoot, sourceDir, destinationDir, mode: "copy" });
  return { status, sourceDir, destinationDir };
}

function copySkillFiles(sourceDir, destinationDir) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a symlink inside the skill: ${destination}`);
    }
    if (entry.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      copySkillFiles(source, destination);
    } else if (entry.isFile()) {
      cpSync(source, destination, { force: true });
    }
  }
}

function skillFilesMatch(sourceDir, destinationDir) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (!existsSync(destination)) return false;
    const destinationStat = lstatSync(destination);
    if (destinationStat.isSymbolicLink()) return false;
    if (entry.isDirectory()) {
      if (!destinationStat.isDirectory() || !skillFilesMatch(source, destination)) return false;
    } else if (entry.isFile()) {
      if (!destinationStat.isFile() || fileHash(source) !== fileHash(destination)) return false;
    }
  }
  return true;
}

function fileHash(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readInstallRecord(dataDir) {
  try {
    return JSON.parse(readFileSync(skillInstallRecordPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeInstallRecord(dataDir, detail) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    skillInstallRecordPath(dataDir),
    `${JSON.stringify({
      version: 1,
      skill: MANAGED_SKILL_NAME,
      repoRoot: path.resolve(detail.repoRoot),
      sourceDir: path.resolve(detail.sourceDir),
      destinationDir: path.resolve(detail.destinationDir),
      mode: detail.mode,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

function samePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
