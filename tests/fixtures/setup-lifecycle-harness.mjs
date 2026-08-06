import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { setupCommand } from "../../packages/cli/src/commands/setup.mjs";

async function pauseAtBarrier(barrierPath) {
  await fs.writeFile(`${barrierPath}.ready`, "ready\n", { flag: "wx" });
  while (true) {
    try {
      await fs.access(`${barrierPath}.release`);
      return;
    } catch {
      await delay(10);
    }
  }
}

const lifecycle = {
  afterCreateBaseTree: process.env.DOTAIOS_TEST_RACE_SETUP_ENTRYPOINT === "1"
    ? async ({ aiosPath }) => {
        await fs.writeFile(`${aiosPath}/AGENTS.md`, "foreign entrypoint bytes\n", { flag: "wx" });
      }
    : process.env.DOTAIOS_TEST_RACE_SETUP_CATALOGS === "1"
      ? async ({ aiosPath }) => {
          await fs.writeFile(`${aiosPath}/skills/INDEX.md`, "foreign index bytes\n", { flag: "wx" });
          await fs.writeFile(`${aiosPath}/skills/RESOLVER.md`, "foreign resolver bytes\n", { flag: "wx" });
        }
      : process.env.DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE === "1"
        ? async () => { throw new Error("injected setup interruption after createBaseTree"); }
        : undefined,
  afterInit: process.env.DOTAIOS_TEST_RACE_SETUP_AFTER_INIT_ENTRYPOINT === "1"
    ? async ({ aiosPath }) => {
        await fs.writeFile(`${aiosPath}/AGENTS.md`, "foreign bytes after init\n");
      }
    : process.env.DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT === "1"
      ? async () => { process.kill(process.pid, "SIGKILL"); }
      : undefined,
  beforePublishMarker: process.env.DOTAIOS_TEST_INTERRUPT_SETUP_BEFORE_MARKER_LINK === "1"
    ? async () => { process.kill(process.pid, "SIGKILL"); }
    : process.env.DOTAIOS_TEST_RACE_SETUP_MARKER === "1"
      ? async ({ markerPath }) => { await fs.writeFile(markerPath, "foreign marker bytes\n", { flag: "wx" }); }
      : process.env.DOTAIOS_TEST_PAUSE_SETUP_BEFORE_MARKER_LINK
        ? async () => { await pauseAtBarrier(process.env.DOTAIOS_TEST_PAUSE_SETUP_BEFORE_MARKER_LINK); }
        : undefined,
  afterPublishMarker: process.env.DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_MARKER_LINK === "1"
    ? async () => { process.kill(process.pid, "SIGKILL"); }
    : undefined,
  activation: {
    afterConfigPersisted: process.env.DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_ACTIVATION_CONFIG === "1"
      ? async () => { process.kill(process.pid, "SIGKILL"); }
      : undefined
  }
};

await setupCommand(process.argv.slice(2), { lifecycle });
