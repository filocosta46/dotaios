import test from "node:test";
import assert from "node:assert/strict";
import { bridgePath, loadAgentRegistry } from "../../packages/core/src/bridges.mjs";

test("registry preserves non-bridge runtimes such as Hermes", async () => {
  const registry = await loadAgentRegistry();
  const hermes = registry.find((agent) => agent.name === "Hermes");

  assert.ok(hermes);
  assert.equal(hermes.bridge, null);
  assert.equal(hermes.detect, ".hermes");
  assert.equal(bridgePath("/tmp/home", hermes), null);
});
