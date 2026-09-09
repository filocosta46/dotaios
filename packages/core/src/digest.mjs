import { buildWorkingContext } from "./working-context.mjs";
import { collectSourceReferences } from "./source-reference.mjs";

export async function buildSessionDigest(aiosPath, options = {}, dependencies = {}) {
  const { context, rendered } = await buildWorkingContext(aiosPath, options, dependencies);
  const sessionIds = context.sessions.map((session) => session.session_id).filter(Boolean);
  const sourceReferences = collectSourceReferences(context);
  return {
    digest: rendered,
    sessionIds,
    budget: context.budget,
    generatedAt: context.generatedAt,
    projectFilter: context.projectFilter,
    memoryMode: context.memoryMode,
    memoryReceipt: context.memoryReceipt,
    ...(context.coverage ? { coverage: context.coverage } : {}),
    // Follow references travel in the envelope, not in the visible projection.
    ...(sourceReferences.length > 0 ? { sources: sourceReferences } : {}),
  };
}
