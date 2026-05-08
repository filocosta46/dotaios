# Schedules

DotAIOS v1.1 keeps schedules local and manual. There is no background daemon, cloud provider, bundled model, or automatic email workflow.

Schedules live in `~/.aios/schedules.yml`:

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

Run one schedule:

```bash
npx dotaios schedule run weekly-status
```

In v1.1, scheduled commands must start with `dotaios` or `aios`. Use cron, launchd, Task Scheduler, or another local automation tool directly if you want to run arbitrary commands.

Email routines should be installed as optional plugins or skills later. They must confirm before sending mail, creating events, or writing durable memory.
