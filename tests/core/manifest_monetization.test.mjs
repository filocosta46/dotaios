import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaidManifest, manifestProductId, validateManifest } from "../../packages/core/src/manifest.mjs";

const baseManifest = {
  name: "career-pack",
  version: "1.0.0",
  description: "Career search workflows",
  license: "Proprietary",
  aios_version: ">=1.9.0",
  requires: { connections: [], context: [] },
  provides: { skills: ["career-search"], memory_writers: [], scheduled_tasks: [] },
  permissions: { read: [], write: [], write_with_approval: [], connections: [] }
};

test("free manifest validates and is not paid", () => {
  const result = validateManifest({ ...baseManifest });
  assert.equal(result.valid, true);
  assert.equal(isPaidManifest({ ...baseManifest }), false);
  assert.equal(manifestProductId({ ...baseManifest }), null);
});

test("paid manifest requires vendor and product_id", () => {
  const result = validateManifest({ ...baseManifest, paid: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((err) => err.includes("vendor")));
  assert.ok(result.errors.some((err) => err.includes("product_id")));
});

test("paid manifest with vendor and product_id is valid", () => {
  const manifest = { ...baseManifest, paid: true, vendor: "filocosta", product_id: "career-pack" };
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, `errors: ${result.errors.join("; ")}`);
  assert.equal(isPaidManifest(manifest), true);
  assert.equal(manifestProductId(manifest), "career-pack");
});

test("invalid vendor names are rejected", () => {
  const manifest = { ...baseManifest, paid: true, vendor: "Bad Vendor!", product_id: "career-pack" };
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((err) => err.includes("vendor")));
});

test("paid as non-boolean is rejected", () => {
  const result = validateManifest({ ...baseManifest, paid: "yes" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((err) => err.includes("paid must be a boolean")));
});
