const UNSAFE_TERMINAL_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Bidi_Control}/u;
const UNSAFE_TERMINAL_TEXT_GLOBAL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Bidi_Control}/gu;

export function assertSafeTerminalText(value, label = "text") {
  if (typeof value !== "string") {
    throw new Error(`${label} must be text.`);
  }
  const unsafe = value.match(UNSAFE_TERMINAL_TEXT)?.[0];
  if (unsafe) {
    throw new Error(`${label} contains unsafe terminal character U+${formatCodePoint(unsafe)}.`);
  }
  return value;
}

export function visibleTerminalText(value) {
  return String(value).replace(UNSAFE_TERMINAL_TEXT_GLOBAL, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  });
}

export function renderGuidanceCommand(
  command,
  { targetPath, defaultPath, platform = process.platform } = {}
) {
  assertSafeTerminalText(command, "Guidance command");
  assertSafeTerminalText(targetPath, "AIOS path");
  assertSafeTerminalText(defaultPath, "Default AIOS path");
  const pathOption = targetPath === defaultPath
    ? ""
    : ` --path ${platform === "win32" ? powerShellQuote(targetPath) : posixShellQuote(targetPath)}`;
  return `${command}${pathOption}`;
}

export function guidanceShellLabel(platform = process.platform) {
  return platform === "win32" ? "PowerShell" : "POSIX shell";
}

function posixShellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatCodePoint(character) {
  return character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
}
