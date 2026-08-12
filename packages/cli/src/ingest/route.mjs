import path from "node:path";

const DOC_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".epub"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);

/**
 * Pure-function classifier. No I/O.
 * Routes a raw user input to one of: web | document | text | binary.
 *
 * @param {string} input  URL or file path as the user typed it
 * @returns {{ kind: "web" | "document" | "text" | "binary", target: string, ext: string }}
 */
export function classifyInput(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Input must be a non-empty string");
  }

  if (isUrl(input)) {
    return { kind: "web", target: input, ext: "" };
  }

  const target = path.resolve(input);
  const ext = path.extname(target).toLowerCase();

  if (DOC_EXTENSIONS.has(ext)) {
    return { kind: "document", target, ext };
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text", target, ext };
  }

  return { kind: "binary", target, ext };
}

export function isUrl(input) {
  return /^https?:\/\//i.test(input);
}

export const SUPPORTED_DOC_EXTENSIONS = [...DOC_EXTENSIONS];
export const SUPPORTED_TEXT_EXTENSIONS = [...TEXT_EXTENSIONS];
