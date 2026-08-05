import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../../packages/core/src/manifest.mjs";

const baseManifest = {
  name: "example-plugin",
  version: "1.0.0",
  description: "Example",
  license: "MIT",
  aios_version: ">=1.28.0",
  requires: { connections: [], context: [] },
  provides: { skills: [], memory_writers: [], scheduled_tasks: [] },
  permissions: { read: [], write: [], write_with_approval: [], connections: [] }
};

test("free-core validation rejects unknown top-level manifest fields", () => {
  for (const field of ["paid", "vendor", "product_id"]) {
    const result = validateManifest({ ...baseManifest, [field]: field === "paid" ? true : "legacy" });
    assert.equal(result.valid, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`Unsupported top-level key\\(s\\): ${field}`), field);
  }

  const result = validateManifest({ ...baseManifest, future_field: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Unsupported top-level key\(s\): future_field/);
});
