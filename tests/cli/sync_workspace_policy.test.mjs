import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { createGit } from "../../packages/cli/src/sync/git.mjs";
import { findSensitiveMirrorPaths } from "../../packages/cli/src/sync/mirror-content-policy.mjs";
import { initialMirrorPush } from "../../packages/cli/src/sync/repo.mjs";

const run = promisify(execFile);

test("the managed sync ignore template carries the portable privacy contract", async () => {
  for (const name of ["sync-gitignore.template", "gitignore.template"]) {
    const template = await fs.readFile(new URL(`../../templates/${name}`, import.meta.url), "utf8");
    assert.match(template, /^\/workspaces\/$/m);
    assert.match(template, /^\/\.dotaios\/session-store\/$/m);
    if (name === "sync-gitignore.template") {
      assert.match(template, /^credentials\.\*$/m);
      assert.match(template, /^token\.\*$/m);
      assert.match(template, /^!\.env\.example$/m);
    }
  }
});

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

async function makeAios(t, { gitignore = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-workspace-policy-"));
  const aios = path.join(root, "aios");
  await fs.mkdir(aios, { recursive: true });
  await git(aios, "init", "-q", "-b", "main");
  await git(aios, "config", "user.email", "t@example.com");
  await git(aios, "config", "user.name", "Test");
  await fs.writeFile(path.join(aios, ".gitignore"), gitignore);
  await fs.writeFile(path.join(aios, "aios.json"), '{"schema_version":"1.2.0"}\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return aios;
}

async function makeWorkspace(aios, slug, remote = "https://github.com/acme/widget.git") {
  const workspace = path.join(aios, "workspaces", slug);
  await fs.mkdir(workspace, { recursive: true });
  await git(workspace, "init", "-q", "-b", "main");
  await git(workspace, "config", "user.email", "t@example.com");
  await git(workspace, "config", "user.name", "Test");
  await fs.writeFile(path.join(workspace, "README.md"), `# ${slug}\n`);
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "initial");
  await git(workspace, "remote", "add", "origin", remote);
  return workspace;
}

async function registerProject(
  aios,
  slug,
  repoUrl = "https://github.com/acme/widget.git",
  { id = `id-${slug}` } = {}
) {
  const project = path.join(aios, "projects", slug);
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "README.md"),
    `---\n${id ? `id: ${id}\n` : ""}project: ${slug}\nrepo_url: ${repoUrl}\nstatus: active\n---\n# ${slug}\n`
  );
}

test("mirror validation refuses when /workspaces/ is not effectively ignored", async (t) => {
  const aios = await makeAios(t, { gitignore: "node_modules/\n" });

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    (error) => /workspaces.*root.*ignore/i.test(error.message)
      && error.message.includes(`dotaios migrate --path ${JSON.stringify(aios)}`)
  );
});

test("mirror validation refuses every outer-index entry under workspaces", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  const indexed = path.join(aios, "workspaces", "alpha", "tracked.txt");
  await fs.mkdir(path.dirname(indexed), { recursive: true });
  await fs.writeFile(indexed, "must stay out of the mirror\n");
  await git(aios, "add", "-f", "workspaces/alpha/tracked.txt");

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    (error) => /outer Git index/i.test(error.message)
      && /workspaces\/alpha\/tracked\.txt/i.test(error.message)
  );
});

test("mirror validation refuses sensitive files even when ignore rules were weakened", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  await fs.writeFile(path.join(aios, ".env"), "SECRET=must-not-sync\n");

  const syncGit = createGit({
    cwd: aios,
    env: { ...process.env, HOME: path.dirname(aios) }
  });
  await assert.rejects(
    () => syncGit.commitAll("must refuse secret"),
    (error) => /private or regenerable local files/i.test(error.message)
      && error.message.includes(".env")
  );

  const indexed = (await git(aios, "ls-files", "--", ".env")).stdout;
  assert.equal(indexed, "", "the sensitive path must be refused before git add");
});

test("commitAll refuses credentials.* and token.* aliases without changing HEAD, index, or files", async (t) => {
  for (const relative of [
    "credentials.json",
    "token.json",
    "connections/custom/Credentials.backup",
    "vault/private/TOKEN.production"
  ]) {
    await t.test(relative, async (t) => {
      const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
      await git(aios, "add", ".gitignore", "aios.json");
      await git(aios, "commit", "-q", "-m", "safe mirror");
      const secretPath = path.join(aios, ...relative.split("/"));
      await fs.mkdir(path.dirname(secretPath), { recursive: true });
      await fs.writeFile(secretPath, "private-secret\n");
      const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
      const indexPath = path.join(aios, ".git", "index");
      const beforeIndex = await fs.readFile(indexPath);

      await assert.rejects(
        createGit({ cwd: aios }).commitAll("must refuse secret prefix"),
        (error) => /private or regenerable local files/i.test(error.message)
          && error.message.includes(relative)
      );

      assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
      assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
      assert.equal(await fs.readFile(secretPath, "utf8"), "private-secret\n");
      assert.equal((await git(aios, "ls-files", "--", relative)).stdout.trim(), "");
    });
  }
});

test("mirror validation refuses transient migration state", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  const transient = path.join(aios, ".dotaios", "migrations", "transactions", "plan", "journal.json");
  await fs.mkdir(path.dirname(transient), { recursive: true });
  await fs.writeFile(transient, '{"status":"prepared"}\n');

  await assert.rejects(
    () => createGit({ cwd: aios }).commitAll("must refuse transaction state"),
    (error) => /private or regenerable local files/i.test(error.message)
      && error.message.includes(".dotaios/migrations/transactions")
  );
  assert.equal(
    (await git(aios, "ls-files", "--", ".dotaios/migrations/transactions")).stdout,
    ""
  );
});

test("mirror validation excludes SessionStore operational state and refuses forced or case aliases", async (t) => {
  const aios = await makeAios(t, {
    gitignore: "/workspaces/\n/.dotaios/session-store/\n",
  });
  const manifest = path.join(
    aios,
    ".dotaios",
    "session-store",
    "pending",
    "tx-1",
    "manifest.json",
  );
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, '{"format":"dotaios-session-store-transaction/v1"}\n');

  const sha = await createGit({ cwd: aios }).commitAll("mirror without operational state");
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal((await git(aios, "ls-files", "--", ".dotaios/session-store")).stdout, "");
  assert.equal(await fs.readFile(manifest, "utf8"), '{"format":"dotaios-session-store-transaction/v1"}\n');

  await git(aios, "add", "-f", "--", ".dotaios/session-store/pending/tx-1/manifest.json");
  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    (error) => /private or regenerable local files/i.test(error.message)
      && error.message.includes(".dotaios/session-store"),
  );
  assert.deepEqual(
    findSensitiveMirrorPaths([".DotAIOS/Session-Store/private/manifest.json"]),
    [".DotAIOS/Session-Store/private/manifest.json"],
  );
  assert.equal(await fs.readFile(manifest, "utf8"), '{"format":"dotaios-session-store-transaction/v1"}\n');
});

test("an established mirror excludes untracked SessionStore state even before its ignore template is refreshed", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  const manifest = path.join(aios, ".dotaios", "session-store", "pending", "manifest.json");
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, '{"format":"dotaios-session-store-transaction/v1"}\n');
  await fs.writeFile(path.join(aios, "portable-note.md"), "portable\n");

  const sha = await createGit({ cwd: aios }).commitAll("exclude operational state");

  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal((await git(aios, "ls-files", "--", ".dotaios/session-store")).stdout, "");
  assert.equal((await git(aios, "show", "HEAD:portable-note.md")).stdout, "portable\n");
  assert.equal(await fs.readFile(manifest, "utf8"), '{"format":"dotaios-session-store-transaction/v1"}\n');
});

test("fresh scaffold .env.example is safe to mirror", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n!.env.example\n" });
  await fs.writeFile(path.join(aios, ".env.example"), "OPTIONAL_TOKEN=\n");
  const sha = await createGit({ cwd: aios }).commitAll("initial mirror");
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal((await git(aios, "show", "HEAD:.env.example")).stdout, "OPTIONAL_TOKEN=\n");
});

test("pullRebase refuses remote token aliases before changing HEAD, index, or worktree", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "secret-prefix-mirror.git");
  const victim = path.join(root, "secret-prefix-victim");
  const attacker = path.join(root, "secret-prefix-attacker");
  await fs.writeFile(path.join(seed, "README.md"), "safe base\n");
  await git(seed, "add", ".gitignore", "aios.json", "README.md");
  await git(seed, "commit", "-q", "-m", "safe mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, attacker);
  await git(attacker, "config", "user.email", "attacker@example.com");
  await git(attacker, "config", "user.name", "Attacker");
  await fs.writeFile(path.join(attacker, "TOKEN.json"), "remote-secret\n");
  await git(attacker, "add", "TOKEN.json");
  await git(attacker, "commit", "-q", "-m", "poison mirror with token");
  await git(attacker, "push", "-q", "origin", "main");

  const victimNote = path.join(victim, "victim-only.md");
  await fs.writeFile(victimNote, "victim-owned\n");
  const beforeHead = (await git(victim, "rev-parse", "HEAD")).stdout.trim();
  const indexPath = path.join(victim, ".git", "index");
  const beforeIndex = await fs.readFile(indexPath);

  await assert.rejects(
    createGit({ cwd: victim }).pullRebase("main"),
    /private or regenerable local files.*TOKEN\.json/i
  );

  assert.equal((await git(victim, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.equal(await fs.readFile(victimNote, "utf8"), "victim-owned\n");
  await assert.rejects(fs.lstat(path.join(victim, "TOKEN.json")), { code: "ENOENT" });
});

test("pullRebase refuses a poisoned remote before it can overwrite an ignored workspace", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "mirror.git");
  const victim = path.join(root, "victim");
  const attacker = path.join(root, "attacker");

  await fs.writeFile(path.join(seed, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "safe mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, attacker);
  await git(attacker, "config", "user.email", "attacker@example.com");
  await git(attacker, "config", "user.name", "Attacker");

  const victimPrivate = path.join(victim, "workspaces", "widget", "private.txt");
  await fs.mkdir(path.dirname(victimPrivate), { recursive: true });
  await fs.writeFile(victimPrivate, "victim-owned\n");
  const attackerPath = path.join(attacker, "workspaces", "widget", "private.txt");
  await fs.mkdir(path.dirname(attackerPath), { recursive: true });
  await fs.writeFile(attackerPath, "remote-poison\n");
  await git(attacker, "add", "-f", "workspaces/widget/private.txt");
  await git(attacker, "commit", "-q", "-m", "poison ignored workspace");
  await git(attacker, "push", "-q", "origin", "main");

  const beforeHead = (await git(victim, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(
    createGit({ cwd: victim }).pullRebase("main"),
    /tracked local-workspace path/i
  );
  assert.equal(await fs.readFile(victimPrivate, "utf8"), "victim-owned\n");
  assert.equal((await git(victim, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
});

test("pullRebase refuses a remote symlink before changing HEAD or the worktree", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "symlink-mirror.git");
  const victim = path.join(root, "symlink-victim");
  const attacker = path.join(root, "symlink-attacker");

  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "safe mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, attacker);
  await git(attacker, "config", "user.email", "attacker@example.com");
  await git(attacker, "config", "user.name", "Attacker");

  const remoteLink = path.join(attacker, "memory", "events.jsonl");
  await fs.mkdir(path.dirname(remoteLink), { recursive: true });
  await fs.symlink("../../../outside-target", remoteLink);
  await git(attacker, "add", "memory/events.jsonl");
  await git(attacker, "commit", "-q", "-m", "install remote symlink");
  await git(attacker, "push", "-q", "origin", "main");

  const beforeHead = (await git(victim, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(
    createGit({ cwd: victim }).pullRebase("main"),
    /symbolic link.*memory\/events\.jsonl/i
  );
  assert.equal((await git(victim, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  await assert.rejects(fs.lstat(path.join(victim, "memory", "events.jsonl")), { code: "ENOENT" });
});

test("pullRebase stays bound to the validated fetched commit if origin/main moves concurrently", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "moving-ref-mirror.git");
  const victim = path.join(root, "moving-ref-victim");
  const peer = path.join(root, "moving-ref-peer");
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "safe base");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, peer);
  await git(peer, "config", "user.email", "peer@example.com");
  await git(peer, "config", "user.name", "Peer");

  await fs.writeFile(path.join(peer, "safe-peer.md"), "validated peer change\n");
  await git(peer, "add", "safe-peer.md");
  await git(peer, "commit", "-q", "-m", "safe peer change");
  await git(peer, "push", "-q", "origin", "main");

  await git(peer, "checkout", "-q", "-b", "unsafe", "HEAD~1");
  const unsafePath = path.join(peer, "memory", "events.jsonl");
  await fs.mkdir(path.dirname(unsafePath), { recursive: true });
  await fs.symlink("../../../outside-events.jsonl", unsafePath);
  await git(peer, "add", "memory/events.jsonl");
  await git(peer, "commit", "-q", "-m", "unsafe alternate commit");
  await git(peer, "push", "-q", "origin", "unsafe");
  const unsafeSha = (await git(peer, "rev-parse", "HEAD")).stdout.trim();
  await git(victim, "fetch", "-q", "origin", "unsafe:refs/remotes/origin/unsafe");

  let moved = false;
  const spawnImpl = async (cmd, args, options) => {
    if (!moved && args[0] === "rebase") {
      moved = true;
      await git(victim, "update-ref", "refs/remotes/origin/main", unsafeSha);
    }
    try {
      const { stdout, stderr } = await run(cmd, args, { cwd: victim, env: options.env });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        code: Number.isInteger(error.code) ? error.code : 1
      };
    }
  };

  assert.equal(await createGit({ cwd: victim, spawnImpl }).pullRebase("main"), "rebased");
  assert.equal(moved, true, "the regression must move the symbolic tracking ref before rebase");
  assert.equal(await fs.readFile(path.join(victim, "safe-peer.md"), "utf8"), "validated peer change\n");
  await assert.rejects(fs.lstat(path.join(victim, "memory", "events.jsonl")), { code: "ENOENT" });
});

test("pullRebase refuses a remote that negates the workspace boundary before rebase", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "mirror.git");
  const victim = path.join(root, "victim");
  const attacker = path.join(root, "attacker");

  await fs.writeFile(path.join(seed, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "safe mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, attacker);
  await git(attacker, "config", "user.email", "attacker@example.com");
  await git(attacker, "config", "user.name", "Attacker");
  await fs.writeFile(path.join(attacker, ".gitignore"), "/workspaces/\n!/workspaces/\n");
  await git(attacker, "add", ".gitignore");
  await git(attacker, "commit", "-q", "-m", "negate workspace privacy boundary");
  await git(attacker, "push", "-q", "origin", "main");

  const beforeHead = (await git(victim, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(
    createGit({ cwd: victim }).pullRebase("main"),
    /does not effectively ignore \/workspaces\//i
  );
  assert.equal((await fs.readFile(path.join(victim, ".gitignore"), "utf8")), "/workspaces/\n");
  assert.equal((await git(victim, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
});

test("a direct local schema upgrade can replace its legacy remote boundary", async (t) => {
  const seed = await makeAios(t, { gitignore: "node_modules/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "legacy-mirror.git");
  const victim = path.join(root, "victim");
  await fs.writeFile(path.join(seed, "aios.json"), '{"schema_version":"1.1.0"}\n');
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "legacy mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(victim, "config", "user.email", "owner@example.com");
  await git(victim, "config", "user.name", "Owner");
  await fs.writeFile(path.join(victim, ".gitignore"), "node_modules/\n/workspaces/\n");
  await fs.writeFile(path.join(victim, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(victim, "add", ".gitignore", "aios.json");
  await git(victim, "commit", "-q", "-m", "migrate workspace boundary");

  assert.equal(await createGit({ cwd: victim }).pullRebase("main"), "up-to-date");
});

test("a current local upgrade safely rebases a benign divergent legacy device", async (t) => {
  const seed = await makeAios(t, { gitignore: "node_modules/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "legacy-divergence.git");
  const currentDevice = path.join(root, "current-device");
  const legacyDevice = path.join(root, "legacy-device");
  await fs.writeFile(path.join(seed, "aios.json"), '{"schema_version":"1.1.0"}\n');
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "legacy mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, currentDevice);
  await git(root, "clone", "-q", remote, legacyDevice);
  for (const checkout of [currentDevice, legacyDevice]) {
    await git(checkout, "config", "user.email", "owner@example.com");
    await git(checkout, "config", "user.name", "Owner");
  }

  await fs.writeFile(path.join(currentDevice, ".gitignore"), "node_modules/\n/workspaces/\n");
  await fs.writeFile(path.join(currentDevice, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(currentDevice, "add", ".gitignore", "aios.json");
  await git(currentDevice, "commit", "-q", "-m", "migrate workspace boundary");

  await fs.writeFile(path.join(legacyDevice, "legacy-note.md"), "benign peer edit\n");
  await git(legacyDevice, "add", "legacy-note.md");
  await git(legacyDevice, "commit", "-q", "-m", "legacy peer edit");
  await git(legacyDevice, "push", "-q", "origin", "main");

  assert.equal(await createGit({ cwd: currentDevice }).pullRebase("main"), "rebased");
  assert.equal(await fs.readFile(path.join(currentDevice, "legacy-note.md"), "utf8"), "benign peer edit\n");
  assert.equal(JSON.parse(await fs.readFile(path.join(currentDevice, "aios.json"), "utf8")).schema_version, "1.2.0");
  assert.match(await fs.readFile(path.join(currentDevice, ".gitignore"), "utf8"), /^\/workspaces\/$/m);
});

test("pullRebase refuses a duplicate-id remote project catalog before changing HEAD", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "catalog-mirror.git");
  const victim = path.join(root, "victim");
  const attacker = path.join(root, "attacker");
  await fs.writeFile(path.join(seed, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "safe mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, attacker);
  await git(attacker, "config", "user.email", "attacker@example.com");
  await git(attacker, "config", "user.name", "Attacker");
  for (const slug of ["one", "two"]) {
    const readme = path.join(attacker, "projects", slug, "README.md");
    await fs.mkdir(path.dirname(readme), { recursive: true });
    await fs.writeFile(readme, `---\nid: duplicate-id\nproject: ${slug}\nstatus: active\n---\n# ${slug}\n`);
  }
  await git(attacker, "add", "projects");
  await git(attacker, "commit", "-q", "-m", "poison project catalog");
  await git(attacker, "push", "-q", "origin", "main");

  const beforeHead = (await git(victim, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(
    createGit({ cwd: victim }).pullRebase("main"),
    /project catalog is invalid.*duplicate-id/i
  );
  assert.equal((await git(victim, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
});

test("pullRebase validates the combined local and remote project catalog before rebase", async (t) => {
  const seed = await makeAios(t, { gitignore: "/workspaces/\n" });
  const root = path.dirname(seed);
  const remote = path.join(root, "combined-catalog-mirror.git");
  const victim = path.join(root, "victim");
  const peer = path.join(root, "peer");
  await fs.writeFile(path.join(seed, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(seed, "add", ".gitignore", "aios.json");
  await git(seed, "commit", "-q", "-m", "safe mirror");
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", "-q", remote, victim);
  await git(root, "clone", "-q", remote, peer);
  for (const checkout of [victim, peer]) {
    await git(checkout, "config", "user.email", "owner@example.com");
    await git(checkout, "config", "user.name", "Owner");
  }
  for (const [checkout, slug] of [[victim, "local"], [peer, "remote"]]) {
    const readme = path.join(checkout, "projects", slug, "README.md");
    await fs.mkdir(path.dirname(readme), { recursive: true });
    await fs.writeFile(readme, `---\nid: shared-id\nproject: ${slug}\nstatus: active\n---\n# ${slug}\n`);
    await git(checkout, "add", "projects");
    await git(checkout, "commit", "-q", "-m", `add ${slug} project`);
  }
  await git(peer, "push", "-q", "origin", "main");

  const beforeHead = (await git(victim, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(
    createGit({ cwd: victim }).pullRebase("main"),
    /project catalog is invalid.*shared-id/i
  );
  assert.equal((await git(victim, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
});

test("outer-index enforcement cannot be bypassed by a quoted workspace path", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  await registerProject(aios, "alpha");
  const relative = "workspaces/alpha/line\nbreak.txt";
  const indexed = path.join(aios, ...relative.split("/"));
  await fs.mkdir(path.dirname(indexed), { recursive: true });
  await fs.writeFile(indexed, "must stay out of the mirror\n");
  await git(aios, "add", "-f", "--", relative);

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    /outer Git index/i
  );
});

test("outer-index enforcement rejects case aliases of workspaces for macOS and Windows portability", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  const indexed = path.join(aios, "Workspaces", "alpha", "private.txt");
  await fs.mkdir(path.dirname(indexed), { recursive: true });
  await fs.writeFile(indexed, "private\n");
  await git(aios, "add", "-f", "--", "Workspaces/alpha/private.txt");

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    /Workspaces\/alpha\/private\.txt/
  );
});

test("mirror validation refuses an unregistered top-level workspace", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  await makeWorkspace(aios, "unregistered");

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    /unregistered.*project catalog/i
  );
});

test("mirror validation refuses a workspace whose catalog record has no stable id", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  await registerProject(aios, "legacy", "https://github.com/acme/widget.git", { id: null });
  await makeWorkspace(aios, "legacy");

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    /legacy.*stable project id/i
  );
});

test("mirror validation refuses registered workspace debris and symbolic links", async (t) => {
  for (const kind of ["file", "symlink"]) {
    await t.test(kind, async (t) => {
      const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
      await registerProject(aios, kind);
      await fs.mkdir(path.join(aios, "workspaces"), { recursive: true });
      const candidate = path.join(aios, "workspaces", kind);
      if (kind === "file") {
        await fs.writeFile(candidate, "debris\n");
      } else {
        const outside = path.join(path.dirname(aios), "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, candidate, "dir");
      }

      await assert.rejects(
        () => createGit({ cwd: aios }).validateMirrorContent(),
        new RegExp(`${kind}.*real.*directory|real.*directory.*${kind}`, "i")
      );
    });
  }
});

test("mirror validation refuses a registered workspace that is not a complete Git repository", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  await registerProject(aios, "partial");
  await fs.mkdir(path.join(aios, "workspaces", "partial"), { recursive: true });
  await fs.writeFile(path.join(aios, "workspaces", "partial", "README.md"), "not a clone\n");

  await assert.rejects(
    () => createGit({ cwd: aios }).validateMirrorContent(),
    /partial.*complete Git repository/i
  );
});

test("mirror validation accepts a complete registered workspace with a normalized matching remote", async (t) => {
  const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
  await registerProject(aios, "widget", "https://GitHub.com/Acme/Widget.git");
  await makeWorkspace(aios, "widget", "git@github.com:Acme/Widget.git");

  await assert.doesNotReject(() => createGit({ cwd: aios }).validateMirrorContent());
});

test("layout-only mirror validation works before the outer repository is initialized", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-workspace-preinit-"));
  const aios = path.join(root, "aios");
  await fs.mkdir(aios, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(aios, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await registerProject(aios, "widget");
  await makeWorkspace(aios, "widget");

  await assert.doesNotReject(
    () => createGit({ cwd: aios }).validateMirrorContent({ outerGit: false })
  );
});

test("initial upload permits a registered workspace after both policy passes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-workspace-upload-"));
  const aios = path.join(root, "aios");
  await fs.mkdir(aios, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await registerProject(aios, "widget");
  await makeWorkspace(aios, "widget");
  const calls = [];

  await assert.doesNotReject(() => initialMirrorPush({
    aiosPath: aios,
    fullName: "alice/alice-aios",
    gitignoreContent: "/workspaces/\n",
    git: {
      validateMirrorContent: async ({ outerGit = true } = {}) => calls.push(outerGit ? "full" : "layout"),
      init: async () => calls.push("init"),
      addRemote: async () => calls.push("remote"),
      commitAll: async () => "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1",
      validateMirrorCommit: async () => calls.push("commit-tree"),
      push: async () => calls.push("push")
    }
  }));
  assert.deepEqual(calls, ["layout", "init", "full", "remote", "commit-tree", "push"]);
});

test("mirror validation refuses unsafe and mismatched workspace remotes", async (t) => {
  for (const [label, expected, actual, message] of [
    ["unsafe catalog", "file:///tmp/widget", "https://github.com/acme/widget.git", /unsafe project remote/i],
    ["unsafe origin", "https://github.com/acme/widget.git", "file:///tmp/widget", /unsafe project remote/i],
    ["mismatch", "https://github.com/acme/widget.git", "git@github.com:other/widget.git", /does not match/i]
  ]) {
    await t.test(label, async (t) => {
      const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
      await registerProject(aios, "widget", expected);
      await makeWorkspace(aios, "widget", actual);

      await assert.rejects(
        () => createGit({ cwd: aios }).validateMirrorContent(),
        message
      );
    });
  }
});

test("mirror validation inspects the whole tree and refuses every other nested repository", async (t) => {
  for (const [label, nestedRelative] of [
    ["inside a registered workspace", "workspaces/widget/vendor/dependency"],
    ["outside workspaces", "vault/archive/dependency"]
  ]) {
    await t.test(label, async (t) => {
      const aios = await makeAios(t, { gitignore: "/workspaces/\n" });
      await registerProject(aios, "widget");
      await makeWorkspace(aios, "widget");
      const nested = path.join(aios, nestedRelative);
      await fs.mkdir(nested, { recursive: true });
      await git(nested, "init", "-q");

      await assert.rejects(
        () => createGit({ cwd: aios }).validateMirrorContent(),
        new RegExp(nestedRelative.replaceAll("/", "\\/"), "i")
      );
    });
  }
});
