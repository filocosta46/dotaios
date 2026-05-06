export const schemaVersion = "1.0.0";

export function createAiosConfig({ aiTools = [], vaultPath = null } = {}) {
  return {
    schema_version: schemaVersion,
    created_at: new Date().toISOString(),
    ai_tools: aiTools,
    vault_path: vaultPath
  };
}
