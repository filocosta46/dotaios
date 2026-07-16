import test from "node:test";
import assert from "node:assert/strict";
import { bridgeContent, bridgePath, loadAgentRegistry } from "../../packages/core/src/bridges.mjs";

test("registry preserves non-bridge runtimes such as Hermes", async () => {
  const registry = await loadAgentRegistry();
  const hermes = registry.find((agent) => agent.name === "Hermes");

  assert.ok(hermes);
  assert.equal(hermes.bridge, null);
  assert.equal(hermes.detect, ".hermes");
  assert.equal(bridgePath("/tmp/home", hermes), null);
});

test("managed bridges route working memory through the canonical projection", async () => {
  const content = await bridgeContent(
    { name: "Test Agent", include: "" },
    "/tmp/example-aios"
  );

  assert.match(content, /events, signals, and saved sessions only through the canonical bounded projection/);
  assert.match(content, /dotaios brief --compact/);
  assert.match(content, /`read_working_context`, `search_aios`, and `resolve_skill`/);
  const retiredToolNames = [
    ["read", "session", "digest"], ["read", "context"], ["list", "skills"],
    ["search", "memory"], ["search", "vault"], ["list", "projects"],
    ["log", "event"], ["google", "status"], ["google", "gmail", "search"],
    ["google", "calendar", "agenda"], ["google", "drive", "search"]
  ].map((parts) => parts.join("_"));
  assert.equal(retiredToolNames.some((name) => content.includes(name)), false);
});
