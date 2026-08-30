import fs from "node:fs/promises";
import path from "node:path";
import { listFiles, writeFileSafe } from "./files.mjs";

export function isHtmlComment(val) {
  return typeof val === "string" && val.startsWith("<!--");
}

export function renderTemplate(template, data) {
  return renderEachAiTools(renderConditionals(template, data), data).replaceAll(/{{(\w+)}}/g, (_match, key) => {
    const val = data[key];
    return (val != null && !isHtmlComment(val)) ? val : "";
  });
}

function renderConditionals(template, data) {
  const open = "{{#if ";
  const separator = "{{else}}";
  const close = "{{/if}}";
  const chunks = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf(open, cursor);
    if (start === -1) break;
    const keyEnd = template.indexOf("}}", start + open.length);
    if (keyEnd === -1) break;
    const key = template.slice(start + open.length, keyEnd);
    if (!/^\w+$/.test(key)) break;
    const yesStart = keyEnd + 2;
    const separatorStart = template.indexOf(separator, yesStart);
    if (separatorStart === -1) break;
    const noStart = separatorStart + separator.length;
    const closeStart = template.indexOf(close, noStart);
    if (closeStart === -1) break;

    chunks.push(template.slice(cursor, start));
    const value = data[key];
    chunks.push(value && !isHtmlComment(value)
      ? template.slice(yesStart, separatorStart)
      : template.slice(noStart, closeStart));
    cursor = closeStart + close.length;
  }

  chunks.push(template.slice(cursor));
  return chunks.join("");
}

function renderEachAiTools(template, data) {
  const open = "{{#each ai_tools}}";
  const close = "{{/each}}";
  const tools = (data.ai_tools || []).map((tool) => `"${tool}"`).join(", ");
  const chunks = [];
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf(open, cursor);
    if (start === -1) break;
    const closeStart = template.indexOf(close, start + open.length);
    if (closeStart === -1) break;
    chunks.push(template.slice(cursor, start), tools);
    cursor = closeStart + close.length;
  }

  chunks.push(template.slice(cursor));
  return chunks.join("");
}

export function templateOutputPath(relativePath) {
  let outputRelative = relativePath.endsWith(".hbs") ? relativePath.slice(0, -4) : relativePath;
  if (outputRelative === "cursorrules") outputRelative = ".cursorrules";
  if (outputRelative === "gitignore.template") outputRelative = ".gitignore";
  return outputRelative;
}

export async function planTemplateTree(templateRoot, target, data, { include = () => true } = {}) {
  const files = await listFiles(templateRoot);
  const plan = [];

  for (const file of files) {
    const relative = path.relative(templateRoot, file);
    const outputRelative = templateOutputPath(relative);
    if (!include(outputRelative, relative)) continue;

    const source = await fs.readFile(file, "utf8");
    const content = relative.endsWith(".hbs") ? renderTemplate(source, data) : source;
    plan.push({ path: path.join(target, outputRelative), content });
  }

  return plan;
}

export async function renderTemplateTree(templateRoot, target, data, options = {}) {
  const { writeMode = "preserve", boundaryRoot = null } = options;
  const plan = await planTemplateTree(templateRoot, target, data, options);
  const results = [];
  for (const item of plan) {
    results.push(await writeFileSafe(item.path, item.content, writeMode, { boundaryRoot }));
  }
  return results;
}
