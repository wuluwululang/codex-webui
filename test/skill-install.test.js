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
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-mobile-skill-test-"));
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
    env: { ...process.env, CODEX_MOBILE_DATA_DIR: tokenDataDir },
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
    /unmanaged codex-mobile-token-manager skill already exists/
  );
});

test("setup command installs the user skill automatically", () => {
  const root = temporaryRoot();
  const dataDir = path.join(root, "data");
  const skillsRoot = path.join(root, "skills");
  const setup = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "setup.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_MOBILE_DATA_DIR: dataDir,
      CODEX_MOBILE_SKILLS_DIR: skillsRoot
    },
    encoding: "utf8"
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Skill installed:/);
  assert.equal(existsSync(path.join(skillsRoot, MANAGED_SKILL_NAME, "SKILL.md")), true);
});
