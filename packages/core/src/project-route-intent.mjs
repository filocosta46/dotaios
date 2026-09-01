const ROUTE_ACTION_VERBS = new Set([
  "add", "analyze", "approve", "archive", "assess", "audit", "bill", "build", "change",
  "check", "clean", "collect", "commit", "compare", "configure", "connect", "convert",
  "coordinate", "copy", "create", "debug", "delete", "deploy", "design", "document",
  "draft", "edit", "evaluate", "explain", "export", "fix", "generate", "import", "implement",
  "inspect", "install", "integrate", "investigate", "launch", "maintain", "measure",
  "merge", "migrate", "monitor", "move", "open", "optimize", "organize", "package",
  "patch", "plan", "prepare", "publish", "pull", "push", "read", "reconcile", "refactor",
  "release", "remove", "rename", "report", "research", "resolve", "restore", "review",
  "run", "scan", "schedule", "search", "secure", "ship", "simplify", "summarize", "sync",
  "test", "track", "translate", "troubleshoot", "update", "upgrade", "validate", "verify", "write",
  "aggiorna", "correggi", "riassumi", "summarise"
]);
const OPEN_ACTION_OBJECT_TOKENS = new Set([
  "branch", "document", "file", "issue", "pr", "pull", "readme", "request", "ticket"
]);
const REQUEST_FILLER_TOKENS = new Set(["hey", "kindly", "please"]);
const TASK_RELATION_TOKENS = new Set([
  "must", "need", "needed", "needs", "require", "required", "requires", "should"
]);
const ACTION_AUXILIARY_TOKENS = new Set(["be", "to"]);
const NEGATION_TOKENS = new Set(["never", "no", "non", "not"]);
const POST_HANDLE_ACTION_VERBS = new Set(["aggiorna", "correggi", "riassumi"]);
const ACTION_REQUEST_PREFIXES = Object.freeze([
  ["can", "you"],
  ["could", "you"],
  ["help", "me"],
  ["how", "do", "i"],
  ["i", "d", "like", "to"],
  ["i", "need", "you", "to"],
  ["i", "want", "you", "to"],
  ["let", "s"],
  ["we", "need", "to"],
  ["will", "you"],
  ["would", "you"]
]);
const NAVIGATION_OR_REFERENCE_PREFIXES = Object.freeze([
  ["access"],
  ["bring", "me", "to"],
  ["enter"],
  ["go", "to"],
  ["how", "about"],
  ["how", "is"],
  ["load"],
  ["show"],
  ["switch", "to"],
  ["take", "me", "to"],
  ["tell", "me"],
  ["what", "can", "you", "tell", "me"],
  ["what", "about"],
  ["what", "is", "in"],
  ["where", "is"],
  ["work", "in"]
]);
const MATCH_KIND_BY_FIELD = Object.freeze({
  slug: "slug_overlap",
  purpose: "purpose_overlap",
  name: "name_overlap",
  repository: "remote_name_overlap"
});

export function hasConcreteAction(intent, project, { requireHandle = true } = {}) {
  const actionTokens = routeTokens(intent);
  const stableHandleTokens = stableProjectHandleFields(project)
    .map(([, value]) => routeTokens(value));
  const handleTokenPositions = matchedHandleTokenPositions(actionTokens, stableHandleTokens);
  const action = concreteAction(intent, actionTokens, stableHandleTokens);
  if (action !== null) {
    if (!action.explicitHandlePrefix && handleTokenPositions.has(action.index)) return false;
    return actionAllowedAt(action.index, actionTokens, handleTokenPositions);
  }
  if (!requireHandle) return hasExplicitNaturalTaskClause(actionTokens);
  if (
    handleTokenPositions.size === 0
    || navigationOrReferenceOnly(actionTokens)
  ) {
    return false;
  }
  const firstHandleIndex = Math.min(...handleTokenPositions);
  const naturalActionIndex = actionTokens.findIndex((token, index) => (
    index < firstHandleIndex
    && !handleTokenPositions.has(index)
    && ROUTE_ACTION_VERBS.has(token)
  ));
  if (
    naturalActionIndex !== -1
    && actionAllowedAt(naturalActionIndex, actionTokens, handleTokenPositions)
  ) return true;
  const lastHandleIndex = Math.max(...handleTokenPositions);
  const postHandleActionIndex = actionTokens.findIndex((token, index) => (
    index > lastHandleIndex
    && !handleTokenPositions.has(index)
    && POST_HANDLE_ACTION_VERBS.has(token)
  ));
  if (
    postHandleActionIndex !== -1
    && actionAllowedAt(postHandleActionIndex, actionTokens, handleTokenPositions)
  ) return true;
  return hasDeclarativeTaskClause(actionTokens, handleTokenPositions)
    || hasConcreteDiagnosticQuestion(actionTokens, handleTokenPositions);
}

function hasExplicitNaturalTaskClause(tokens) {
  return tokens.some((token, relationIndex) => {
    if (!TASK_RELATION_TOKENS.has(token) || actionNegatedAt(relationIndex, tokens)) return false;
    const laterTokens = tokens.slice(relationIndex + 1);
    const actionOffset = laterTokens.findIndex((candidate) => (
      !ACTION_AUXILIARY_TOKENS.has(candidate)
      && (ROUTE_ACTION_VERBS.has(candidate) || actionIsParticiple(candidate))
    ));
    if (actionOffset === -1) return false;
    const actionIndex = relationIndex + actionOffset + 1;
    if (actionNegatedAt(actionIndex, tokens)) return false;
    const action = tokens[actionIndex];
    if (actionIsParticiple(action)) return true;
    const between = laterTokens.slice(0, actionOffset);
    return between.length > 0
      && between.every((candidate) => ACTION_AUXILIARY_TOKENS.has(candidate))
      && between.includes("to");
  });
}

export function matchedStableProjectHandles(intent, projects) {
  const tokens = routeTokens(intent);
  return projects.flatMap((project) => {
    const matched = stableProjectHandleFields(project).find(([, value]) => {
      const sequence = routeTokens(value);
      return matchedHandleTokenPositions(tokens, [sequence]).size > 0;
    });
    return matched ? [{ project, field: matched[0] }] : [];
  });
}

export function stableHandleMatchReason(field) {
  return {
    kind: MATCH_KIND_BY_FIELD[field],
    confidence: 1,
    fields: [field]
  };
}

export function matchReason(project, winner) {
  const reason = winner.reason || "";
  const stableFields = stableProjectHandleFields(project);
  const field = reason === "exact name match"
    ? "slug"
    : [
        ...stableFields.slice(0, 2),
        ["purpose", project.purpose],
        ...stableFields.slice(2)
      ].find(([, value]) => reason === `matched trigger "${value}"`)?.[0] || "repository";
  return {
    kind: MATCH_KIND_BY_FIELD[field],
    confidence: winner.confidence,
    fields: [field]
  };
}

export function remoteBasename(repository) {
  const trimmed = String(repository || "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/^.*:/, "");
}

function stableProjectHandleFields(project) {
  return [
    ["slug", project.slug],
    ["name", project.name],
    ["repository", remoteBasename(project.repository)]
  ].filter(([, value]) => Boolean(value));
}

function hasDeclarativeTaskClause(tokens, handleTokenPositions) {
  const firstHandleIndex = Math.min(...handleTokenPositions);
  const lastHandleIndex = Math.max(...handleTokenPositions);
  for (let index = lastHandleIndex + 1; index < tokens.length; index += 1) {
    if (!TASK_RELATION_TOKENS.has(tokens[index])) continue;
    if (actionNegatedAt(index, tokens)) continue;
    let actionIndex = index + 1;
    let sawTo = false;
    while (ACTION_AUXILIARY_TOKENS.has(tokens[actionIndex])) {
      sawTo ||= tokens[actionIndex] === "to";
      actionIndex += 1;
    }
    const action = tokens[actionIndex];
    if (
      !actionNegatedAt(actionIndex, tokens)
      && (
        actionIsParticiple(action)
        || (ROUTE_ACTION_VERBS.has(action) && (sawTo || ["must", "should"].includes(tokens[index])))
      )
    ) return true;
  }
  const relationBeforeHandle = tokens
    .slice(0, firstHandleIndex)
    .some((token, index) => (
      TASK_RELATION_TOKENS.has(token) && !actionNegatedAt(index, tokens)
    ));
  if (relationBeforeHandle) {
    const action = tokens
      .slice(lastHandleIndex + 1)
      .find((token) => !ACTION_AUXILIARY_TOKENS.has(token));
    if (actionIsParticiple(action)) return true;
  }
  if (["can", "could", "should", "will", "would"].includes(tokens[0])) {
    const action = tokens
      .slice(lastHandleIndex + 1)
      .find((token) => !ACTION_AUXILIARY_TOKENS.has(token));
    if (actionIsParticiple(action)) return true;
  }
  return false;
}

function actionIsParticiple(action) {
  if (typeof action !== "string") return false;
  let suffix;
  if (action.endsWith("ing")) suffix = "ing";
  else if (action.endsWith("ed")) suffix = "ed";
  else return false;

  const stem = action.slice(0, -suffix.length);
  const baseVerbs = [stem, `${stem}e`];
  if (stem.at(-1) === stem.at(-2)) baseVerbs.push(stem.slice(0, -1));
  return baseVerbs.some((verb) => ROUTE_ACTION_VERBS.has(verb));
}

function hasConcreteDiagnosticQuestion(tokens, handleTokenPositions) {
  const lastHandleIndex = Math.max(...handleTokenPositions);
  if (
    lastHandleIndex === tokens.length - 1
    && (
      tokensStartWith(tokens, ["what", "broke", "in"])
      || tokensStartWith(tokens, ["what", "failed", "in"])
    )
  ) return true;
  return (
    tokensStartWith(tokens, ["why", "is"])
    || tokensStartWith(tokens, ["why", "did"])
  ) && tokens.slice(lastHandleIndex + 1).some((token) => (
    token === "fail" || token === "failed" || token === "failing"
  ));
}

function actionAllowedAt(actionIndex, tokens, handleTokenPositions) {
  return !actionNegatedAt(actionIndex, tokens)
    && (tokens[actionIndex] !== "open"
    || tokens.some((token, index) => (
      index > actionIndex
      && !handleTokenPositions.has(index)
      && OPEN_ACTION_OBJECT_TOKENS.has(token)
    )));
}

function actionNegatedAt(actionIndex, tokens) {
  const preceding = tokens.slice(Math.max(0, actionIndex - 6), actionIndex);
  if (preceding.some((token) => NEGATION_TOKENS.has(token))) return true;
  return preceding.some((token, index) => (
    token === "t"
    && ["aren", "can", "couldn", "didn", "doesn", "don", "isn", "shouldn", "wasn", "weren", "won", "wouldn"]
      .includes(preceding[index - 1])
  ));
}

function navigationOrReferenceOnly(tokens) {
  const remaining = tokens.slice(actionRequestStart(tokens));
  return NAVIGATION_OR_REFERENCE_PREFIXES.some((prefix) => tokensStartWith(remaining, prefix));
}

function concreteAction(intent, tokens, handleSequences) {
  const separatorIndex = String(intent || "").indexOf(":");
  if (separatorIndex !== -1) {
    const prefixTokens = routeTokens(String(intent).slice(0, separatorIndex));
    const isHandlePrefix = handleSequences.some((sequence) => (
      sequence.length === prefixTokens.length
      && sequence.every((token, index) => prefixTokens[index] === token)
    ));
    if (isHandlePrefix) {
      const suffixStart = actionRequestStart(tokens.slice(prefixTokens.length));
      const actionIndex = prefixTokens.length + suffixStart;
      if (ROUTE_ACTION_VERBS.has(tokens[actionIndex])) {
        return { index: actionIndex, explicitHandlePrefix: true };
      }
    }
  }
  const requestStart = actionRequestStart(tokens);
  return ROUTE_ACTION_VERBS.has(tokens[requestStart])
    ? { index: requestStart, explicitHandlePrefix: false }
    : null;
}

function actionRequestStart(tokens) {
  let index = 0;
  let advanced = true;
  while (advanced) {
    advanced = false;
    while (REQUEST_FILLER_TOKENS.has(tokens[index])) {
      index += 1;
      advanced = true;
    }
    const prefix = ACTION_REQUEST_PREFIXES
      .filter((candidate) => tokensStartWith(tokens.slice(index), candidate))
      .sort((left, right) => right.length - left.length)[0];
    if (prefix) {
      index += prefix.length;
      advanced = true;
    }
  }
  return index;
}

function matchedHandleTokenPositions(tokens, sequences) {
  const positions = new Set();
  const uniqueSequences = [...new Map(
    sequences.map((sequence) => [sequence.join("\u0000"), sequence])
  ).values()].sort((left, right) => right.length - left.length);
  for (const sequence of uniqueSequences) {
    if (sequence.length === 0 || sequence.length > tokens.length) continue;
    const matchingIndexes = [];
    for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
      if (!sequence.every((token, offset) => tokens[index + offset] === token)) continue;
      matchingIndexes.push(index);
    }
    if (matchingIndexes.length === 0) continue;
    const overlappingIndex = matchingIndexes.find((index) => (
      sequence.every((_, offset) => positions.has(index + offset))
    ));
    const selectedIndex = overlappingIndex ?? matchingIndexes.at(-1);
    for (let offset = 0; offset < sequence.length; offset += 1) {
      positions.add(selectedIndex + offset);
    }
  }
  return positions;
}

function tokensStartWith(tokens, prefix) {
  return prefix.every((token, index) => tokens[index] === token);
}

function routeTokens(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}
