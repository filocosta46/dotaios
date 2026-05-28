import test from "node:test";
import assert from "node:assert/strict";
import { resolveMemoryBackend } from "../../packages/core/src/memory-backend.mjs";

test("returns adapter when healthy", async () => {
  const backend = await resolveMemoryBackend({
    adapter: { health: async () => ({ ok: true }) },
    fallback: { health: async () => ({ ok: true }) }
  });
  assert.equal(backend.kind, "adapter");
});

test("falls back when adapter unhealthy", async () => {
  const backend = await resolveMemoryBackend({
    adapter: { health: async () => ({ ok: false, reason: "down" }) },
    fallback: { health: async () => ({ ok: true }) }
  });
  assert.equal(backend.kind, "fallback");
});

test("returns none when adapter and fallback are unhealthy", async () => {
  const backend = await resolveMemoryBackend({
    adapter: { health: async () => ({ ok: false, reason: "down" }) },
    fallback: { health: async () => ({ ok: false, reason: "down" }) }
  });
  assert.equal(backend.kind, "none");
});
