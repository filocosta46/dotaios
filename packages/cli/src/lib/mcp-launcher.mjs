import fs from "node:fs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
);

export const DOTAIOS_PACKAGE_VERSION = packageJson.version;

export function mcpLauncher(aiosPath, version = DOTAIOS_PACKAGE_VERSION) {
  return {
    command: "npx",
    args: [
      "--yes",
      "--package",
      `dotaios@${version}`,
      "dotaios-mcp",
      "--path",
      aiosPath
    ]
  };
}
