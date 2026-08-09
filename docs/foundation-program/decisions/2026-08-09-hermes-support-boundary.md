# Hermes Support Boundary

Date: 2026-08-09
Status: accepted for the Foundation reliability programme

## Context

The prelaunch implementation wrote `<project>/.hermes/config.yaml` and treated
that file as project-skill configuration. Focused DotAIOS tests passed, but an
installed Hermes v0.18.2 runtime and its source showed that relative external
directories are resolved from the selected `HERMES_HOME`, and Hermes reads
`$HERMES_HOME/config.yaml`. `dotaios attach` did not set `HERMES_HOME`, install
a launcher, or otherwise make the checkout-local file authoritative. The
adapter could therefore report a configured and discoverable surface that an
ordinary Hermes launch never loaded.

Older Hermes releases also resolved relative paths from the process working
directory. A project-relative spelling cannot be normalized safely without a
version or capability contract. Hermes one-shot mode auto-bypasses approvals,
so the current bounded probe cannot use it as a safe launch receipt.

Evidence:

- installed Hermes v0.18.2 source and a disposable `hermes skills list` smoke;
- upstream [skill loader](https://github.com/NousResearch/hermes-agent/blob/main/agent/skill_utils.py);
- upstream [project-local discovery gap](https://github.com/NousResearch/hermes-agent/issues/4667);
- upstream [relative-path semantic change](https://github.com/NousResearch/hermes-agent/issues/9949);
- `docs/foundation-program/research/2026-08-09-host-contracts.md`;
- `docs/foundation-program/audits/2026-08-09-imac-independent-audit.md`.

## Decision

DotAIOS supports only the global Hermes configuration adapter:
`~/aios/skills` may be registered in the selected global
`~/.hermes/config.yaml` or a discovered global profile. The bundled registry
has no Hermes `skills.project` target. Project attachment does not create,
rewrite, migrate, or validate `<project>/.hermes/config.yaml`.

The Hermes project probe reports `configured=no`, `discoverable=no`,
`invoked=not-run`, and `produced=not-run`, with the missing selector and unsafe
one-shot mode recorded as limitations. It does not stage an inert config.

The supported global YAML adapter parses the complete document before editing,
fails closed on invalid or structurally ambiguous YAML, preserves comments and
foreign scalar values, quotes inserted paths when YAML punctuation would alter
their value, rejects multiline path injection, and reparses every candidate to
prove the exact path is present in a scalar sequence before writing. Writes
reject symlinked or non-regular targets and unsafe parent paths, compare the
original bytes and inode before replacement, fail closed on invalid UTF-8,
serialize DotAIOS writers with a recoverable per-file lock, preserve an exact
byte backup, and use an atomic final rename so the live config is never
temporarily absent. External editors do not share that lock, so a narrow final
check-to-rename race remains explicit rather than being called filesystem CAS.

## Project support re-entry gates

Project-local Hermes support may return only when all of these are true:

1. DotAIOS owns an explicit runtime selector or launcher that proves which
   `HERMES_HOME/config.yaml` Hermes will load.
2. The adapter declares and enforces the Hermes version or capability that
   determines the relative-path resolution base.
3. The bounded probe has a safe host mode that does not auto-bypass approvals.
4. An independent receipt proves the selected host discovered and invoked the
   exact disposable project skill.
5. Production attachment, health inspection, and the probe consume one shared
   target-resolution contract.

Until then, a missing feature is preferable to a green receipt for an inert
file.

## Consequences

- Project skills remain available through the documented Claude Code and
  shared `.agents/skills` targets.
- Existing user-authored project Hermes files remain byte-identical.
- Global Hermes registration remains configuration evidence, not invocation or
  production evidence.
- Release copy must say “global adapter only” and must not imply project-local
  Hermes support.
