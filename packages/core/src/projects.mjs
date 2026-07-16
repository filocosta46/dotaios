import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import { isPathWithin } from "./paths.mjs";

const execFileAsync = promisify(execFile);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PROJECT_PLAN_VERSION = 1;
const PROJECT_STATE_VERSION = 1;
const PROJECT_DOMAINS = new Set(["build", "make", "sell"]);

/**
 * Preview registration of an external project repository without moving or
 * copying it. Synced metadata and machine-local path state are written only
 * when apply or yes is explicitly true.
 */
export async function registerProject(options = {}) {
  const plan = await planProjectRegistration(options);
  if (options.apply !== true && options.yes !== true) return plan;
  return applyProjectRegistration(plan, { fs: options.fs });
}

/** Build a read-only project registration plan and durable README diff. */
export async function planProjectRegistration(options = {}) {
  if (!options.projectPath) {
    throw new Error("projectPath is required");
  }

  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);

  const requestedProjectPath = resolveUserPath(options.projectPath, context.homePath);
  await assertDirectory(context.fs, requestedProjectPath, "Project path");
  const realProjectPath = await context.fs.realpath(requestedProjectPath);
  if (await isPathWithin(context.aiosPath, requestedProjectPath, { fileSystem: context.fs })) {
    throw new Error([
      `Cannot register ${requestedProjectPath} because it is inside the AIOS folder.`,
      "Keep the actual project repository outside AIOS so it retains its own Git history."
    ].join(" "));
  }

  const [records, state] = await Promise.all([
    readProjectRecords(context),
    readProjectState(context)
  ]);
  assertUniqueProjectIds(records);

  const mappedId = await findIdForPath(context, state.paths, realProjectPath);
  const mappedRecord = mappedId ? records.find((record) => record.id === mappedId) : null;
  const requestedSlug = options.slug ? validateSlug(options.slug) : null;
  if (mappedRecord && requestedSlug && requestedSlug !== mappedRecord.directorySlug) {
    throw new Error([
      `This path is already registered as "${mappedRecord.directorySlug}".`,
      `Use --slug ${mappedRecord.directorySlug}, or omit --slug.`
    ].join(" "));
  }

  const slug = requestedSlug
    || mappedRecord?.directorySlug
    || slugify(path.basename(requestedProjectPath));
  const existing = records.find((record) => record.directorySlug === slug) || null;
  if (mappedId && existing?.id && mappedId !== existing.id) {
    throw new Error([
      `Project "${slug}" has id ${existing.id}, but this machine maps the path to ${mappedId}.`,
      `Fix the conflicting local state at ${context.statePath} before retrying.`
    ].join(" "));
  }

  const id = mappedId || existing?.id || context.createId();
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Project id generation returned an empty value");
  }
  const duplicate = records.find((record) => record.id === id && record.directorySlug !== slug);
  if (duplicate) {
    throw new Error(`Project id ${id} is already used by "${duplicate.directorySlug}".`);
  }

  const name = readRequiredString(options.name ?? existing?.metadata.name ?? path.basename(requestedProjectPath), "name");
  const status = readRequiredString(options.status ?? existing?.metadata.status ?? "active", "status");
  const domain = normalizeDomains(options.domain ?? existing?.metadata.domain ?? ["build"]);
  const discoveredRepoUrl = await context.readRepoUrl(requestedProjectPath);
  const repoUrl = readOptionalString(options.repoUrl)
    ?? readOptionalString(discoveredRepoUrl)
    ?? readOptionalString(existing?.metadata.repo_url)
    ?? readOptionalString(existing?.metadata.repo)
    ?? null;

  const readmePath = path.join(context.aiosPath, "projects", slug, "README.md");
  await assertProjectReadmePath(context, readmePath);
  const source = existing
    ? existing.source
    : await readMarkdownSource(context.fs, readmePath);
  const content = renderProjectReadme(source, {
    id: id.trim(),
    project: slug,
    name,
    status,
    domain,
    repo_url: repoUrl
  });

  const nextPaths = { ...state.paths };
  for (const [otherId, localPath] of Object.entries(nextPaths)) {
    if (otherId !== id && await pathsReferToSameDirectory(context, localPath, realProjectPath)) {
      delete nextPaths[otherId];
    }
  }
  nextPaths[id] = requestedProjectPath;
  const nextState = { ...state, paths: nextPaths };
  const relativeReadmePath = path.relative(context.aiosPath, readmePath);
  const operation = source ? "replace" : "add";
  const receipt = {
    version: 1,
    type: "project-registration",
    operation,
    project_id: id.trim(),
    project: slug,
    durable: {
      path: relativeReadmePath,
      before_hash: source ? contentHash(source.content) : null,
      after_hash: contentHash(content)
    },
    machine_local: {
      state_path: context.statePath,
      project_path: requestedProjectPath
    },
    applied: false
  };

  return {
    version: PROJECT_PLAN_VERSION,
    applied: false,
    id: id.trim(),
    slug,
    project: slug,
    name,
    status,
    domain,
    repoUrl,
    projectPath: requestedProjectPath,
    pathAvailable: true,
    readmePath,
    readme: content,
    aiosPath: context.aiosPath,
    homePath: context.homePath,
    statePath: context.statePath,
    readmeBefore: source?.content || "",
    readmeExists: source !== null,
    stateBefore: state,
    stateAfter: nextState,
    operation,
    preview: renderProjectDiff(relativeReadmePath, source?.content || "", content, source !== null),
    receipt
  };
}

/** Apply a previously previewed registration plan. */
export async function applyProjectRegistration(plan, options = {}) {
  assertProjectPlan(plan);
  const context = createContext({
    aiosPath: plan.aiosPath,
    homePath: plan.homePath,
    statePath: plan.statePath,
    fs: options.fs
  });
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  await assertProjectReadmePath(context, plan.readmePath);

  const currentSource = await readMarkdownSource(context.fs, plan.readmePath);
  const currentReadmeExists = currentSource !== null;
  const currentReadme = currentSource?.content || "";
  if (currentReadmeExists !== plan.readmeExists || currentReadme !== plan.readmeBefore) {
    throw new Error("The project README changed after the preview. Preview project add again.");
  }
  const currentState = await readProjectState(context);
  if (JSON.stringify(currentState) !== JSON.stringify(plan.stateBefore)) {
    throw new Error("The machine-local project path state changed after the preview. Preview project add again.");
  }

  await writeProjectState(context, plan.stateAfter);
  await context.fs.mkdir(path.dirname(plan.readmePath), { recursive: true });
  await context.fs.writeFile(plan.readmePath, plan.readme, "utf8");

  return {
    ...plan,
    applied: true,
    receipt: { ...plan.receipt, applied: true }
  };
}

/** List synced project metadata enriched with this machine's local path. */
export async function listProjects(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  return listProjectRecords(context);
}

/** Resolve a project id or slug to an existing path on this machine. */
export async function resolveProject(referenceOrOptions, additionalOptions = {}) {
  const options = typeof referenceOrOptions === "string"
    ? { ...additionalOptions, project: referenceOrOptions }
    : { ...(referenceOrOptions || {}) };
  const reference = readOptionalString(options.project ?? options.slug ?? options.id);
  if (!reference) {
    throw new Error("project id or slug is required");
  }

  const projects = await listProjects(options);
  const matches = projects.filter((project) => project.id === reference || project.slug === reference);
  if (matches.length === 0) {
    throw new Error(`Project "${reference}" is not registered. Run \`dotaios project list\` to see available projects.`);
  }
  if (matches.length > 1) {
    throw new Error(`Project reference "${reference}" is ambiguous. Resolve it by its stable id.`);
  }

  const [project] = matches;
  if (!project.projectPath) {
    throw new Error([
      `Project "${project.slug}" has no path on this machine.`,
      `Run \`dotaios project add <repo-path> --slug ${project.slug}\` to register it.`
    ].join(" "));
  }
  if (!project.pathAvailable) {
    throw new Error([
      `Project "${project.slug}" is registered at ${project.projectPath}, but that path is missing.`,
      `Run \`dotaios project add <repo-path> --slug ${project.slug}\` to update it.`
    ].join(" "));
  }
  return project.projectPath;
}

/** Check local paths and Git remotes without changing metadata or local state. */
export async function doctorProjects(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  const projects = await listProjectRecords(context);
  const issues = [];

  for (const project of projects) {
    if (!project.projectPath) {
      issues.push({
        type: "missing_path",
        reason: "unmapped",
        project,
        message: `Project "${project.slug}" has no path registered on this machine.`
      });
      continue;
    }
    if (!project.pathAvailable) {
      issues.push({
        type: "missing_path",
        reason: "not_found",
        project,
        actual: project.projectPath,
        message: `Project "${project.slug}" path is missing: ${project.projectPath}`
      });
      continue;
    }
    if (!project.repoUrl) continue;

    const actualRepoUrl = readOptionalString(await context.readRepoUrl(project.projectPath));
    if (!repoUrlsMatch(project.repoUrl, actualRepoUrl)) {
      issues.push({
        type: "remote_mismatch",
        project,
        expected: project.repoUrl,
        actual: actualRepoUrl,
        message: actualRepoUrl
          ? `Project "${project.slug}" remote is ${actualRepoUrl}; metadata expects ${project.repoUrl}.`
          : `Project "${project.slug}" has no Git origin; metadata expects ${project.repoUrl}.`
      });
    }
  }

  return {
    ok: issues.length === 0,
    checked: projects.length,
    projects,
    issues
  };
}

function createContext(options) {
  const homePath = path.resolve(options.homePath || os.homedir());
  const aiosPath = resolveUserPath(options.aiosPath || path.join(homePath, "aios"), homePath);
  const statePath = resolveUserPath(
    options.statePath || path.join(homePath, ".dotaios", "projects.json"),
    homePath
  );
  return {
    aiosPath,
    createId: options.createId || randomUUID,
    fs: options.fs || fs,
    homePath,
    readRepoUrl: options.readRepoUrl || readGitRemoteUrl,
    statePath
  };
}

async function listProjectRecords(context) {
  const [records, state] = await Promise.all([
    readProjectRecords(context),
    readProjectState(context)
  ]);
  return Promise.all(records.map(async (record) => {
    const projectPath = record.id ? readMappedPath(state.paths[record.id]) : null;
    return {
      id: record.id,
      slug: record.slug,
      project: record.project,
      name: record.name,
      status: record.status,
      domain: record.domain,
      repoUrl: record.repoUrl,
      projectPath,
      pathAvailable: projectPath ? await isDirectory(context.fs, projectPath) : false,
      readmePath: record.readmePath,
      readme: record.source.content
    };
  }));
}

async function readProjectRecords(context) {
  const projectsPath = path.join(context.aiosPath, "projects");
  if (!await isPathWithin(context.aiosPath, projectsPath, { fileSystem: context.fs })) {
    throw new Error(`Project shelf resolves outside the AIOS folder: ${projectsPath}`);
  }
  let entries;
  try {
    entries = await context.fs.readdir(projectsPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const readmePath = path.join(projectsPath, entry.name, "README.md");
    const source = await readMarkdownSource(context.fs, readmePath);
    if (source === null) continue;
    records.push(projectRecord(entry.name, readmePath, source));
  }
  return records;
}

function projectRecord(directorySlug, readmePath, source) {
  const metadata = source.metadata;
  const id = readProjectId(metadata, readmePath);
  const project = readOptionalString(metadata.project)
    || readOptionalString(metadata.slug)
    || directorySlug;
  const bodyName = firstHeading(source.body);
  return {
    directorySlug,
    id,
    metadata,
    name: readOptionalString(metadata.name) || bodyName || project,
    project,
    status: readOptionalString(metadata.status) || "unknown",
    domain: normalizeStoredDomains(metadata.domain),
    repoUrl: readOptionalString(metadata.repo_url) || readOptionalString(metadata.repo) || null,
    readmePath,
    slug: directorySlug,
    source
  };
}

function readProjectId(metadata, source) {
  const id = readOptionalString(metadata.id);
  const legacyId = readOptionalString(metadata.project_id);
  if (id && legacyId && id !== legacyId) {
    throw new Error(`Conflicting id and project_id in ${source}`);
  }
  return id || legacyId || null;
}

async function readMarkdownSource(fileSystem, readmePath) {
  let content;
  try {
    content = await fileSystem.readFile(readmePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { body: content, content, document: parseDocument("{}\n"), metadata: {} };
  }
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML frontmatter in ${readmePath}: ${document.errors[0].message}`);
  }
  const metadata = document.toJS();
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Invalid YAML frontmatter in ${readmePath}: expected a mapping`);
  }
  return {
    body: content.slice(match[0].length),
    content,
    document,
    metadata
  };
}

function renderProjectReadme(source, metadata) {
  const document = source?.document || parseDocument("{}\n");
  for (const [key, value] of Object.entries(metadata)) {
    document.set(key, value);
  }
  const frontmatter = String(document).trimEnd();
  const body = source?.body || `# ${metadata.name}\n`;
  return `---\n${frontmatter}\n---\n${body}`;
}

async function readProjectState(context) {
  let content;
  try {
    content = await context.fs.readFile(context.statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: PROJECT_STATE_VERSION, paths: {} };
    throw error;
  }

  let state;
  try {
    state = JSON.parse(content);
  } catch {
    throw new Error(`Project path state is not valid JSON: ${context.statePath}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`Project path state must be an object: ${context.statePath}`);
  }
  if (state.paths !== undefined && (!state.paths || typeof state.paths !== "object" || Array.isArray(state.paths))) {
    throw new Error(`Project path state has an invalid paths map: ${context.statePath}`);
  }
  return { ...state, paths: { ...(state.paths || {}) } };
}

async function writeProjectState(context, state) {
  const paths = Object.fromEntries(
    Object.entries(state.paths).sort(([left], [right]) => left.localeCompare(right))
  );
  await context.fs.mkdir(path.dirname(context.statePath), { recursive: true });
  await context.fs.writeFile(
    context.statePath,
    `${JSON.stringify({ ...state, version: PROJECT_STATE_VERSION, paths }, null, 2)}\n`,
    "utf8"
  );
}

async function findIdForPath(context, paths, projectPath) {
  for (const [id, localPath] of Object.entries(paths)) {
    if (await pathsReferToSameDirectory(context, localPath, projectPath)) return id;
  }
  return null;
}

async function pathsReferToSameDirectory(context, storedPath, projectPath) {
  const localPath = readMappedPath(storedPath);
  if (!localPath) return false;
  const resolved = resolveUserPath(localPath, context.homePath);
  if (resolved === projectPath) return true;
  try {
    return await context.fs.realpath(resolved) === projectPath;
  } catch {
    return false;
  }
}

function readMappedPath(value) {
  if (typeof value === "string" && value.trim()) return path.resolve(value);
  if (value && typeof value.path === "string" && value.path.trim()) return path.resolve(value.path);
  return null;
}

async function assertStateOutsideAios(context) {
  const containmentOptions = { fileSystem: context.fs };
  if (!await isPathWithin(path.parse(context.statePath).root, context.statePath, containmentOptions)) {
    throw new Error(`Project path state cannot safely resolve through a dangling symlink: ${context.statePath}`);
  }
  if (
    isLexicallyWithin(context.aiosPath, context.statePath) ||
    await isPathWithin(context.aiosPath, context.statePath, containmentOptions)
  ) {
    throw new Error([
      `Project path state must live outside the synced AIOS folder: ${context.statePath}.`,
      "Pass a statePath under the user's local state directory instead."
    ].join(" "));
  }
}

async function assertProjectReadmePath(context, readmePath) {
  const projectsPath = path.join(context.aiosPath, "projects");
  const options = { fileSystem: context.fs };
  if (
    !await isPathWithin(context.aiosPath, projectsPath, options) ||
    !await isPathWithin(projectsPath, readmePath, options)
  ) {
    throw new Error(`Project README path resolves outside the AIOS project shelf: ${readmePath}`);
  }
}

function assertUniqueProjectIds(records) {
  const seen = new Map();
  for (const record of records) {
    if (!record.id) continue;
    const previous = seen.get(record.id);
    if (previous) {
      throw new Error(`Project id ${record.id} is used by both "${previous}" and "${record.directorySlug}".`);
    }
    seen.set(record.id, record.directorySlug);
  }
}

function normalizeDomains(value) {
  const domains = normalizeStoredDomains(value);
  if (domains.length === 0) {
    throw new Error("domain requires at least one value");
  }
  for (const domain of domains) {
    if (!PROJECT_DOMAINS.has(domain)) {
      throw new Error(`Unknown project domain "${domain}". Use build, make, or sell.`);
    }
  }
  return [...new Set(domains)];
}

function normalizeStoredDomains(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function validateSlug(value) {
  const slug = readRequiredString(value, "slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("slug must use lowercase letters, numbers, and single hyphens");
  }
  return slug;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(`Could not create a project slug from "${value}". Pass --slug explicitly.`);
  }
  return slug;
}

function readRequiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstHeading(body) {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

function resolveUserPath(value, homePath) {
  if (value === "~") return homePath;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homePath, value.slice(2));
  }
  return path.resolve(value);
}

function isLexicallyWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function renderProjectDiff(relativePath, before, after, existed) {
  const lines = [
    `--- ${existed ? relativePath : "/dev/null"}`,
    `+++ ${relativePath}`,
    `@@ ${existed ? "replace" : "add"} README @@`
  ];
  if (existed) {
    lines.push(...before.replace(/\n$/, "").split("\n").map((line) => `-${line}`));
  }
  lines.push(...after.replace(/\n$/, "").split("\n").map((line) => `+${line}`));
  return lines.join("\n");
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertProjectPlan(plan) {
  if (!plan || plan.version !== PROJECT_PLAN_VERSION || !plan.aiosPath || !plan.readmePath) {
    throw new Error("Invalid project registration plan. Preview project add again.");
  }
}

async function assertDirectory(fileSystem, target, label) {
  let stats;
  try {
    stats = await fileSystem.stat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${target}`);
    throw error;
  }
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${target}`);
}

async function isDirectory(fileSystem, target) {
  try {
    return (await fileSystem.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readGitRemoteUrl(projectPath) {
  const originUrl = await gitOutput(projectPath, ["config", "--get", "remote.origin.url"]);
  if (originUrl) return originUrl;

  const remotes = await gitOutput(projectPath, ["remote"]);
  const firstRemote = remotes?.split(/\r?\n/).map((remote) => remote.trim()).find(Boolean);
  if (!firstRemote) return null;
  return gitOutput(projectPath, ["config", "--get", `remote.${firstRemote}.url`]);
}

async function gitOutput(projectPath, args) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, ...args],
      { encoding: "utf8" }
    );
    return readOptionalString(stdout);
  } catch {
    return null;
  }
}

function repoUrlsMatch(expected, actual) {
  if (!expected || !actual) return expected === actual;
  return normalizeRepoUrl(expected) === normalizeRepoUrl(actual);
}

function normalizeRepoUrl(value) {
  const trimmed = value.trim().replace(/^git\+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const scpMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes("://")) {
    return `${scpMatch[1].toLowerCase()}/${scpMatch[2].replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(trimmed);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+/, "")}`;
  } catch {
    return trimmed;
  }
}
