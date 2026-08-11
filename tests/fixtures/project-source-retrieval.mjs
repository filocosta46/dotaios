import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CAMPAIGN_TASK = "retrieve the campaign assets for that client.";
export const OTHER_PROJECT_CANARY = "OTHER_CLIENT_PRIVATE_CANARY";

export function createProjectSourceRetrievalFixture(options = {}) {
  const temporaryDirectory = options.temporaryDirectory || os.tmpdir();
  const prefix = options.prefix || "dotaios-project-source-";
  const root = fs.mkdtempSync(path.join(temporaryDirectory, prefix));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const sourceRoot = path.join(root, "campaign-assets");

  fs.mkdirSync(path.join(aiosPath, "projects", "acme-campaign"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "projects", "other-client", "sources"), { recursive: true });
  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "visual assets"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), '{"schema_version":"1.2.0"}\n');
  fs.writeFileSync(
    path.join(aiosPath, "projects", "acme-campaign", "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\nstatus: active\ndomain: [build]\n---\n# Acme Campaign\n\nLaunch work.\n",
  );
  fs.writeFileSync(
    path.join(aiosPath, "projects", "other-client", "README.md"),
    `---\nid: project-other-002\nproject: other-client\nstatus: active\ndomain: [build]\n---\n# Other Client\n\nCampaign assets ${OTHER_PROJECT_CANARY}.\n`,
  );
  fs.writeFileSync(
    path.join(aiosPath, "projects", "other-client", "sources", "campaign-assets.md"),
    `---\nversion: 1\nproject_id: project-other-002\nsource_id: campaign-assets\nlabel: Campaign assets ${OTHER_PROJECT_CANARY}\ntype: local-folder\npurpose: Private launch campaign assets\n---\n`,
  );

  const files = [
    ["brief.txt", "CONTENT_READ_CANARY"],
    ["café-🚀.svg", "<svg>CONTENT_READ_CANARY</svg>"],
    [path.join("visual assets", "hero image.png"), "CONTENT_READ_CANARY"],
  ];
  for (const [relativePath, content] of files) {
    fs.writeFileSync(path.join(sourceRoot, relativePath), content);
  }
  fs.chmodSync(path.join(sourceRoot, "brief.txt"), 0o000);

  return {
    root,
    aiosPath,
    homePath,
    sourceRoot,
    expectedPaths: files
      .map(([relativePath]) => relativePath.split(path.sep).join("/"))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    cleanup() {
      fs.chmodSync(path.join(sourceRoot, "brief.txt"), 0o600);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function snapshotTree(root) {
  const entries = [];
  if (!fs.existsSync(root)) return entries;
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(root, entry.name);
    const stats = fs.lstatSync(absolutePath, { bigint: true });
    const record = {
      path: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      mode: Number(stats.mode),
      size: stats.size.toString(),
      mtime_ns: stats.mtimeNs.toString(),
    };
    if (entry.isFile()) {
      try {
        record.bytes = fs.readFileSync(absolutePath).toString("base64");
      } catch (error) {
        if (error?.code !== "EACCES") throw error;
        record.bytes = "unreadable";
      }
    }
    entries.push(record);
    if (entry.isDirectory()) {
      for (const child of snapshotTree(absolutePath)) {
        entries.push({ ...child, path: path.posix.join(entry.name, child.path) });
      }
    }
  }
  return entries;
}
