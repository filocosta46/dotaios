# DotAIOS: Friend Setup

The recommended path is to ask a local AI agent that can run commands to guide
the install. You make the meaningful choices; the agent handles Node, npm, the
preview, setup, and verification. Running the same commands yourself remains a
recovery path.

## You need

- macOS, Linux, or Windows;
- at least one local AI tool, such as Claude Code or Codex.

DotAIOS needs Node.js 20 or newer, but you do not need to install or understand
it first. The assisting agent checks and installs the supported LTS release when
it is missing, following [`../INSTALL.md`](../INSTALL.md).

You do not need a GitHub account, npm account, or paid plan.

## 1. Paste one request

Open a local agent that can run commands and paste:

> Help me install DotAIOS by following the “If an AI assistant is helping you”
> section of https://github.com/filocosta46/dotaios/blob/v2.0.5/INSTALL.md. Preview
> every change first, ask me only about choices I can evaluate, then verify the
> setup and show me my one AIOS folder.

The agent should then run the pinned preview below. If you are recovering
manually, run it yourself:

```sh
npx dotaios@2.0.5 setup --dry-run
```

npm may ask to download the pinned package. The DotAIOS preview itself does not
create `~/aios`, change client configuration, enable sync, or copy credentials.
It shows the selected folder, detected clients, and collisions.

Want to inspect the package first? Follow the provenance checks in
[`../INSTALL.md`](../INSTALL.md).

## 2. Approve the preview and set up

The agent should ask the same five questions from INSTALL.md's assistant
section, one at a time in the conversation, then pipe the answers straight
into setup so no answers file is left behind:

```sh
npx dotaios@2.0.5 setup --answers - <<'JSON'
{
  "name": "...",
  "role": "...",
  "work": "...",
  "priorities": "...",
  "ai_tools": ["claude-code", "codex", "cursor"]
}
JSON
```

If you are recovering manually, run it yourself and answer the short
questions at the terminal prompt:

```sh
npx dotaios@2.0.5 setup
```

Existing unmanaged files are preserved. Private sync, daily scheduling,
conversation saving, history backfill, and the optional browser helper all
default to No.

## 3. Verify

```sh
npx dotaios@2.0.5 doctor
npx dotaios@2.0.5 skills doctor
```

Then start a connected local agent from your usual folder or an attached
project—not from inside the printed AIOS storage folder. If the current folder
resolves to an explicitly registered project with a slug or stable ID, make the
first message:

> Only this project. Read my DotAIOS context and tell me what I am working on.

Otherwise, make the first message:

> Use my memory. Read my DotAIOS context and tell me what I am working on.

To verify Off, start another new session and make the first message:

> Private chat. Do not use my DotAIOS memory.

The agent should visibly reply with `Memory: This project`, `Memory: Shared`, or
`Memory: Off`, matching the first message.

If the tool was already open during setup, restart it first so it reloads its
managed configuration.

## If setup stops

- Existing `~/aios`: do not delete it. Run
  `npx dotaios@2.0.5 doctor` and inspect the folder.
- Existing AI-tool instructions: DotAIOS preserves them. Read the reported
  collision before deciding whether to change anything.
- `npx: command not found`: install the Node.js LTS release from
  [nodejs.org](https://nodejs.org), then check `node --version` again.
- Agent refusal: use another local agent that can review and run commands, or
  follow the same pinned preview and setup commands yourself.

## Remove it later

DotAIOS has no hosted account or subscription to cancel. See
[`../INSTALL.md#disconnect-or-remove`](../INSTALL.md#disconnect-or-remove) for
the exact managed paths. Back up any context you want to keep and never delete
unmanaged client configuration.
