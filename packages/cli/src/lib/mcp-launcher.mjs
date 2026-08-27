import fs from "node:fs";
import {
  exactCandidatePackage,
  npxExecutable
} from "../../../core/src/bridges.mjs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
);

export const DOTAIOS_PACKAGE_VERSION = packageJson.version;

export function mcpLauncher(
  aiosPath,
  version = DOTAIOS_PACKAGE_VERSION,
  { platform = process.platform } = {}
) {
  return {
    command: npxExecutable({ platform }),
    args: [
      "--yes",
      "--package",
      exactCandidatePackage(version),
      "dotaios-mcp",
      "--path",
      aiosPath
    ]
  };
}
