import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyManagedBridgeFile,
  bridgeContent,
  previewManagedBridgeFile
} from "../../packages/core/src/bridges.mjs";

test("a stale owned bridge is an upgrade target and refreshes through the shared planner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const aiosPath = path.join(root, "aios");
  const before = [
    "# User instructions",
    "",
    "Keep this byte-for-byte.",
    "",
    "<!-- dotaios-managed:start -->",
    `DotAIOS keeps the user's personal context in a folder at ${aiosPath} (entrypoint: ${path.join(aiosPath, "AGENTS.md")}).`,
    "When asked, run `dotaios brief --compact --memory shared`.",
    "<!-- dotaios-managed:end -->",
    "",
    "User tail.",
    ""
  ].join("\n");
  const generated = await bridgeContent({ name: "Codex" }, aiosPath, { cli: "npx dotaios@2.0.11" });
  await fs.writeFile(destination, before);

  try {
    const plan = await previewManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.action, "update-managed-block");
    assert.deepEqual(plan.target, { kind: "bridge-managed-block", path: destination });
    assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);

    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true,
      expectedFingerprint: plan.fingerprint
    });
    assert.equal(result.action, "updated");
    const after = await fs.readFile(destination, "utf8");
    assert.match(after, /^# User instructions\n\nKeep this byte-for-byte\./);
    assert.ok(after.includes(`npx dotaios@2.0.11 brief --compact --memory shared --path '${aiosPath}'`));
    assert.match(after, /\nUser tail\.\n$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the shared planner upgrades the owned block to the universal hidden handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-handoff-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const aiosPath = path.join(root, "aios");
  const localCli = {
    executable: "/opt/dotaios/node/bin/node",
    entrypoint: "/opt/dotaios/package/packages/cli/src/index.mjs"
  };
  const generated = await bridgeContent({ name: "Codex" }, aiosPath, { localCli });
  const handoffRule = "Otherwise derive the current host's native support and invoke implicit discovery";
  assert.match(generated, new RegExp(handoffRule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const stale = generated.replace(
    handoffRule,
    "Invoke U2 resolve for the outcome and exact slug or stable ID"
  );
  await fs.writeFile(destination, stale);

  try {
    const plan = await previewManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.action, "update-managed-block");

    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true,
      expectedFingerprint: plan.fingerprint
    });
    assert.equal(result.action, "updated");
    const after = await fs.readFile(destination, "utf8");
    assert.match(after, new RegExp(handoffRule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(after, /Invoke U2 resolve for the outcome and exact slug or stable ID/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge apply refuses a stale preview and preserves the concurrent edit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-stale-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const aiosPath = path.join(root, "aios");
  const generated = await bridgeContent({ name: "Codex" }, aiosPath, { cli: "npx dotaios@2.0.11" });
  const oldGenerated = generated.replaceAll("npx dotaios@2.0.11", "npx dotaios@2.0.10");
  await fs.writeFile(destination, oldGenerated);

  try {
    const plan = await previewManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true
    });
    await fs.writeFile(destination, `${oldGenerated}\nConcurrent user edit.\n`);

    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true,
      expectedFingerprint: plan.fingerprint
    });
    assert.equal(result.action, "conflict");
    assert.match(await fs.readFile(destination, "utf8"), /Concurrent user edit/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge apply refuses a mode-only change after preview", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode bits are not portable to Windows");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-mode-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const aiosPath = path.join(root, "aios");
  const generated = await bridgeContent({ name: "Codex" }, aiosPath, { cli: "npx dotaios@2.0.11" });
  const oldGenerated = generated.replaceAll("npx dotaios@2.0.11", "npx dotaios@2.0.10");
  await fs.writeFile(destination, oldGenerated, { mode: 0o644 });

  try {
    const plan = await previewManagedBridgeFile(destination, generated, { refreshOnly: true });
    await fs.chmod(destination, 0o600);

    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true,
      expectedFingerprint: plan.fingerprint
    });
    assert.equal(result.action, "conflict");
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(destination, "utf8"), oldGenerated);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge apply refuses a same-byte inode replacement after preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-identity-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const replacement = path.join(root, "replacement.md");
  const aiosPath = path.join(root, "aios");
  const generated = await bridgeContent({ name: "Codex" }, aiosPath, { cli: "npx dotaios@2.0.11" });
  const oldGenerated = generated.replaceAll("npx dotaios@2.0.11", "npx dotaios@2.0.10");
  await fs.writeFile(destination, oldGenerated);

  try {
    const plan = await previewManagedBridgeFile(destination, generated, { refreshOnly: true });
    await fs.writeFile(replacement, oldGenerated);
    await fs.rename(replacement, destination);

    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true,
      expectedFingerprint: plan.fingerprint
    });
    assert.equal(result.action, "conflict");
    assert.equal(await fs.readFile(destination, "utf8"), oldGenerated);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refresh-only planning ignores files without an owned managed block", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-unmanaged-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const generated = await bridgeContent({ name: "Codex" }, path.join(root, "aios"), {
    cli: "npx dotaios@2.0.11"
  });
  await fs.writeFile(destination, "# User file\n\nNever touch me.\n");

  try {
    const plan = await previewManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      refreshOnly: true
    });
    assert.equal(plan.status, "not-managed");
    assert.equal(plan.action, "none");
    assert.equal(await fs.readFile(destination, "utf8"), "# User file\n\nNever touch me.\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unmanaged bridge previews bind merge and overwrite consent to the applied bytes", async (t) => {
  for (const policy of ["merge", "overwrite"]) {
    await t.test(policy, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `dotaios-bridge-${policy}-plan-`));
      const destination = path.join(root, "AGENTS.md");
      const original = "# User file\n\nKeep these instructions.\n";
      const generated = await bridgeContent({ name: "Codex" }, path.join(root, "aios"), {
        cli: "npx dotaios@2.0.11"
      });
      await fs.writeFile(destination, original);

      try {
        const consent = { [policy]: true };
        const plan = await previewManagedBridgeFile(destination, generated, consent);
        assert.equal(plan.status, "ready");
        assert.equal(
          plan.action,
          policy === "merge" ? "append-managed-block" : "replace-unmanaged"
        );

        const result = await applyManagedBridgeFile(destination, generated, {
          boundaryRoot: root,
          expectedFingerprint: plan.fingerprint,
          ...consent,
        });
        assert.equal(result.action, policy === "merge" ? "appended" : "updated");
        const after = await fs.readFile(destination, "utf8");
        if (policy === "merge") {
          assert.match(after, /^# User file\n\nKeep these instructions\./);
          assert.match(after, /<!-- dotaios-managed:start -->/);
        } else {
          assert.equal(after, generated);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("bridge apply refuses a consent policy changed after preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-consent-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const original = "# User file\n\nNever replace me.\n";
  const generated = await bridgeContent({ name: "Codex" }, path.join(root, "aios"), {
    cli: "npx dotaios@2.0.11"
  });
  await fs.writeFile(destination, original);

  try {
    const plan = await previewManagedBridgeFile(destination, generated, { merge: true });
    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      overwrite: true,
      expectedFingerprint: plan.fingerprint,
    });
    assert.equal(result.action, "conflict");
    assert.equal(await fs.readFile(destination, "utf8"), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge apply refuses an unmanaged file changed after a consented preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-unmanaged-race-plan-"));
  const destination = path.join(root, "AGENTS.md");
  const original = "# User file\n\nKeep me.\n";
  const concurrent = `${original}\nConcurrent edit.\n`;
  const generated = await bridgeContent({ name: "Codex" }, path.join(root, "aios"), {
    cli: "npx dotaios@2.0.11"
  });
  await fs.writeFile(destination, original);

  try {
    const plan = await previewManagedBridgeFile(destination, generated, { merge: true });
    await fs.writeFile(destination, concurrent);
    const result = await applyManagedBridgeFile(destination, generated, {
      boundaryRoot: root,
      merge: true,
      expectedFingerprint: plan.fingerprint,
    });
    assert.equal(result.action, "conflict");
    assert.equal(await fs.readFile(destination, "utf8"), concurrent);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge preview blocks targets outside its boundary or behind a symlinked parent", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation is not portable on Windows");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-boundary-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-bridge-outside-"));
  const linkedParent = path.join(root, ".codex");
  const generated = await bridgeContent({ name: "Codex" }, path.join(root, "aios"), {
    cli: "npx dotaios@2.0.11"
  });
  await fs.symlink(outside, linkedParent);

  try {
    const linked = await previewManagedBridgeFile(path.join(linkedParent, "AGENTS.md"), generated, {
      boundaryRoot: root
    });
    assert.equal(linked.status, "blocked-conflict");
    assert.match(linked.reason, /unsafe managed directory/i);

    const escaped = await previewManagedBridgeFile(path.join(outside, "AGENTS.md"), generated, {
      boundaryRoot: root
    });
    assert.equal(escaped.status, "blocked-conflict");
    assert.match(escaped.reason, /outside the managed file boundary/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
