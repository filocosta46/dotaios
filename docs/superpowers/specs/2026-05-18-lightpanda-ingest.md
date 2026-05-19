# Lightpanda Web Ingest Integration

> Status: approved for implementation
> Date: 2026-05-18

## Summary

DotAIOS integrates Lightpanda — a headless browser engine — as the default web fetcher for `dotaios ingest`. Users never configure it. It downloads automatically during `dotaios setup` and is used transparently for all URL ingestion. All agents are instructed via `AGENTS.md` to route URLs through `dotaios ingest`, giving every agent a real browser backend with zero setup.

## Goals

- Lightpanda installs automatically during `dotaios setup` — user sees one status line, no questions
- `dotaios ingest <url>` uses Lightpanda when available; falls back to plain fetch if missing or if it fails
- All agents (Claude Code, Codex, Gemini, any future agent) route URL reading through `dotaios ingest`
- Existing users without Lightpanda get it on their next `dotaios ingest` call (prompt once, then silent)
- Windows falls back gracefully — no Lightpanda binary for Windows exists, plain fetch is used

## Non-Goals

- MCP `fetch_url` tool — separate feature
- Browser automation (form filling, clicking) — separate project
- Lightpanda version pinning or auto-update — use latest release
- Bundling Lightpanda binary inside the npm package tarball

## Architecture

### Component 1: Lightpanda binary helpers (`packages/core/src/paths.mjs`)

Two new exports:

```js
export function dotaiosBinDir() {
  return path.join(os.homedir(), ".dotaios", "bin");
}

export function lightpandaBinPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(dotaiosBinDir(), `lightpanda${ext}`);
}
```

### Component 2: Download helper (`packages/core/src/lightpanda.mjs`)

New file. Exports:

- `lightpandaPlatformBinary()` — returns the GitHub binary filename for the current platform, or `null` if unsupported (Windows):

```
darwin + arm64  → "lightpanda-aarch64-macos"
darwin + x64    → "lightpanda-x86_64-macos"
linux + arm64   → "lightpanda-aarch64-linux"
linux + x64     → "lightpanda-x86_64-linux"
win32 + any     → null
```

- `downloadLightpanda({ silent, fetchImpl, now })` — downloads the binary to `~/.dotaios/bin/lightpanda`, sets executable bit (Unix), returns `{ ok: true }` or `{ ok: false, reason }`. Non-fatal — never throws.
  - Download URL: `https://github.com/lightpanda-io/browser/releases/latest/download/{binary}`
  - Creates `~/.dotaios/bin/` if missing
  - `silent` flag: suppress console output (for setup integration)

- `resolveLightpanda()` — returns the path to a usable lightpanda binary or `null`:
  1. Check `lightpandaBinPath()` — exists and executable? Return it.
  2. Check PATH (`which lightpanda` / `where lightpanda`) — found? Return it.
  3. Return `null`.

### Component 3: Setup integration (`packages/cli/src/commands/setup.mjs`)

After the existing setup wizard completes (identity, bridges, skills), add:

```
⬇  Installing Lightpanda for web browsing...  ✓
```

One status line. If download fails, print a brief warning and continue — setup does not fail because of Lightpanda.

Platform check: if `lightpandaPlatformBinary()` returns `null` (Windows), skip silently.

### Component 4: Lightpanda-backed ingest (`packages/cli/src/ingest/web.mjs`)

In `ingestUrl()`, replace the `fetchWithTimeout()` call with a dispatching function:

```
fetchHtml(url, options):
  1. lp = resolveLightpanda()
  2. If lp found:
     a. spawnSync(lp, ["fetch", "--dump", url], { timeout: timeoutMs, encoding: "utf8" })
     b. If exit code 0 and stdout non-empty: return { html: stdout, parser: "lightpanda" }
     c. If failed: log warning, fall through
  3. Fall back to fetchWithTimeout() → return { html: await response.text(), parser: "readability" }
```

`parser` field in frontmatter:
- With Lightpanda: `"lightpanda+readability+turndown"`
- Without: `"readability+turndown"` (unchanged)

The PDF content-type check (`.pdf` URLs via plain HTTP response) stays on the plain-fetch branch only.

On-demand prompt for existing users: if `resolveLightpanda()` returns null AND platform is supported AND `~/.dotaios/.lightpanda_hint_shown` does not exist, print once:
```
Tip: run `dotaios setup` to install Lightpanda for better web scraping.
```
Write `~/.dotaios/.lightpanda_hint_shown` after printing so the hint shows only once.

### Component 5: AGENTS.md routing rule (`templates/AGENTS.md.hbs`)

Add under `## Rules`:

```markdown
- When the user shares a URL, run `dotaios ingest <url>` to read and save it. This uses a local headless browser that renders JavaScript. Prefer it over your own web fetch tools.
```

### Component 6: README update (`README.md`)

Add one line to the ingest section:

```markdown
Web pages are fetched using Lightpanda, a lightweight headless browser that renders JavaScript. It installs automatically during `dotaios setup`.
```

## File Map

| File | Change |
|---|---|
| `packages/core/src/paths.mjs` | Add `dotaiosBinDir()`, `lightpandaBinPath()` |
| `packages/core/src/lightpanda.mjs` | New — platform detection, download, resolve |
| `packages/cli/src/commands/setup.mjs` | Add Lightpanda download step after wizard |
| `packages/cli/src/ingest/web.mjs` | Lightpanda-backed fetch with fallback |
| `templates/AGENTS.md.hbs` | URL routing rule |
| `README.md` | Lightpanda mention in ingest section |
| `tests/core/lightpanda.test.mjs` | New — all lightpanda.mjs exports |
| `tests/cli/ingest_routing.test.mjs` | Add lightpanda path + fallback tests |

## Test Plan

### `tests/core/lightpanda.test.mjs`

- `lightpandaPlatformBinary()` returns correct binary name for darwin/arm64, darwin/x64, linux/x64, linux/arm64
- `lightpandaPlatformBinary()` returns `null` for win32
- `downloadLightpanda()` writes binary to correct path and sets executable bit (stub fetch + fs)
- `downloadLightpanda()` returns `{ ok: false, reason }` on network failure without throwing
- `resolveLightpanda()` returns local bin path when it exists
- `resolveLightpanda()` returns PATH binary when local missing but PATH has it
- `resolveLightpanda()` returns null when neither found

### `tests/cli/ingest_routing.test.mjs`

- Lightpanda available + succeeds → parser is `"lightpanda+readability+turndown"`
- Lightpanda available + crashes → falls back to plain fetch → parser is `"readability+turndown"`
- Lightpanda not found → uses plain fetch → no error

### Template test (existing render tests)

- Generated `AGENTS.md` includes URL routing rule with `dotaios ingest`

## Error Handling

- Lightpanda download fails during setup: warn, continue, do not block setup
- Lightpanda crashes during ingest: log one-line warning, fall back silently
- Unsupported platform (Windows): no download, no hint, silent fallback
- `spawnSync` timeout: treat as crash, fall back

## Acceptance Criteria

- `npx dotaios setup` on Mac/Linux → Lightpanda binary exists at `~/.dotaios/bin/lightpanda` when done
- `dotaios ingest https://react-heavy-spa.com` → returns rendered content, frontmatter shows `lightpanda+readability+turndown`
- `dotaios ingest <url>` with lightpanda missing → works with plain fetch, no crash
- All agents receive the URL routing instruction via `AGENTS.md`
- All 249+ existing tests continue to pass
