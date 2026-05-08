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
