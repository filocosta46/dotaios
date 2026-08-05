import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { createGit } from "../../packages/cli/src/sync/git.mjs";
import { initialMirrorPush } from "../../packages/cli/src/sync/repo.mjs";

const run = promisify(execFile);

test("the managed sync ignore template anchors the local workspace root", async () => {
  const template = await fs.readFile(
    new URL("../../templates/sync-gitignore.template", import.meta.url),
    "utf8"
  );
  assert.match(template, /^\/workspaces\/$/m);
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
      push: async () => calls.push("push")
    }
  }));
  assert.deepEqual(calls, ["layout", "init", "full", "remote", "push"]);
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
