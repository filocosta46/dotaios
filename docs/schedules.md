# Schedules

DotAIOS keeps schedules local and manual. There is no background daemon, cloud provider, bundled model, or automatic email workflow.

Schedules live in `~/aios/schedules.yml`:

```yaml
schedules:
  - name: weekly-status
    cadence: weekly
    command: "dotaios status"
    enabled: true
```

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
npx dotaios schedule run weekly-status
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
