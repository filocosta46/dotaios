import test from "node:test";
import assert from "node:assert/strict";
import {
  admitBundledGraph,
  admitDependencyGraph,
} from "../../scripts/onboarding-release-acceptance.mjs";

function validFixture() {
  const packageJson = {
    name: "dotaios",
    version: "2.0.11",
    dependencies: {
      alpha: "1.2.3",
    },
  };
  const shrinkwrap = {
    name: "dotaios",
    version: "2.0.11",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "dotaios",
        version: "2.0.11",
        dependencies: {
          alpha: "1.2.3",
        },
      },
      "node_modules/alpha": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
        integrity: "sha512-YWxwaGEtMS4yLjM=",
      },
    },
  };
  return { packageJson, shrinkwrap };
}

test("dependency admission produces one order-independent digest over exact registry packages", () => {
  const fixture = validFixture();
  const admitted = admitDependencyGraph(fixture);
  const reordered = structuredClone(fixture);
  reordered.shrinkwrap.packages = {
    "node_modules/alpha": reordered.shrinkwrap.packages["node_modules/alpha"],
    "": reordered.shrinkwrap.packages[""],
  };

  assert.match(admitted.sha256, /^[a-f0-9]{64}$/);
  assert.equal(admitted.sha256, admitDependencyGraph(reordered).sha256);
  assert.deepEqual(admitted.packages, [{
    path: "node_modules/alpha",
    version: "1.2.3",
    resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
    integrity: "sha512-YWxwaGEtMS4yLjM=",
    dependencies: {},
    optionalDependencies: {},
  }]);

  const changed = structuredClone(fixture);
  changed.shrinkwrap.packages["node_modules/alpha"].version = "1.2.4";
  assert.notEqual(admitted.sha256, admitDependencyGraph(changed).sha256);
});

test("dependency admission rejects mutable or executable package graphs", () => {
  const cases = [
    ["mutable direct dependency", (fixture) => {
      fixture.packageJson.dependencies.alpha = "^1.2.3";
      fixture.shrinkwrap.packages[""].dependencies.alpha = "^1.2.3";
    }],
    ["local source", (fixture) => {
      fixture.shrinkwrap.packages["node_modules/alpha"].resolved = "file:../alpha";
    }],
    ["missing integrity", (fixture) => {
      delete fixture.shrinkwrap.packages["node_modules/alpha"].integrity;
    }],
    ["linked package", (fixture) => {
      fixture.shrinkwrap.packages["node_modules/alpha"].link = true;
    }],
    ["install lifecycle", (fixture) => {
      fixture.packageJson.scripts = { postinstall: "node install.mjs" };
    }],
    ["transitive install lifecycle", (fixture) => {
      fixture.shrinkwrap.packages["node_modules/alpha"].hasInstallScript = true;
    }],
  ];

  for (const [label, mutate] of cases) {
    const fixture = validFixture();
    mutate(fixture);
    assert.throws(
      () => admitDependencyGraph(fixture),
      /dependency|integrity|lifecycle|link|registry|exact/i,
      label,
    );
  }
});

test("bundled graph admission matches each manifest dependency map to its lock entry", () => {
  const fixture = validFixture();
  fixture.packageJson.bundleDependencies = ["alpha"];
  const dependencyGraph = admitDependencyGraph(fixture);
  const entries = new Map([
    ["package/node_modules/alpha/package.json", Buffer.from(JSON.stringify({
      name: "alpha",
      version: "1.2.3",
      dependencies: {},
    }))],
  ]);

  assert.doesNotThrow(() => admitBundledGraph({
    entries,
    packageJson: fixture.packageJson,
    dependencyGraph,
  }));

  entries.set("package/node_modules/alpha/package.json", Buffer.from(JSON.stringify({
    name: "alpha",
    version: "1.2.3",
    dependencies: { beta: "^2.0.0" },
  })));
  assert.throws(
    () => admitBundledGraph({ entries, packageJson: fixture.packageJson, dependencyGraph }),
    /bundled dependency.*dependencies.*admitted graph/i,
  );

  entries.set("package/node_modules/alpha/package.json", Buffer.from(JSON.stringify({
    name: "alpha",
    version: "1.2.3",
    dependencies: {},
    optionalDependencies: { beta: "^2.0.0" },
  })));
  assert.throws(
    () => admitBundledGraph({ entries, packageJson: fixture.packageJson, dependencyGraph }),
    /bundled dependency.*optional dependencies.*admitted graph/i,
  );
});
