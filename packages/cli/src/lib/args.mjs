export function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function hasHelpFlag(args) {
  return args.includes("--help") || args.includes("-h");
}

// Shared parser for the common `--path` / `--home` option pair.
// Throws on any unrecognized flag so command typos surface immediately.
export function parsePathHomeOptions(args = []) {
  const options = { home: null, path: null };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}
