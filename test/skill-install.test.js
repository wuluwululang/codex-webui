import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installBundledSkill, MANAGED_SKILL_NAME } from "../server/skill-install.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

function temporaryRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-webui-skill-test-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("installs the bundled skill globally and runs its token wrapper from another cwd", () => {
  const root = temporaryRoot();
  const dataDir = path.join(root, "data");
  const skillsRoot = path.join(root, "home", ".agents", "skills");
  const result = installBundledSkill({ repoRoot, dataDir, skillsRoot });
  assert.equal(result.status, "installed");
  assert.equal(existsSync(path.join(result.destinationDir, "SKILL.md")), true);
  const install = JSON.parse(readFileSync(path.join(result.destinationDir, "install.json"), "utf8"));
  assert.equal(path.resolve(install.repoRoot), repoRoot);

  const tokenDataDir = path.join(root, "token-data");
  const wrapper = path.join(result.destinationDir, "scripts", "token.js");
  const invoked = spawnSync(process.execPath, [wrapper, "list", "--json"], {
    cwd: root,
    env: { ...process.env, CODEX_WEBUI_DATA_DIR: tokenDataDir },
    encoding: "utf8"
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  const tokens = JSON.parse(invoked.stdout);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].id, "default");

  const updated = installBundledSkill({ repoRoot, dataDir, skillsRoot });
  assert.equal(updated.status, "updated");
});

test("refuses to overwrite an unmanaged skill with the same name", () => {
  const root = temporaryRoot();
  const dataDir = path.join(root, "data");
  const skillsRoot = path.join(root, "skills");
  const destination = path.join(skillsRoot, MANAGED_SKILL_NAME);
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, "SKILL.md"), "unmanaged\n", "utf8");
  assert.throws(
    () => installBundledSkill({ repoRoot, dataDir, skillsRoot }),
    /unmanaged codex-webui-token-manager skill already exists/
  );
});

test("setup installs codex-webui without installing the user skill", () => {
  const root = temporaryRoot();
  const dataDir = path.join(root, "data");
  const skillsRoot = path.join(root, "skills");
  const npmPrefix = path.join(root, "npm-prefix");
  const setup = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "setup.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_WEBUI_SKILLS_DIR: skillsRoot,
      NPM_CONFIG_PREFIX: npmPrefix
    },
    encoding: "utf8"
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Command installed: codex-webui/);
  assert.match(setup.stdout, /Global skill: not installed/);
  assert.equal(existsSync(path.join(skillsRoot, MANAGED_SKILL_NAME, "SKILL.md")), false);
  const commandPath = process.platform === "win32"
    ? path.join(npmPrefix, "codex-webui.cmd")
    : path.join(npmPrefix, "bin", "codex-webui");
  assert.equal(existsSync(commandPath), true);
  const legacyCommandName = ["codex", "m"].join("");
  const legacyCommandPath = process.platform === "win32"
    ? path.join(npmPrefix, `${legacyCommandName}.cmd`)
    : path.join(npmPrefix, "bin", legacyCommandName);
  assert.equal(existsSync(legacyCommandPath), false);
});

test("skill install command opts into the user skill", () => {
  const root = temporaryRoot();
  const dataDir = path.join(root, "data");
  const skillsRoot = path.join(root, "skills");
  const install = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "install-skill.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_WEBUI_SKILLS_DIR: skillsRoot
    },
    encoding: "utf8"
  });
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Skill installed:/);
  assert.equal(existsSync(path.join(skillsRoot, MANAGED_SKILL_NAME, "SKILL.md")), true);
});

test("codex-webui runs token commands from another project directory", () => {
  const root = temporaryRoot();
  const tokenDataDir = path.join(root, "token-data");
  const invoked = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "codex-webui.js"), "list", "--json"], {
    cwd: root,
    env: { ...process.env, CODEX_WEBUI_DATA_DIR: tokenDataDir },
    encoding: "utf8"
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  const tokens = JSON.parse(invoked.stdout);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].id, "default");
});
