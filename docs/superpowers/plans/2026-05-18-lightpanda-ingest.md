# Lightpanda Web Ingest Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dotaios ingest <url>` use Lightpanda (a headless browser) by default, installed automatically during `dotaios setup`, with silent fallback to plain fetch when missing or failing.

**Architecture:** A new zero-dep `packages/core/src/lightpanda.mjs` module owns platform detection, download to `~/.dotaios/bin/lightpanda`, and resolver lookup. `packages/cli/src/ingest/web.mjs` gets a `fetchHtml()` dispatcher that prefers Lightpanda (via `spawnSync`) and falls back to plain `fetch`. `setup.mjs` calls the downloader once. The `AGENTS.md` template gains a rule routing all URL reading through `dotaios ingest`.

**Tech Stack:** Node 20 ESM, zero-dep core, `node:test`, `node:child_process` (`spawnSync`), `node:https`/`node:fs`. Lightpanda binary fetched from `https://github.com/lightpanda-io/browser/releases/latest/download/<binary>`.

**Conventions:**
- Tests run with `node --test tests/**/*.test.mjs`. All 249 existing tests must stay green.
- Use `import` (ESM). No `require`.
- `packages/core` has zero npm deps — `lightpanda.mjs` must use only `node:` built-ins.
- All new fetch/spawn/clock calls accept injectable overrides for testing (`fetchImpl`, `spawnImpl`, `now`, `resolveLightpandaImpl`).

---

## File Map

| File | Change |
|---|---|
| `packages/core/src/paths.mjs` | Add `dotaiosBinDir()`, `lightpandaBinPath()` |
| `packages/core/src/lightpanda.mjs` | **New** — `lightpandaPlatformBinary()`, `downloadLightpanda()`, `resolveLightpanda()` |
| `packages/cli/src/ingest/web.mjs` | Add `fetchHtml()` dispatcher, thread `parser` field through, write one-time hint flag |
| `packages/cli/src/commands/setup.mjs` | Call `downloadLightpanda({ silent: false })` after wizard, before final summary |
| `templates/AGENTS.md.hbs` | Add URL routing rule under `## Rules` |
| `README.md` | One-line mention in ingest section |
| `tests/core/lightpanda.test.mjs` | **New** — platform binary, download (stubbed fetch+fs), resolve fallback chain |
| `tests/cli/ingest_routing.test.mjs` | Add 3 direct `ingestUrl()` tests for lightpanda success / lightpanda crash → fallback / lightpanda missing |
| `tests/core/render.test.mjs` | Add assertion that `AGENTS.md` template includes the routing rule |

---

## Task 1: `dotaiosBinDir()` + `lightpandaBinPath()` in core paths

**Files:**
- Modify: `packages/core/src/paths.mjs`
- Test: `tests/core/paths.test.mjs` (new file)

- [ ] **Step 1: Write failing test**

Create `tests/core/paths.test.mjs`:

```js
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { dotaiosBinDir, lightpandaBinPath } from "../../packages/core/src/paths.mjs";

test("dotaiosBinDir returns ~/.dotaios/bin", () => {
  assert.equal(dotaiosBinDir(), path.join(os.homedir(), ".dotaios", "bin"));
});

test("lightpandaBinPath returns ~/.dotaios/bin/lightpanda on unix", { skip: process.platform === "win32" }, () => {
  assert.equal(lightpandaBinPath(), path.join(os.homedir(), ".dotaios", "bin", "lightpanda"));
});

test("lightpandaBinPath returns ~/.dotaios/bin/lightpanda.exe on windows", { skip: process.platform !== "win32" }, () => {
  assert.equal(lightpandaBinPath(), path.join(os.homedir(), ".dotaios", "bin", "lightpanda.exe"));
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
node --test tests/core/paths.test.mjs
```
Expected: `Cannot find ... dotaiosBinDir` or `is not a function`.

- [ ] **Step 3: Implement in `packages/core/src/paths.mjs`**

Add at the bottom of the file:

```js
export function dotaiosBinDir() {
  return path.join(os.homedir(), ".dotaios", "bin");
}

export function lightpandaBinPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(dotaiosBinDir(), `lightpanda${ext}`);
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
node --test tests/core/paths.test.mjs
```
Expected: 3 tests passing (with 1 skipped depending on platform).

- [ ] **Step 5: Run full test suite to confirm no regression**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -20
```
Expected: 252 tests passing (249 + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/paths.mjs tests/core/paths.test.mjs
git commit -m "feat(core): add dotaiosBinDir and lightpandaBinPath helpers"
```

---

## Task 2: `lightpandaPlatformBinary()` — platform → binary name

**Files:**
- Create: `packages/core/src/lightpanda.mjs`
- Test: `tests/core/lightpanda.test.mjs` (new)

- [ ] **Step 1: Write failing test**

Create `tests/core/lightpanda.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { lightpandaPlatformBinary } from "../../packages/core/src/lightpanda.mjs";

test("lightpandaPlatformBinary maps darwin+arm64 to aarch64-macos", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "darwin", arch: "arm64" }), "lightpanda-aarch64-macos");
});

test("lightpandaPlatformBinary maps darwin+x64 to x86_64-macos", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "darwin", arch: "x64" }), "lightpanda-x86_64-macos");
});

test("lightpandaPlatformBinary maps linux+arm64 to aarch64-linux", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "linux", arch: "arm64" }), "lightpanda-aarch64-linux");
});

test("lightpandaPlatformBinary maps linux+x64 to x86_64-linux", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "linux", arch: "x64" }), "lightpanda-x86_64-linux");
});

test("lightpandaPlatformBinary returns null on win32", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "win32", arch: "x64" }), null);
});

test("lightpandaPlatformBinary returns null on unknown platform/arch", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "linux", arch: "ppc64" }), null);
  assert.equal(lightpandaPlatformBinary({ platform: "freebsd", arch: "x64" }), null);
});

test("lightpandaPlatformBinary defaults to current process when no arg", () => {
  const out = lightpandaPlatformBinary();
  if (process.platform === "win32") assert.equal(out, null);
  else assert.match(out, /^lightpanda-/);
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
node --test tests/core/lightpanda.test.mjs
```
Expected: `Cannot find module .../lightpanda.mjs`.

- [ ] **Step 3: Implement**

Create `packages/core/src/lightpanda.mjs`:

```js
const PLATFORM_BINARIES = {
  "darwin:arm64": "lightpanda-aarch64-macos",
  "darwin:x64": "lightpanda-x86_64-macos",
  "linux:arm64": "lightpanda-aarch64-linux",
  "linux:x64": "lightpanda-x86_64-linux"
};

export function lightpandaPlatformBinary({ platform = process.platform, arch = process.arch } = {}) {
  return PLATFORM_BINARIES[`${platform}:${arch}`] ?? null;
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
node --test tests/core/lightpanda.test.mjs
```
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lightpanda.mjs tests/core/lightpanda.test.mjs
git commit -m "feat(core): map platform+arch to lightpanda binary name"
```

---

## Task 3: `downloadLightpanda()` — fetch binary to `~/.dotaios/bin/`

**Files:**
- Modify: `packages/core/src/lightpanda.mjs`
- Test: `tests/core/lightpanda.test.mjs`

- [ ] **Step 1: Write failing tests** (append to `tests/core/lightpanda.test.mjs`)

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadLightpanda } from "../../packages/core/src/lightpanda.mjs";

function makeFakeFetch({ status = 200, body = "FAKE_BINARY_BYTES" } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  });
}

test("downloadLightpanda writes binary to destBinPath and chmods +x on unix", { skip: process.platform === "win32" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      silent: true,
      fetchImpl: makeFakeFetch({ body: "BINARY" }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });
    assert.equal(result.ok, true);
    const written = await fs.readFile(destBinPath, "utf8");
    assert.equal(written, "BINARY");
    const stat = await fs.stat(destBinPath);
    assert.ok((stat.mode & 0o111) !== 0, "executable bit should be set");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason } on HTTP error without throwing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      silent: true,
      fetchImpl: makeFakeFetch({ status: 404 }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /404/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason } on network error without throwing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      silent: true,
      fetchImpl: async () => { throw new Error("ECONNRESET"); },
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ECONNRESET/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason:'unsupported-platform' } when platformBinary null", async () => {
  const result = await downloadLightpanda({
    silent: true,
    fetchImpl: makeFakeFetch(),
    destBinPath: path.join(os.tmpdir(), "noop"),
    platformBinary: null
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-platform");
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
node --test tests/core/lightpanda.test.mjs
```
Expected: `Cannot find ... downloadLightpanda`.

- [ ] **Step 3: Implement in `packages/core/src/lightpanda.mjs`**

Add imports at top:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { lightpandaBinPath } from "./paths.mjs";
```

Add after `lightpandaPlatformBinary`:

```js
const RELEASE_BASE = "https://github.com/lightpanda-io/browser/releases/latest/download";

export async function downloadLightpanda({
  silent = false,
  fetchImpl = globalThis.fetch,
  destBinPath = lightpandaBinPath(),
  platformBinary = lightpandaPlatformBinary()
} = {}) {
  if (!platformBinary) {
    return { ok: false, reason: "unsupported-platform" };
  }

  const url = `${RELEASE_BASE}/${platformBinary}`;
  if (!silent) console.log(`⬇  Installing Lightpanda for web browsing...`);

  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText || ""}`.trim() };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(destBinPath), { recursive: true });
    await fs.writeFile(destBinPath, buf);
    if (process.platform !== "win32") {
      await fs.chmod(destBinPath, 0o755);
    }
    if (!silent) console.log(`   Installed Lightpanda → ${destBinPath}`);
    return { ok: true, path: destBinPath };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --test tests/core/lightpanda.test.mjs
```
Expected: 11 tests passing (7 from Task 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lightpanda.mjs tests/core/lightpanda.test.mjs
git commit -m "feat(core): download lightpanda binary to ~/.dotaios/bin/"
```

---

## Task 4: `resolveLightpanda()` — local bin → PATH → null

**Files:**
- Modify: `packages/core/src/lightpanda.mjs`
- Test: `tests/core/lightpanda.test.mjs`

- [ ] **Step 1: Write failing tests** (append)

```js
import { resolveLightpanda } from "../../packages/core/src/lightpanda.mjs";

test("resolveLightpanda returns local bin path when it exists and is executable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-res-"));
  const localBin = path.join(tmp, "lightpanda");
  await fs.writeFile(localBin, "#!/bin/sh\necho fake");
  await fs.chmod(localBin, 0o755);
  try {
    const result = await resolveLightpanda({
      localBinPath: localBin,
      whichImpl: () => null
    });
    assert.equal(result, localBin);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveLightpanda falls back to PATH when local missing", async () => {
  const result = await resolveLightpanda({
    localBinPath: "/nonexistent/lightpanda",
    whichImpl: () => "/usr/local/bin/lightpanda"
  });
  assert.equal(result, "/usr/local/bin/lightpanda");
});

test("resolveLightpanda returns null when neither local nor PATH has it", async () => {
  const result = await resolveLightpanda({
    localBinPath: "/nonexistent/lightpanda",
    whichImpl: () => null
  });
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
node --test tests/core/lightpanda.test.mjs
```
Expected: `Cannot find ... resolveLightpanda`.

- [ ] **Step 3: Implement** in `packages/core/src/lightpanda.mjs`

Add import at top:

```js
import { spawnSync } from "node:child_process";
```

Add after `downloadLightpanda`:

```js
function defaultWhich() {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, ["lightpanda"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = (result.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || null;
}

export async function resolveLightpanda({
  localBinPath = lightpandaBinPath(),
  whichImpl = defaultWhich
} = {}) {
  try {
    await fs.access(localBinPath);
    return localBinPath;
  } catch {
    // not present, try PATH
  }
  const fromPath = whichImpl();
  return fromPath || null;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --test tests/core/lightpanda.test.mjs
```
Expected: 14 tests passing.

- [ ] **Step 5: Run full suite**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -5
```
Expected: 252 + 3 + 4 + 3 = 256 tests passing (depending on platform-skipped count).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lightpanda.mjs tests/core/lightpanda.test.mjs
git commit -m "feat(core): resolve lightpanda from local bin or PATH"
```

---

## Task 5: Lightpanda-backed `fetchHtml()` in ingest/web.mjs

**Files:**
- Modify: `packages/cli/src/ingest/web.mjs`
- Test: `tests/cli/ingest_routing.test.mjs`

This task threads a `parser` value through `ingestUrl()` so the frontmatter, `placeMarkdown`, and event log reflect which fetcher was used.

- [ ] **Step 1: Write failing tests** (append to `tests/cli/ingest_routing.test.mjs`)

Add at top of file:

```js
import { ingestUrl } from "../../packages/cli/src/ingest/web.mjs";
```

Add at bottom of file:

```js
function htmlFixture(title = "Lightpanda Rendered") {
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"Body paragraph. ".repeat(60)}</p></article></body></html>`;
}

function makeFakeFetch({ body = htmlFixture(), status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: { get: () => "text/html; charset=utf-8" }
  });
}

function makeWebWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-lp-web-"));
  return {
    root,
    rawDir: path.join(root, "vault", "raw"),
    assetsDir: path.join(root, "vault", "assets"),
    eventsPath: path.join(root, "memory", "events.jsonl"),
    hintFlagPath: path.join(root, "lightpanda_hint_shown")
  };
}

test("ingestUrl uses lightpanda when resolver returns a path and spawn succeeds", async () => {
  const ws = makeWebWorkspace();
  const html = htmlFixture("Lightpanda Win");
  const result = await ingestUrl("https://example.com/lp-win", {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makeFakeFetch({ body: "<html><body>SHOULD NOT BE USED</body></html>" }),
    resolveLightpandaImpl: async () => "/fake/lightpanda",
    spawnImpl: () => ({ status: 0, stdout: html, stderr: "" }),
    hintFlagPath: ws.hintFlagPath,
    now: () => new Date("2026-05-18T12:00:00Z")
  });
  assert.equal(result.action, "written");
  assert.equal(result.parser, "lightpanda+readability+turndown");
  const written = fs.readFileSync(result.destination, "utf8");
  assert.match(written, /parser: lightpanda\+readability\+turndown/);
  assert.match(written, /Lightpanda Win/);
});

test("ingestUrl falls back to plain fetch when lightpanda spawn fails", async () => {
  const ws = makeWebWorkspace();
  const html = htmlFixture("Plain Fetch Fallback");
  const result = await ingestUrl("https://example.com/fallback", {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makeFakeFetch({ body: html }),
    resolveLightpandaImpl: async () => "/fake/lightpanda",
    spawnImpl: () => ({ status: 1, stdout: "", stderr: "boom" }),
    hintFlagPath: ws.hintFlagPath,
    now: () => new Date("2026-05-18T12:00:00Z")
  });
  assert.equal(result.action, "written");
  assert.equal(result.parser, "readability+turndown");
  const written = fs.readFileSync(result.destination, "utf8");
  assert.match(written, /parser: readability\+turndown/);
  assert.match(written, /Plain Fetch Fallback/);
});

test("ingestUrl uses plain fetch when lightpanda not found and writes hint flag once", async () => {
  const ws = makeWebWorkspace();
  const html = htmlFixture("Plain No Lightpanda");
  const opts = {
    rawDir: ws.rawDir,
    eventsPath: ws.eventsPath,
    fetchImpl: makeFakeFetch({ body: html }),
    resolveLightpandaImpl: async () => null,
    spawnImpl: () => { throw new Error("must not spawn"); },
    hintFlagPath: ws.hintFlagPath,
    lightpandaPlatformSupported: true,
    now: () => new Date("2026-05-18T12:00:00Z")
  };
  const result = await ingestUrl("https://example.com/nope", opts);
  assert.equal(result.parser, "readability+turndown");
  assert.equal(fs.existsSync(ws.hintFlagPath), true);

  // Second call must not re-create / re-print (flag already exists)
  const html2 = htmlFixture("Second Call");
  const second = await ingestUrl("https://example.com/nope2", {
    ...opts,
    fetchImpl: makeFakeFetch({ body: html2 })
  });
  assert.equal(second.parser, "readability+turndown");
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
node --test tests/cli/ingest_routing.test.mjs
```
Expected: tests fail because `resolveLightpandaImpl` / `spawnImpl` / `hintFlagPath` options are ignored and `parser` is always `"readability+turndown"`.

- [ ] **Step 3: Implement in `packages/cli/src/ingest/web.mjs`**

Add imports at top:

```js
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { resolveLightpanda, lightpandaPlatformBinary } from "../../../core/src/lightpanda.mjs";
```

Replace the destructure block in `ingestUrl()` (lines ~58-73) — add four new option lines:

```js
  const {
    rawDir,
    eventsPath,
    overwrite = false,
    dryRun = false,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    documentOptions = {},
    shelf = "raw",
    name = null,
    vaultRoot = null,
    signalsDir = null,
    apply = false,
    interactive = false,
    now = () => new Date(),
    resolveLightpandaImpl = resolveLightpanda,
    spawnImpl = nodeSpawnSync,
    hintFlagPath = path.join(os.homedir(), ".dotaios", ".lightpanda_hint_shown"),
    lightpandaPlatformSupported = lightpandaPlatformBinary() !== null
  } = options;
```

Replace the existing `const response = await fetchWithTimeout(...)` block (currently line ~93) with a dispatcher. Replace lines 93-152 (everything from `const response = ...` through the closing of `ingestUrl`) with:

```js
  const fetched = await fetchHtml(canonical, {
    timeoutMs,
    fetchImpl,
    resolveLightpandaImpl,
    spawnImpl,
    hintFlagPath,
    lightpandaPlatformSupported
  });

  // PDF branch still goes through plain fetch (fetched.response is set when lightpanda was skipped)
  if (fetched.via === "plain") {
    const response = fetched.response;
    if (!response.ok) {
      throw new IngestError(
        `Fetch failed: ${canonical} returned ${response.status} ${response.statusText || ""}`.trim(),
        "FETCH_FAILED"
      );
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/pdf")) {
      return await ingestPdfResponse({
        response,
        canonical,
        rawDir,
        assetsDir: options.assetsDir,
        eventsPath,
        overwrite,
        documentOptions,
        shelf,
        name,
        vaultRoot,
        signalsDir,
        apply,
        interactive,
        now
      });
    }
  }

  const html = fetched.html;
  const parser = fetched.parser;
  const { title, markdown } = await extractArticle(html, canonical);

  const baseSlug = slugify(title);
  const frontmatter = buildFrontmatter({
    source: canonical,
    kind: "web",
    parser,
    title,
    ingestedAt: now().toISOString()
  });

  return await placeMarkdown({
    shelf,
    name,
    vaultRoot,
    rawDir,
    signalsDir,
    eventsPath,
    baseSlug,
    source: canonical,
    title,
    body: `${frontmatter}\n${markdown.trimEnd()}`,
    kind: "web",
    parser,
    overwrite,
    apply,
    interactive,
    now
  });
}
```

Add a new helper above `fetchWithTimeout`:

```js
async function fetchHtml(url, {
  timeoutMs,
  fetchImpl,
  resolveLightpandaImpl,
  spawnImpl,
  hintFlagPath,
  lightpandaPlatformSupported
}) {
  const lp = await resolveLightpandaImpl();

  if (lp) {
    try {
      const result = spawnImpl(lp, ["fetch", "--dump", url], {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      });
      if (result && result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
        return { via: "lightpanda", html: result.stdout, parser: "lightpanda+readability+turndown" };
      }
      console.warn(`[lightpanda] fetch failed for ${url} (exit ${result?.status ?? "?"}), falling back to plain fetch`);
    } catch (err) {
      console.warn(`[lightpanda] spawn error for ${url}: ${err.message}, falling back to plain fetch`);
    }
  } else if (lightpandaPlatformSupported) {
    await maybeShowLightpandaHint(hintFlagPath);
  }

  const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
  if (!response.ok) {
    return { via: "plain", response, html: "", parser: "readability+turndown" };
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    return { via: "plain", response, html: "", parser: "readability+turndown" };
  }
  const html = await response.text();
  return { via: "plain", response, html, parser: "readability+turndown" };
}

async function maybeShowLightpandaHint(hintFlagPath) {
  try {
    await fs.access(hintFlagPath);
    return; // already shown
  } catch {
    // fall through
  }
  try {
    await fs.mkdir(path.dirname(hintFlagPath), { recursive: true });
    await fs.writeFile(hintFlagPath, new Date().toISOString());
    console.log("Tip: run `dotaios setup` to install Lightpanda for better web scraping.");
  } catch {
    // non-fatal — never block ingest because of the hint
  }
}
```

Also update the `dryRun` branch (lines ~77-91) to compute parser via resolver:

```js
  if (dryRun) {
    const lp = await resolveLightpandaImpl();
    const parser = lp ? "lightpanda+readability+turndown" : "readability+turndown";
    return {
      action: "dry-run",
      kind: "web",
      parser,
      canonical,
      plan: { kind: "web", parser, canonical, shelf, rawDir }
    };
  }
```

- [ ] **Step 4: Run lightpanda routing tests, expect pass**

```bash
node --test tests/cli/ingest_routing.test.mjs
```
Expected: all routing tests pass, including 3 new lightpanda tests.

- [ ] **Step 5: Run full suite — guard for regressions in `tests/cli/v1_4_0.test.mjs`**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -10
```
Expected: still all green. The v1_4_0 tests do not pass `resolveLightpandaImpl`, so the real resolver runs against a temp HOME (none of those tests have `~/.dotaios/bin/lightpanda` installed in CI, so it falls through to plain fetch — same `parser: readability+turndown` as before). If any v1_4_0 test fails because `~/.dotaios/bin/lightpanda` actually exists on the dev machine, override in those tests via `resolveLightpandaImpl: async () => null`. **Verify** this assumption by running first; only patch v1_4_0 if it red-fails.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ingest/web.mjs tests/cli/ingest_routing.test.mjs
git commit -m "feat(ingest): use lightpanda for web fetch with plain-fetch fallback"
```

---

## Task 6: Setup wizard installs Lightpanda

**Files:**
- Modify: `packages/cli/src/commands/setup.mjs`
- Test: `tests/cli/setup.test.mjs` (extend existing)

- [ ] **Step 1: Inspect existing setup test to find the right insertion point**

```bash
grep -n "setupCommand\|test(" tests/cli/setup.test.mjs | head -30
```

- [ ] **Step 2: Write failing test** — add at bottom of `tests/cli/setup.test.mjs`:

```js
test("setupCommand calls downloadLightpanda once after wizard", async () => {
  // Import dynamically so we can monkeypatch the module
  const lpModule = await import("../../packages/core/src/lightpanda.mjs");
  const originalDownload = lpModule.downloadLightpanda;
  let calls = 0;
  // Patch on the imported namespace — setup.mjs reads it through dynamic import
  lpModule.downloadLightpanda = async () => { calls += 1; return { ok: true }; };
  try {
    // Run setup non-interactively into a temp dir
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-lp-"));
    const aiosPath = path.join(tmp, "aios");
    const result = spawnSync(process.execPath, [
      path.resolve("packages/cli/src/index.mjs"),
      "setup",
      "--path", aiosPath,
      "--yes",
      "--skip-reveal"
    ], {
      encoding: "utf8",
      env: { ...process.env, DOTAIOS_SKIP_LIGHTPANDA_TEST_DOWNLOAD: "1" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing Lightpanda/);
  } finally {
    lpModule.downloadLightpanda = originalDownload;
  }
});
```

> **Note for the implementer:** monkeypatching across `spawnSync` boundaries does not work — the child process has its own module graph. Replace the assertion strategy: assert against stdout only. The CLI subprocess will try a real network download, which is unacceptable in CI. **Fix:** in `setup.mjs`, skip the call when `process.env.DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD === "1"` and print the line anyway. Re-write the test to set that env var and assert the line prints.

Replace the test above with:

```js
test("setupCommand prints lightpanda step (download skipped via env)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-lp-"));
  const aiosPath = path.join(tmp, "aios");
  const result = spawnSync(process.execPath, [
    path.resolve("packages/cli/src/index.mjs"),
    "setup",
    "--path", aiosPath,
    "--yes",
    "--skip-reveal"
  ], {
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Lightpanda/);
});
```

- [ ] **Step 3: Run test, expect failure**

```bash
node --test tests/cli/setup.test.mjs
```
Expected: stdout does not contain "Lightpanda".

- [ ] **Step 4: Implement in `packages/cli/src/commands/setup.mjs`**

Add import at top:

```js
import { downloadLightpanda, lightpandaPlatformBinary } from "../../../core/src/lightpanda.mjs";
```

Insert a new block immediately **before** the "Skills summary" section (before `const skills = await collectSkills(aiosPath);`):

```js
  // Step 3.5: install Lightpanda (best-effort, never blocks)
  if (lightpandaPlatformBinary() !== null) {
    if (process.env.DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD === "1") {
      console.log("");
      console.log("⬇  Installing Lightpanda for web browsing... (skipped via DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD)");
    } else {
      console.log("");
      const result = await downloadLightpanda({ silent: true });
      if (result.ok) {
        console.log("✓  Lightpanda installed for web browsing");
      } else {
        console.log(`(Lightpanda install skipped: ${result.reason}. Web ingest will use plain fetch.)`);
      }
    }
  }
```

- [ ] **Step 5: Run test, expect pass**

```bash
node --test tests/cli/setup.test.mjs
```
Expected: passes.

- [ ] **Step 6: Run full suite**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/setup.mjs tests/cli/setup.test.mjs
git commit -m "feat(setup): install lightpanda during dotaios setup"
```

---

## Task 7: AGENTS.md routing rule

**Files:**
- Modify: `templates/AGENTS.md.hbs`
- Test: `tests/core/render.test.mjs`

- [ ] **Step 1: Write failing test** — add at bottom of `tests/core/render.test.mjs`:

```js
import fs from "node:fs/promises";
import path from "node:path";

test("AGENTS.md.hbs Rules section includes dotaios ingest URL routing rule", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );
  assert.match(tpl, /## Rules/);
  assert.match(tpl, /dotaios ingest/);
  assert.match(tpl, /URL/);
  const rulesIdx = tpl.indexOf("## Rules");
  assert.ok(tpl.indexOf("dotaios ingest", rulesIdx) > rulesIdx, "rule must appear under Rules");
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
node --test tests/core/render.test.mjs
```
Expected: `dotaios ingest` not found.

- [ ] **Step 3: Edit `templates/AGENTS.md.hbs`**

Under the `## Rules` section, add this bullet immediately after the existing `- Treat \`vault/\` as routed long-term knowledge.` line (so it lives among the other rules, before the security rule):

```markdown
- When the user shares a URL, run `dotaios ingest <url>` to read and save it. This uses a local headless browser that renders JavaScript. Prefer it over your own web fetch tools.
```

- [ ] **Step 4: Run test, expect pass**

```bash
node --test tests/core/render.test.mjs
```
Expected: passes.

- [ ] **Step 5: Run full suite**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -5
```

If any existing template-snapshot tests fail due to the new line, update the snapshot — that is the expected change.

- [ ] **Step 6: Commit**

```bash
git add templates/AGENTS.md.hbs tests/core/render.test.mjs
git commit -m "feat(templates): instruct agents to route URLs through dotaios ingest"
```

---

## Task 8: README mention

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the ingest section**

```bash
grep -n "ingest" README.md | head -20
```

- [ ] **Step 2: Add the line**

Add at the end of the ingest section (or to the closest paragraph describing URL/web ingestion):

```markdown
Web pages are fetched using Lightpanda, a lightweight headless browser that renders JavaScript. It installs automatically during `dotaios setup`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): mention lightpanda in web ingest section"
```

---

## Task 9: Full suite sanity check + acceptance scan

- [ ] **Step 1: Run all tests one more time**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -10
```
Expected: 249 baseline + new tests (≈ 260-262), all green. No regressions.

- [ ] **Step 2: Scan for placeholders left in code**

```bash
grep -rn "TODO\|FIXME\|XXX" packages/core/src/lightpanda.mjs packages/cli/src/ingest/web.mjs packages/cli/src/commands/setup.mjs
```
Expected: no output.

- [ ] **Step 3: Verify spec acceptance criteria**

Walk through `docs/superpowers/specs/2026-05-18-lightpanda-ingest.md` "Acceptance Criteria" list, check each:
- `~/.dotaios/bin/lightpanda` exists after setup ✓ (covered by Task 6 — manual check on Mac/Linux box)
- Web ingest produces `lightpanda+readability+turndown` frontmatter when binary present ✓ (Task 5 test)
- Plain fetch fallback works ✓ (Task 5 test)
- `AGENTS.md` carries routing rule ✓ (Task 7 test)
- All existing tests still pass ✓ (Step 1)

- [ ] **Step 4: Final commit if anything fell out of the scan**

If clean, no commit needed.

---

## Self-Review Notes

- **Spec coverage:** All six components covered. Components 1-3 → Tasks 1-4 + 6. Component 4 → Task 5. Component 5 → Task 7. Component 6 → Task 8.
- **Type consistency:** Resolver name `resolveLightpanda` consistent across `lightpanda.mjs`, `web.mjs`, and test injections (`resolveLightpandaImpl`). Spawn name `spawnImpl`. Parser strings exact: `"lightpanda+readability+turndown"` and `"readability+turndown"` — no variations.
- **Risk:** Task 5 modifies `tests/cli/v1_4_0.test.mjs` flow indirectly. If those tests fail because the dev machine has lightpanda installed, the fix is in Task 5 Step 5 (override `resolveLightpandaImpl: async () => null` in failing tests). Do not regenerate frontmatter snapshots.
- **Zero-dep core:** `lightpanda.mjs` uses only `node:` built-ins. ✓
