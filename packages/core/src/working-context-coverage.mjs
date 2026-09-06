// Separate from the existing operational allowance: no source text or variable
// identifiers enter this envelope. The selected source is scoped by projectFilter.
export const WORKING_CONTEXT_COVERAGE_OVERHEAD_LIMIT = 512;

export function projectReadmeCoverage({ excerptClipped, budgetOmitted }) {
  const reasons = [];
  if (excerptClipped) reasons.push("excerpt clipped");
  if (budgetOmitted) reasons.push("text omitted by output budget");
  const notice = reasons.length > 0
    ? `> [DotAIOS] Selected project README context is incomplete: ${reasons.join("; ")}. Missing text may contain constraints. Do not infer it.`
    : null;
  return {
    version: 1,
    selectedProjectReadme: { excerptClipped, budgetOmitted },
    notice,
  };
}

export function assertWorkingContextCoverageBound(coverage) {
  // Count the longest consumer key, pretty JSON overhead, and the repeated
  // notice plus separator in hook text against one separate fixed allowance.
  const overhead = coverage
    ? JSON.stringify({ contextCoverage: coverage }, null, 2).length + (coverage.notice?.length || 0) + 2
    : 0;
  if (overhead > WORKING_CONTEXT_COVERAGE_OVERHEAD_LIMIT) {
    throw new Error("Working-context coverage exceeded its fixed bound.");
  }
}
