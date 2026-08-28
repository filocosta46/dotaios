import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNativeLaunch,
  runSetupPreview,
  validateOwnedProfile,
} from "../../scripts/onboarding-host-probe.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("native launch uses an owned profile, stdin prompt, explicit executable, and allowlisted environment", (t) => {
  const fixture = hostFixture(t);
  const prompt = "Use the global DotAIOS bridge; explain and propose before acting.";
  process.env.DOTAIOS_TEST_SECRET_CANARY = "sk-host-canary-never-in-launch";
  t.after(() => delete process.env.DOTAIOS_TEST_SECRET_CANARY);

  for (const client of ["codex", "claude"]) {
    const launch = buildNativeLaunch({
      client,
      executable: process.execPath,
      profileRoot: fixture.profileRoot,
      workRoot: fixture.workRoot,
      prompt,
    });
    assert.equal(launch.executable, fs.realpathSync(process.execPath));
    assert.equal(launch.stdin, prompt);
    assert.equal(JSON.stringify(launch.args).includes(prompt), false);
    assert.equal(JSON.stringify(launch).includes("sk-host-canary"), false);
    assert.equal(launch.cwd, fs.realpathSync(fixture.workRoot));
    assert.equal(launch.env.HOME, fs.realpathSync(fixture.profileRoot));
    assert.equal(launch.env.USERPROFILE, fs.realpathSync(fixture.profileRoot));
    assert.equal(launch.env.PATH, path.dirname(fs.realpathSync(process.execPath)));
    assert.equal(Object.hasOwn(launch.env, "DOTAIOS_TEST_SECRET_CANARY"), false);
    assert.equal(Object.hasOwn(launch, "receiptCommand"), false);
  }
});

test("profile admission refuses ambient, permissive, linked, or escaped credential roots", (t) => {
  const fixture = hostFixture(t);
  const credentials = path.join(fixture.profileRoot, "credentials.json");
  fs.writeFileSync(credentials, "synthetic-login-marker\n", { mode: 0o600 });
  assert.doesNotThrow(() => validateOwnedProfile({
    ...fixture,
    credentialPaths: [credentials],
    requireAuthenticated: true,
  }));

  const ambientRun = path.join(fixture.ambientHome, "run");
  const ambientProfile = path.join(ambientRun, "profile");
  fs.mkdirSync(ambientProfile, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(ambientRun, 0o700);
    fs.chmodSync(ambientProfile, 0o700);
  }
  assert.throws(() => validateOwnedProfile({
    ...fixture,
    runRoot: ambientRun,
    profileRoot: ambientProfile,
  }), /ambient home|outside/i);

  if (process.platform !== "win32") {
    fs.chmodSync(fixture.profileRoot, 0o755);
    assert.throws(() => validateOwnedProfile(fixture), /private|0700|permissions/i);
    fs.chmodSync(fixture.profileRoot, 0o700);
  }

  const linkedProfile = path.join(fixture.root, "linked-profile");
  fs.symlinkSync(fixture.profileRoot, linkedProfile, "dir");
  assert.throws(() => validateOwnedProfile({ ...fixture, profileRoot: linkedProfile }), /link|profile/i);

  const escapedCredential = path.join(fixture.root, "escaped-credential.json");
  fs.writeFileSync(escapedCredential, "synthetic\n", { mode: 0o600 });
  assert.throws(() => validateOwnedProfile({
    ...fixture,
    credentialPaths: [escapedCredential],
    requireAuthenticated: true,
  }), /credential|profile/i);
});

test("setup preview changes neither declared roots nor protected homes", (t) => {
  const fixture = hostFixture(t);
  const protectedHome = path.join(fixture.root, "real-client-home");
  fs.mkdirSync(path.join(protectedHome, ".codex"), { recursive: true });
  const canary = "ghp_protected_home_canary_123456789";
  fs.writeFileSync(path.join(protectedHome, ".codex", "auth.json"), canary);
  const aiosRoot = path.join(fixture.runRoot, "aios-preview");

  const result = runSetupPreview({
    cliEntrypoint: cli,
    runRoot: fixture.runRoot,
    profileRoot: fixture.profileRoot,
    aiosRoot,
    protectedRoots: [fixture.ambientHome, protectedHome],
  });

  assert.deepEqual(result, {
    setup_preview: "yes",
    protected_roots_unchanged: "yes",
    preview_sha256: result.preview_sha256,
  });
  assert.match(result.preview_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(aiosRoot), false);
  assert.equal(fs.readFileSync(path.join(protectedHome, ".codex", "auth.json"), "utf8"), canary);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(result).includes(protectedHome), false);
});

function hostFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-host-probe-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runRoot = path.join(root, "owned-run");
  const profileRoot = path.join(runRoot, "profile");
  const workRoot = path.join(runRoot, "external-work");
  const ambientHome = path.join(root, "ambient-home");
  const repoBoundary = path.join(root, "repository");
  for (const directory of [runRoot, profileRoot, workRoot, ambientHome, repoBoundary]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }
  return { root, runRoot, profileRoot, workRoot, ambientHome, repoBoundary };
}
