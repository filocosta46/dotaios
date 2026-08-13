# DotAIOS: Friend Setup

You run these commands yourself in Terminal. Do not paste an install prompt into
an AI chat. An assistant can inspect the source or verify the finished setup.

## You need

- macOS or Linux;
- Node.js 20 or newer (`node --version`);
- at least one local AI tool, such as Claude Code or Codex.

You do not need a GitHub account, npm account, or paid plan.

## 1. Preview

```sh
npx dotaios@2.0.3 setup --dry-run
```

npm may ask to download the pinned package. The DotAIOS preview itself does not
create `~/aios`, change client configuration, enable sync, or copy credentials.
It shows the selected folder, detected clients, and collisions.

Want to inspect the package first? Follow the provenance checks in
[`../INSTALL.md`](../INSTALL.md).

## 2. Set up

```sh
npx dotaios@2.0.3 setup
```

Answer the short questions. Existing unmanaged files are preserved. Private
sync, daily scheduling, conversation saving, history backfill, and the optional
browser helper all default to No.

## 3. Verify

```sh
npx dotaios@2.0.3 doctor
npx dotaios@2.0.3 skills doctor
```

Then open the AI tool you use and ask:

> Read my DotAIOS context and tell me what I am working on.

If the tool was already open during setup, restart it first so it reloads its
managed configuration.

## If setup stops

- Existing `~/aios`: do not delete it. Run
  `npx dotaios@2.0.3 doctor` and inspect the folder.
- Existing AI-tool instructions: DotAIOS preserves them. Read the reported
  collision before deciding whether to change anything.
- `npx: command not found`: install the Node.js LTS release from
  [nodejs.org](https://nodejs.org), then check `node --version` again.
- Agent refusal: expected if the assistant was asked to execute remote
  instructions. Run setup yourself, then ask it only to inspect the result.

## Remove it later

DotAIOS has no hosted account or subscription to cancel. See
[`../INSTALL.md#disconnect-or-remove`](../INSTALL.md#disconnect-or-remove) for
the exact managed paths. Back up any context you want to keep and never delete
unmanaged client configuration.
