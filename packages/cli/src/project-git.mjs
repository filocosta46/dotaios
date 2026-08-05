import {
  classifyProjectRemote,
  parseProjectRemote,
  projectRemotesMatch
} from "../../core/src/project-workspaces.mjs";
import {
  defaultSpawn,
  parseUrlRewriteRules,
  rewrittenDestination,
  sanitizedGitEnvironment
} from "./sync/git.mjs";

function safeErrorText(value) {
  return String(value || "")
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

export function createProjectGitAdapter({
  spawnImpl = defaultSpawn,
  env = process.env,
  cwd = process.cwd()
} = {}) {
  const gitEnvironment = sanitizedGitEnvironment(env);

  function run(args, options = {}) {
    return spawnImpl("git", args, {
      cwd: options.cwd || cwd,
      env: gitEnvironment
    });
  }

  async function readInsteadOfRules() {
    const result = await run([
      "config",
      "--null",
      "--get-regexp",
      "^url\\..*\\.insteadof$"
    ]);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error("Could not inspect effective Git URL rewrites; refusing project clone before contacting the network.");
    }
    return parseUrlRewriteRules(result.stdout);
  }

  async function cloneRepository({ url, destination }) {
    const remote = parseProjectRemote(url);
    const effectiveUrl = rewrittenDestination(
      remote.canonicalUrl,
      "fetch",
      await readInsteadOfRules()
    );
    if (effectiveUrl === null) {
      throw new Error("Effective Git URL rewrite is ambiguous; refusing project clone before contacting the network.");
    }
    let effectiveRemote;
    try {
      effectiveRemote = parseProjectRemote(effectiveUrl);
    } catch {
      throw new Error("Effective Git URL rewrite produces an unsafe destination; refusing project clone before contacting the network.");
    }
    if (!projectRemotesMatch(remote.canonicalUrl, effectiveRemote.canonicalUrl)) {
      throw new Error("Effective Git URL rewrite changes the project host, repository, or SSH principal identity; refusing project clone before contacting the network.");
    }

    const result = await run([
      "clone",
      "--",
      remote.canonicalUrl,
      destination
    ]);
    if (result.code !== 0) {
      throw new Error(`Project clone failed: ${safeErrorText(result.stderr) || `git exited ${result.code}`}`);
    }
    return {
      destination,
      remote
    };
  }

  async function isRepository({ repositoryPath }) {
    const result = await run(
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repositoryPath }
    );
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async function readOrigin({ repositoryPath }) {
    const result = await run(
      ["remote", "get-url", "origin"],
      { cwd: repositoryPath }
    );
    if (result.code !== 0) {
      return { originUrl: null, origin: null, originError: null };
    }

    const classification = classifyProjectRemote(result.stdout.trim());
    if (!classification.safe) {
      return {
        originUrl: null,
        origin: null,
        originError: `Unsafe project origin (${classification.reason || "invalid"}).`
      };
    }
    const origin = {
      transport: classification.transport,
      canonicalUrl: classification.canonicalUrl,
      identity: classification.identity
    };
    return {
      originUrl: origin.canonicalUrl,
      origin,
      originError: null
    };
  }

  async function readRepositoryRemote(repositoryPath) {
    const origin = await readOrigin({ repositoryPath });
    if (origin.originError) {
      throw new Error(origin.originError);
    }
    if (!origin.originUrl) {
      throw new Error("Project repository has no readable origin remote.");
    }
    return origin.originUrl;
  }

  async function readRepositoryHead(repositoryPath) {
    const result = await run(
      ["rev-parse", "--verify", "HEAD"],
      { cwd: repositoryPath }
    );
    const head = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(head)) {
      throw new Error("Project repository has no verifiable HEAD commit.");
    }
    return head;
  }

  async function inspectRepository({ repositoryPath }) {
    if (!await isRepository({ repositoryPath })) {
      return {
        isRepository: false,
        originUrl: null,
        origin: null,
        originError: null
      };
    }
    return {
      isRepository: true,
      ...await readOrigin({ repositoryPath })
    };
  }

  return {
    cloneRepository,
    inspectRepository,
    isRepository,
    readOrigin,
    readRepositoryHead,
    readRepositoryRemote
  };
}
