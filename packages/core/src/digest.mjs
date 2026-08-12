import { buildWorkingContext } from "./working-context.mjs";

export async function buildSessionDigest(aiosPath, options = {}, dependencies = {}) {
  const { context, rendered } = await buildWorkingContext(aiosPath, options, dependencies);
  const sessionIds = context.sessions.map((session) => session.session_id).filter(Boolean);
  return {
    digest: rendered,
    sessionIds,
    budget: context.budget,
    generatedAt: context.generatedAt,
    projectFilter: context.projectFilter,
  };
}
