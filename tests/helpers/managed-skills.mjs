import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPAQUE_ASSET_BYTES = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
export const OPAQUE_ASSET_SHA256 = "cc7b06150158f0093f246c1d738661a1c08c845fb508e0464d665e0878426b72";

export function createManagedSkillFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-managed-skills-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const sourcesPath = path.join(root, "sources");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(sourcesPath, { recursive: true });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { root, aiosPath, homePath, sourcesPath };
}

export function writeSkill(directory, {
  name = path.basename(directory),
  description = `Reviewed ${name} skill.`,
  body = `# ${name}\n`,
  files = {},
  executable = []
} = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(directory, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  for (const relativePath of executable) {
    fs.chmodSync(path.join(directory, ...relativePath.split("/")), 0o755);
  }
  return directory;
}

export function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  return snapshotEntry(root, ".");
}

function snapshotEntry(absolutePath, relativePath) {
  const stat = fs.lstatSync(absolutePath, { bigint: true });
  const common = {
    path: relativePath,
    mode: Number(stat.mode & 0o7777n),
    nlink: Number(stat.nlink),
    type: entryType(stat)
  };
  if (stat.isSymbolicLink()) {
    return [{ ...common, target: fs.readlinkSync(absolutePath) }];
  }
  if (stat.isFile()) {
    return [{ ...common, bytes: fs.readFileSync(absolutePath).toString("base64") }];
  }
  if (!stat.isDirectory()) return [common];

  const rows = [common];
  const names = fs.readdirSync(absolutePath).sort(compareUtf8Bytes);
  for (const name of names) {
    const childPath = relativePath === "." ? name : `${relativePath}/${name}`;
    rows.push(...snapshotEntry(path.join(absolutePath, name), childPath));
  }
  return rows;
}

function entryType(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isBlockDevice()) return "block-device";
  return "special";
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
