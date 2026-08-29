export function applyApprovedProjectRegistration(runCommand, baseArgs) {
  const previewResult = runCommand([...baseArgs, "--json"]);
  assertCommandPassed(previewResult, "preview");
  const preview = JSON.parse(previewResult.stdout);
  const applied = runCommand([
    ...baseArgs,
    "--json",
    "--operation-id", preview.plan.operation_id,
    "--plan-fingerprint", preview.plan.plan_fingerprint,
    "--apply"
  ]);
  assertCommandPassed(applied, "apply");
  return applied;
}

function assertCommandPassed(result, phase) {
  if (result?.status === 0 && typeof result.stdout === "string") return;
  throw new Error(
    `Project registration ${phase} failed:\n${result?.stdout || ""}\n${result?.stderr || ""}`
  );
}
