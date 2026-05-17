import fs from "node:fs/promises";
import path from "node:path";
import { listFiles, writeFileSafe } from "./files.mjs";

export function isHtmlComment(val) {
  return typeof val === "string" && val.startsWith("<!--");
}

export function renderTemplate(template, data) {
  return template.replaceAll(/{{#if (\w+)}}([\s\S]*?){{else}}([\s\S]*?){{\/if}}/g, (_match, key, yes, no) => {
    const val = data[key];
    return (val && !isHtmlComment(val)) ? yes : no;
  }).replaceAll(/{{#each ai_tools}}([\s\S]*?){{\/each}}/g, () => (
    (data.ai_tools || []).map((tool) => `"${tool}"`).join(", ")
  )).replaceAll(/{{(\w+)}}/g, (_match, key) => {
    const val = data[key];
    return (val != null && !isHtmlComment(val)) ? val : "";
  });
}

export function templateOutputPath(relativePath) {
  let outputRelative = relativePath.endsWith(".hbs") ? relativePath.slice(0, -4) : relativePath;
  if (outputRelative === "cursorrules") outputRelative = ".cursorrules";
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
  const { writeMode = "preserve" } = options;
  const plan = await planTemplateTree(templateRoot, target, data, options);
  const results = [];
  for (const item of plan) {
    results.push(await writeFileSafe(item.path, item.content, writeMode));
  }
  return results;
}
