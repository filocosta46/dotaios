# Schedules

DotAIOS keeps schedules local and manual. There is no background daemon, cloud provider, bundled model, or automatic email workflow.

Schedules live in `~/aios/schedules.yml`:

```yaml
schedules:
  - name: daily-brief
    cadence: daily
    command: "dotaios brief"
    enabled: false
```

New AIOS folders include that disabled daily brief schedule. Change
`enabled: false` to `enabled: true` when you want DotAIOS to write a local
brief on cadence.

Supported cadence values:

- `manual`
- `daily`
- `weekly`
- `monthly`

## Commands

List schedules:

```bash
npx dotaios schedule list
```

Show schedules due now:

```bash
npx dotaios schedule due
```

Run every due schedule:

```bash
npx dotaios schedule run-due
```

Run one schedule:

```bash
npx dotaios schedule run daily-brief
```

Check local automation setup:

```bash
npx dotaios schedule doctor
```

Preview an OS scheduler handoff:

```bash
npx dotaios schedule install --dry-run --target launchd
npx dotaios schedule install --dry-run --target cron
npx dotaios schedule install --dry-run --target task-scheduler
```

Scheduled commands must start with `dotaios` or `aios`. Use cron, launchd, Task Scheduler, or another local automation tool directly if you want to run arbitrary commands.

DotAIOS does not install a background daemon. The OS handoff calls `dotaios schedule run-due` on an interval, and each schedule still runs only DotAIOS commands.

Google Workspace beta setup lives behind `dotaios connect google`. Email and calendar routines must remain read-first by default, and must confirm before sending mail, creating events, or writing durable memory.

## Keeping skills updated

New AIOS folders also include a disabled `weekly-skills-update` schedule that
runs `dotaios skills doctor` on a weekly cadence. Enable it if you want the
health report on a schedule.

The richer path is the `update-skills` skill: ask your agent "update my
skills" and it checks installed packs and plugins for upstream changes,
reinstalls updated ones through the guarded install path, refreshes catalogs
and native links, and records a `skills-update` event in
`memory/events.jsonl`. Agents are encouraged to offer this check when the
last recorded run is more than 7 days old.
