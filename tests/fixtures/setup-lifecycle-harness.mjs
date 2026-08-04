import fs from "node:fs/promises";
import { setupCommand } from "../../packages/cli/src/commands/setup.mjs";

const lifecycle = {
  afterCreateBaseTree: process.env.DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE === "1"
    ? async () => { throw new Error("injected setup interruption after createBaseTree"); }
    : undefined,
  afterInit: process.env.DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT === "1"
    ? async () => { process.kill(process.pid, "SIGKILL"); }
    : undefined,
  beforePublishMarker: process.env.DOTAIOS_TEST_RACE_SETUP_MARKER === "1"
    ? async ({ markerPath }) => { await fs.writeFile(markerPath, "foreign marker bytes\n", { flag: "wx" }); }
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
