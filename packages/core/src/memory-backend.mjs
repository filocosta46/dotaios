import { MEMORY_BACKEND_KIND } from "./adapter-contract.mjs";

export async function resolveMemoryBackend({ adapter, fallback }) {
  const adapterHealth = await adapter.health();
  if (adapterHealth?.ok) {
    return {
      kind: MEMORY_BACKEND_KIND.ADAPTER,
      backend: adapter,
      health: adapterHealth
    };
  }

  const fallbackHealth = await fallback.health();
  if (fallbackHealth?.ok) {
    return {
      kind: MEMORY_BACKEND_KIND.FALLBACK,
      backend: fallback,
      health: fallbackHealth,
      degraded: true
    };
  }

  return {
    kind: MEMORY_BACKEND_KIND.NONE,
    backend: null,
    health: { ok: false, reason: "no-backend" },
    degraded: true
  };
}
