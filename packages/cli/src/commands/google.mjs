import { expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import {
  GWS_READ_ONLY_SCOPES,
  GWS_READ_ONLY_SERVICES,
  assertAiosFolder,
  assessGwsAuth,
  firstLine,
  gwsReadOnlyLoginArgs,
  gwsReadOnlyLoginCommand,
  hasGoogleConnection,
  printCaptured,
  resolveAiosTarget,
  resolveBinary,
  resolveGwsBinary,
  runGws
} from "../lib/gws.mjs";

export async function googleCommand(args) {
  if (hasHelpFlag(args)) {
    printGoogleHelp();
    return;
  }

  const { positional, options } = parseOptions(args);
  const target = resolveAiosTarget(options.path);
  await assertAiosFolder(target);

  const action = parseAction(positional, options);
  const gwsBin = await resolveGwsBinary(options.gwsBin || process.env.DOTAIOS_GWS_BIN || null);
  if (!gwsBin) {
    if (action.kind === "setup" || action.kind === "status" || action.kind === "doctor") {
      if (options.json) {
        printJson({
          ok: false,
          workflow: action.kind,
          gws: { found: false },
          next: "Install Google Workspace CLI, then run dotaios google doctor."
        });
        return;
      }
      printMissingGws({ target });
      return;
    }
    throw new Error("Google Workspace CLI is required. Run `dotaios google setup` for setup guidance.");
  }

  if (action.kind === "status") {
    await printStatus({ target, gwsBin, json: options.json });
    return;
  }

  if (action.kind === "doctor") {
    await printDoctor({ target, gwsBin, json: options.json });
    return;
  }

  if (action.kind === "setup") {
    await printSetup({ target, gwsBin, options });
    return;
  }

  await assertConnected(target);
  await assertAuthenticated(gwsBin);

  const gwsArgs = buildGwsArgs(action, options);
  const result = runGws(gwsBin, gwsArgs);
  if (options.json) {
    printJson({
      ok: result.status === 0,
      workflow: action.kind,
      label: action.label,
      source: "gws",
      command: ["gws", ...gwsArgs],
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      status: result.status
    });
  } else {
    console.log(`DotAIOS Google: ${action.label}`);
    console.log(`Running: gws ${gwsArgs.join(" ")}`);
    console.log("");
    printCaptured(result);
  }
  if (result.status !== 0) {
    throw new Error(`gws command failed with status ${result.status}`);
  }
}

function printGoogleHelp() {
  console.log(`Usage:
  dotaios google status [options]
  dotaios google doctor [options]
  dotaios google setup [options]
  dotaios google inbox [options]
  dotaios google gmail search <query> [options]
  dotaios google gmail read <message-id> [options]
  dotaios google agenda [options]
  dotaios google calendar prep [options]
  dotaios google drive [options]
  dotaios google drive find <query> [options]

Optional, read-only Google Workspace workflows powered by the local gws CLI.

Options:
  --path <dir>       Use a non-default AIOS folder
  --gws-bin <bin>    Use a specific gws binary
  --today            Agenda: show today's events
  --tomorrow         Agenda: show tomorrow's events
  --week             Agenda: show this week's events
  --days <n>         Agenda: show n days ahead
  --calendar <id>    Agenda: filter to a calendar name or ID
  --timezone <tz>    Agenda: override timezone
  --page-size <n>    Drive: number of files to list (default: 10)
  --query <q>        Gmail/Drive search query
  --message-id <id>  Gmail message ID to read
  --json             Print a JSON envelope for agents or local automation
  --project <id>     Setup: use a specific Google Cloud project
  --run              Setup: run gws auth setup/login when ready

Examples:
  dotaios google status
  dotaios google doctor
  dotaios google setup
  dotaios google inbox
  dotaios google gmail search "from:alice@example.com newer_than:7d"
  dotaios google gmail read 187abc123
  dotaios google agenda --today
  dotaios google calendar prep --today
  dotaios google agenda --week
  dotaios google drive --page-size 5
  dotaios google drive find "budget"
`);
}

function parseOptions(args = []) {
  const options = {
    calendar: null,
    days: null,
    gwsBin: null,
    pageSize: 10,
    path: null,
    project: null,
    query: null,
    messageId: null,
    timezone: null,
    today: false,
    tomorrow: false,
    week: false,
    json: false,
    run: false
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--gws-bin") {
      options.gwsBin = expandHome(readOptionValue(args, index, "--gws-bin"));
      index += 1;
    } else if (arg === "--today") {
      options.today = true;
    } else if (arg === "--tomorrow") {
      options.tomorrow = true;
    } else if (arg === "--week") {
      options.week = true;
    } else if (arg === "--days") {
      options.days = readPositiveInteger(args, index, "--days");
      index += 1;
    } else if (arg === "--calendar") {
      options.calendar = readOptionValue(args, index, "--calendar");
      index += 1;
    } else if (arg === "--timezone") {
      options.timezone = readOptionValue(args, index, "--timezone");
      index += 1;
    } else if (arg === "--page-size") {
      options.pageSize = readPositiveInteger(args, index, "--page-size");
      index += 1;
    } else if (arg === "--query") {
      options.query = readOptionValue(args, index, "--query");
      index += 1;
    } else if (arg === "--message-id" || arg === "--id") {
      options.messageId = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
    } else if (arg === "--services" || arg === "--scopes" || arg === "--full") {
      throw new Error(`${arg} is not supported. DotAIOS Google uses fixed Gmail, Calendar, and Drive read-only access.`);
    } else if (arg === "--run") {
      options.run = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function parseAction(positional, options = {}) {
  const [areaRaw, subcommandRaw, ...rest] = positional;
  const area = areaRaw?.toLowerCase();
  const subcommand = subcommandRaw?.toLowerCase();
  const restText = rest.join(" ");
  if (!area || area === "status") return { kind: "status", label: "status" };
  if (area === "doctor") return { kind: "doctor", label: "Google doctor" };
  if (area === "setup") return { kind: "setup", label: "Google setup" };

  if (area === "inbox" || area === "triage") {
    return { kind: "gmail-triage", label: "Gmail inbox triage" };
  }

  if (area === "gmail") {
    if (!subcommand || subcommand === "triage" || subcommand === "inbox") {
      return { kind: "gmail-triage", label: "Gmail inbox triage" };
    }
    if (subcommand === "search") {
      return { kind: "gmail-search", label: "Gmail search", query: options.query || restText };
    }
    if (subcommand === "read") {
      return { kind: "gmail-read", label: "Gmail message read", messageId: options.messageId || restText };
    }
    throw new Error("Unsupported Gmail workflow. Try `dotaios google inbox`.");
  }

  if (area === "agenda") {
    return { kind: "calendar-agenda", label: "Calendar agenda" };
  }

  if (area === "calendar") {
    if (!subcommand || subcommand === "agenda") {
      return { kind: "calendar-agenda", label: "Calendar agenda" };
    }
    if (subcommand === "prep") {
      return { kind: "calendar-prep", label: "Calendar meeting prep" };
    }
    throw new Error("Unsupported Calendar workflow. Try `dotaios google agenda --today`.");
  }

  if (area === "drive") {
    if (!subcommand || subcommand === "list") {
      return { kind: "drive-list", label: "Drive files" };
    }
    if (subcommand === "find" || subcommand === "search") {
      return { kind: "drive-find", label: "Drive file search", query: options.query || restText };
    }
    throw new Error("Unsupported Drive workflow. Try `dotaios google drive`.");
  }

  throw new Error(`Unsupported Google workflow: ${area}. Try \`dotaios google --help\`.`);
}

function printMissingGws({ target }) {
  console.log("DotAIOS Google setup");
  console.log(`AIOS path: ${target}`);
  console.log("[missing] gws CLI");
  console.log("");
  console.log("Install Google Workspace CLI first:");
  console.log("- npm:  `npm install -g @googleworkspace/cli`");
  console.log("- brew: `brew install googleworkspace-cli`");
  console.log("- releases: https://github.com/googleworkspace/cli/releases");
  console.log("");
  console.log("Then run:");
  console.log("1. `dotaios google setup`");
  console.log("2. `dotaios connect google`");
  console.log("3. `dotaios google inbox`");
}

async function printStatus({ target, gwsBin, json = false }) {
  const version = runGws(gwsBin, ["--version"]);
  const connected = await hasGoogleConnection(target);
  const auth = runGws(gwsBin, ["auth", "status"]);
  const authState = assessGwsAuth(auth);

  if (json) {
    printJson({
      ok: Boolean(version.status === 0 && connected && authState.ready),
      workflow: "status",
      aiosPath: target,
      gws: {
        found: true,
        binary: gwsBin,
        version: firstLine(version.stdout) || null
      },
      connected,
      auth: authState
    });
    return;
  }

  console.log("DotAIOS Google status");
  console.log(`AIOS path: ${target}`);
  console.log(`[ok] gws: ${gwsBin}`);

  if (version.status === 0) {
    console.log(`[ok] ${firstLine(version.stdout) || "gws version detected"}`);
  } else {
    console.log("[check] Could not read gws version");
  }

  console.log(`${connected ? "[ok]" : "[missing]"} DotAIOS Google connection note`);
  if (!connected) {
    console.log("[action] Run `dotaios connect google` before read-first workflows.");
  }

  if (authState.ready) {
    console.log("[ok] gws auth status");
    console.log(`      ${authState.summary}`);
  } else {
    console.log("[missing] gws auth status");
    console.log(`      ${authState.summary}`);
    if (auth.status !== 0) printCaptured(auth);
    console.log(`[action] Run \`${gwsReadOnlyLoginCommand()}\`, then \`dotaios connect google\`.`);
  }
}

async function printDoctor({ target, gwsBin, json = false }) {
  const version = runGws(gwsBin, ["--version"]);
  const connected = await hasGoogleConnection(target);
  const auth = runGws(gwsBin, ["auth", "status"]);
  const authState = assessGwsAuth(auth);
  const gcloudBin = await resolveBinary("gcloud");
  const checks = [
    { name: "gws binary", ok: true, detail: gwsBin },
    { name: "gws version", ok: version.status === 0, detail: firstLine(version.stdout) || firstLine(version.stderr) || "unknown" },
    { name: "gws auth", ok: authState.ready, detail: authState.summary },
    { name: "DotAIOS connection", ok: connected, detail: connected ? "connections/apis/google-workspace.md exists" : "run dotaios connect google" },
    { name: "gcloud helper", ok: Boolean(gcloudBin), detail: gcloudBin || "optional; needed for easiest OAuth setup" }
  ];
  const next = nextGoogleDoctorAction({ connected, authReady: authState.ready, gcloudReady: Boolean(gcloudBin) });

  if (json) {
    printJson({
      ok: checks.every((check) => check.ok || check.name === "gcloud helper"),
      workflow: "doctor",
      aiosPath: target,
      checks,
      services: ["gmail", "calendar", "drive"],
      security: {
        green: "local DotAIOS reads",
        yellow: "read Google data into terminal output",
        red: "send/edit/delete Google data or durable context writes",
        black: "OAuth secrets, refresh tokens, credential files, private keys"
      },
      next
    });
    return;
  }

  console.log("DotAIOS Google doctor");
  console.log(`AIOS path: ${target}`);
  console.log("");
  for (const check of checks) {
    console.log(`${check.ok ? "[ok]" : "[missing]"} ${check.name}: ${check.detail}`);
  }
  console.log("");
  console.log("Available read-first DotAIOS wrappers:");
  console.log("- dotaios google inbox");
  console.log("- dotaios google gmail search <query>");
  console.log("- dotaios google gmail read <message-id>");
  console.log("- dotaios google agenda --today");
  console.log("- dotaios google calendar prep --today");
  console.log("- dotaios google drive find <query>");
  console.log("");
  console.log("Security lanes:");
  console.log("- Green: local DotAIOS reads");
  console.log("- Yellow: read Google data into terminal output");
  console.log("- Red: send/edit/delete Google data or durable context writes");
  console.log("- Black: OAuth secrets, refresh tokens, credential files, private keys");
  console.log("");
  console.log(`[next] ${next}`);
}

async function printSetup({ target, gwsBin, options }) {
  console.log("DotAIOS Google setup");
  console.log(`AIOS path: ${target}`);
  console.log(`[ok] gws: ${gwsBin}`);
  console.log("");
  console.log("What this setup really means:");
  console.log("1. Google requires an OAuth client for Gmail, Calendar, and Drive access.");
  console.log("2. The easiest path is `gws auth setup`, but it requires the Google Cloud CLI (`gcloud`).");
  console.log("3. DotAIOS stores no OAuth credentials; `gws` owns the credentials.");
  console.log(`4. Services are fixed to: ${GWS_READ_ONLY_SERVICES.join(", ")}.`);
  console.log("5. DotAIOS requests these read-only OAuth scopes (existing grant scopes are not verified by gws auth status):");
  for (const scope of GWS_READ_ONLY_SCOPES) console.log(`   - ${scope}`);

  const auth = runGws(gwsBin, ["auth", "status"]);
  const authState = assessGwsAuth(auth);
  if (authState.ready) {
    console.log("");
    console.log(`[ok] gws auth is ready (${authState.summary})`);
    console.log("[next] Run `dotaios connect google`, then `dotaios google inbox`.");
    return;
  }

  console.log("");
  console.log(`[missing] gws auth is not ready: ${authState.summary}`);
  const gcloudBin = await resolveBinary("gcloud");
  if (gcloudBin) {
    console.log(`[ok] gcloud: ${gcloudBin}`);
    console.log("");
    console.log("Recommended setup path:");
    console.log(`1. \`${formatShellCommand(["gws", "auth", "setup", ...setupArgs(options)])}\``);
    console.log(`2. \`${formatShellCommand(["gws", "auth", "login", ...loginArgs()])}\``);
    console.log("3. `dotaios connect google`");
    console.log("4. `dotaios google status`");

    if (options.run) {
      console.log("");
      console.log("Running `gws auth setup` now. Follow the browser/terminal prompts.");
      const setup = runGws(gwsBin, ["auth", "setup", ...setupArgs(options)]);
      printCaptured(setup);
      if (setup.status !== 0) {
        throw new Error(`gws auth setup failed with status ${setup.status}`);
      }

      console.log("");
      console.log("Running Google Workspace login.");
      const login = runGws(gwsBin, ["auth", "login", ...loginArgs()]);
      printCaptured(login);
      if (login.status !== 0) {
        throw new Error(`gws auth login failed with status ${login.status}`);
      }
    } else {
      console.log("");
      console.log("Run with `--run` only when you are ready to let `gws` open browser/auth prompts.");
    }
  } else {
    console.log("[missing] gcloud CLI");
    console.log("");
    console.log("Manual setup path:");
    console.log("1. Install and authenticate the Google Cloud CLI, then rerun this command.");
    console.log("2. Or create a Google Cloud project + Desktop OAuth client manually.");
    console.log("3. Place the OAuth client at `~/.config/gws/client_secret.json`.");
    console.log(`4. Run \`${formatShellCommand(["gws", "auth", "login", ...loginArgs()])}\`.`);
    console.log("");
    console.log("Product note: this is still too technical for casual friends. Treat Google as an assisted beta feature until DotAIOS has a hosted/verified OAuth app or a better setup wrapper.");
  }
}

function setupArgs(options) {
  return options.project ? ["--project", options.project] : [];
}

function nextGoogleDoctorAction({ connected, authReady, gcloudReady }) {
  if (!authReady && gcloudReady) return "Run dotaios google setup, then dotaios connect google.";
  if (!authReady) return `Install/authenticate gcloud or create a Desktop OAuth client, then run ${gwsReadOnlyLoginCommand()}.`;
  if (!connected) return "Run dotaios connect google.";
  return "Try dotaios google inbox or dotaios google agenda --today.";
}

function loginArgs() {
  return gwsReadOnlyLoginArgs();
}

function formatShellCommand(args) {
  return args.map((arg) => (/^[A-Za-z0-9_./:=,+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)).join(" ");
}

async function assertConnected(target) {
  if (await hasGoogleConnection(target)) return;
  throw new Error("Google Workspace is not connected in this AIOS. Run `dotaios connect google` first.");
}

async function assertAuthenticated(gwsBin) {
  const auth = runGws(gwsBin, ["auth", "status"]);
  const authState = assessGwsAuth(auth);
  if (authState.ready) return;

  console.log(authState.summary);
  if (auth.status !== 0) printCaptured(auth);
  throw new Error(`Google Workspace auth is not ready. Run \`${gwsReadOnlyLoginCommand()}\`, then retry.`);
}

function buildGwsArgs(action, options) {
  if (action.kind === "gmail-triage") {
    return ["gmail", "+triage"];
  }

  if (action.kind === "gmail-search") {
    if (!action.query) throw new Error("Usage: dotaios google gmail search <query>");
    return ["gmail", "messages", "list", "--params", JSON.stringify({ q: action.query, maxResults: options.pageSize })];
  }

  if (action.kind === "gmail-read") {
    if (!action.messageId) throw new Error("Usage: dotaios google gmail read <message-id>");
    return ["gmail", "messages", "get", "--params", JSON.stringify({ id: action.messageId, format: "full" })];
  }

  if (action.kind === "calendar-agenda") {
    const periodFlags = [options.today, options.tomorrow, options.week, Boolean(options.days)].filter(Boolean);
    if (periodFlags.length > 1) {
      throw new Error("Use only one agenda range: --today, --tomorrow, --week, or --days.");
    }

    const args = ["calendar", "+agenda"];
    if (options.today) args.push("--today");
    if (options.tomorrow) args.push("--tomorrow");
    if (options.week) args.push("--week");
    if (options.days) args.push("--days", String(options.days));
    if (options.calendar) args.push("--calendar", options.calendar);
    if (options.timezone) args.push("--timezone", options.timezone);
    return args;
  }

  if (action.kind === "calendar-prep") {
    return buildGwsArgs({ kind: "calendar-agenda" }, options);
  }

  if (action.kind === "drive-list") {
    return ["drive", "files", "list", "--params", JSON.stringify({ pageSize: options.pageSize })];
  }

  if (action.kind === "drive-find") {
    if (!action.query) throw new Error("Usage: dotaios google drive find <query>");
    return ["drive", "files", "list", "--params", JSON.stringify({
      q: `name contains '${escapeGoogleQueryLiteral(action.query)}'`,
      pageSize: options.pageSize
    })];
  }

  throw new Error(`Unsupported Google workflow: ${action.kind}`);
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function escapeGoogleQueryLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function readPositiveInteger(args, index, optionName) {
  const value = readOptionValue(args, index, optionName);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return Number(value);
}
