import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { dictionary } from "../../website/src/content.js";
import { PUBLIC_EVENT_NAMES, PUBLIC_OFFER } from "../../website/src/offer.js";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("the Consultant Pack module and public JSON expose the same buyer facts", async () => {
  const file = path.join(repoRoot, "website", "public", "offer.json");
  const publicJson = JSON.parse(await fs.readFile(file, "utf8"));

  assert.deepEqual(publicJson, PUBLIC_OFFER);
  assert.equal(PUBLIC_OFFER.schema, "dotaios.public-offer.v1");
  assert.equal(PUBLIC_OFFER.id, "consultant-pack");
  assert.deepEqual(PUBLIC_OFFER.price, {
    amount: "35.00",
    currency: "EUR",
    state: "planned"
  });
  assert.equal(PUBLIC_OFFER.ownership, "permanent-edition");
  assert.deepEqual(PUBLIC_OFFER.optionalUpdates, {
    amount: "4.00",
    currency: "EUR",
    cadence: "month",
    state: "planned-optional"
  });
  assert.equal(PUBLIC_OFFER.readiness.state, "unavailable");
  assert.equal(Object.hasOwn(PUBLIC_OFFER.readiness, "purchaseUrl"), false);
  assert.deepEqual(
    PUBLIC_OFFER.outcomes.map(({ id, state }) => ({ id, state })),
    [
      { id: "contact-to-client-workspace", state: "intended" },
      { id: "meeting-to-actions-and-follow-up", state: "candidate" },
      { id: "request-to-proposal-or-deliverable", state: "intended" }
    ]
  );
});

test("public offer evidence stays conservative about hosts and browser chats", () => {
  const codex = PUBLIC_OFFER.hostStates.find((host) => host.id === "codex");
  const claudeCode = PUBLIC_OFFER.hostStates.find((host) => host.id === "claude-code");

  assert.equal(codex.foundationEvidence.state, "outcome-produced");
  assert.equal(codex.packEvidence.state, "candidate");
  assert.equal(claudeCode.foundationEvidence.state, "invoked-no-outcome");
  assert.equal(claudeCode.foundationEvidence.produced, "no");
  assert.equal(claudeCode.foundationEvidence.bulkProbeEvidence.state, "failed");
  assert.equal(claudeCode.packEvidence.state, "candidate");
  assert.equal(PUBLIC_OFFER.browserFallback.localFolderAccess, false);
  assert.equal(PUBLIC_OFFER.browserFallback.state, "manual-fallback");
  assert.equal(PUBLIC_OFFER.evidenceSummary.approved, false);
  assert.equal(PUBLIC_OFFER.evidenceSummary.evidenceLevel, "candidate");
  assert.equal(PUBLIC_OFFER.evidenceSummary.testedHost, "Not tested");
  assert.match(PUBLIC_OFFER.evidenceSummary.permissions, /review/i);
  assert.match(PUBLIC_OFFER.evidenceSummary.dataMovement, /device|provider/i);
});

test("public foundation claims are backed by sanitized invocation receipts", async () => {
  const receiptByHost = new Map(await Promise.all(PUBLIC_OFFER.hostStates.map(async (host) => {
    const receiptFile = path.join(repoRoot, host.foundationEvidence.receipt);
    const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    return [host.id, receipt];
  })));

  for (const host of PUBLIC_OFFER.hostStates) {
    const evidence = host.foundationEvidence;
    const receipt = receiptByHost.get(host.id);

    assert.equal(receipt.schema, "dotaios.skill-invocation.v1");
    assert.match(receipt.targetPath, /^<temporary-project>\//);
    assert.match(receipt.skill.path, /^<temporary-project>\//);
    assert.equal(receipt.clientVersion, evidence.clientVersion);
    assert.equal(receipt.evidence.configured, evidence.configured);
    assert.equal(receipt.evidence.discoverable, evidence.discoverable);
    assert.equal(receipt.evidence.invoked, evidence.invoked);
    assert.equal(receipt.evidence.produced, evidence.produced);
    assert.equal(receipt.exitCode, 0);
  }

  const codex = PUBLIC_OFFER.hostStates.find((host) => host.id === "codex");
  const claudeCode = PUBLIC_OFFER.hostStates.find((host) => host.id === "claude-code");
  assert.equal(codex.foundationEvidence.observedAt, "2026-07-31");
  assert.equal(receiptByHost.get("codex").startedAt.slice(0, 10), codex.foundationEvidence.observedAt);
  assert.equal(receiptByHost.get("codex").marker, "DOTAIOS_PROBE_OK_f14500bb54affa2e");
  assert.equal(receiptByHost.get("codex").skill.sha256, "e85f0a4109268e49a3106b116afda09cbe372c7fe4693b7d8a8295eada00d7fe");
  assert.equal(claudeCode.foundationEvidence.state, "invoked-no-outcome");
  assert.equal(claudeCode.foundationEvidence.produced, "no");
  assert.equal(receiptByHost.get("claude-code").startedAt.slice(0, 10), claudeCode.foundationEvidence.observedAt);
  assert.equal(receiptByHost.get("claude-code").marker, "DOTAIOS_PROBE_OK_9b48a40e9afa7c5e");
  assert.equal(receiptByHost.get("claude-code").skill.sha256, "961b13b2208f82f6df1081175e454d360defc9f7513451dce5f16062c5507ee2");
});

test("visible host compatibility copy does not turn the Claude invocation into a success", () => {
  const enClaude = dictionary.en.consultantPack.hostStates.find((host) => host.id === "claude-code");
  const itClaude = dictionary.it.consultantPack.hostStates.find((host) => host.id === "claude-code");

  assert.match(`${enClaude.state} ${enClaude.detail}`, /no outcome|did not produce/i);
  assert.doesNotMatch(enClaude.state, /probe produced/i);
  assert.doesNotMatch(enClaude.detail, /^The explicit skill probe produced its expected result/i);
  assert.match(`${itClaude.state} ${itClaude.detail}`, /nessun risultato|non ha prodotto/i);
  assert.doesNotMatch(itClaude.state, /completato/i);
  assert.doesNotMatch(itClaude.detail, /^Il probe esplicito della skill ha prodotto il risultato atteso/i);
});

test("public offer data contains no checkout or private delivery fields", () => {
  const forbiddenKeys = new Set([
    "archiveUrl",
    "checkoutUrl",
    "credentialUrl",
    "customerData",
    "entitlementSecret",
    "installId",
    "licenseKey",
    "privateReceipt",
    "productId",
    "purchaseUrl",
    "sourceRepo",
    "upstreamCatalogue"
  ]);
  const pending = [PUBLIC_OFFER];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      assert.equal(forbiddenKeys.has(key), false, `public offer exposes private field "${key}"`);
      pending.push(value);
    }
  }

  assert.deepEqual(PUBLIC_OFFER.eventNames, PUBLIC_EVENT_NAMES);
  assert.equal(new Set(PUBLIC_EVENT_NAMES).size, PUBLIC_EVENT_NAMES.length);
  assert.equal(PUBLIC_EVENT_NAMES.every((name) => /^[a-z]+(?:_[a-z]+)*$/.test(name)), true);
  assert.doesNotMatch(JSON.stringify(PUBLIC_OFFER), /gumroad|github\.com|credential|license key|source repo/i);
});

test("both languages carry the required Consultant Pack buyer claims", () => {
  const expectedClaims = {
    en: {
      price: "€35 planned",
      optionalUpdates: "A future €4 monthly update plan would be optional.",
      readinessLabel: "Not available yet",
      readinessDetail: "Checkout stays closed until delivery, recovery, and professional outcome checks pass."
    },
    it: {
      price: "€35 previsti",
      optionalUpdates: "Un futuro piano di aggiornamenti da €4 al mese sarebbe facoltativo.",
      readinessLabel: "Non ancora disponibile",
      readinessDetail: "Il checkout resta chiuso finché i controlli su consegna, recupero e risultati professionali non saranno completati."
    }
  };

  for (const [lang, language] of Object.entries(dictionary)) {
    const offer = language.consultantPack;
    const expected = expectedClaims[lang];

    assert.equal(offer.name, PUBLIC_OFFER.name);
    assert.equal(offer.price, expected.price);
    assert.equal(offer.optionalUpdates, expected.optionalUpdates);
    assert.equal(offer.readiness.state, PUBLIC_OFFER.readiness.state);
    assert.equal(offer.readiness.label, expected.readinessLabel);
    assert.equal(offer.readiness.detail, expected.readinessDetail);
    assert.equal(offer.action.href, null);
    assert.doesNotMatch(offer.action.label, /buy|purchase|compra|acquista/i);
    assert.doesNotMatch(
      `${offer.readiness.label} ${offer.readiness.detail} ${offer.action.label}`,
      /available now|on sale|checkout (?:is )?open|buy now|purchase now|disponibile ora|in vendita|checkout aperto|compra ora|acquista ora/i
    );
    assert.deepEqual(
      offer.outcomes.map(({ id }) => id),
      PUBLIC_OFFER.outcomes.map(({ id }) => id)
    );
    assert.match(offer.browserFallback, /ChatGPT/);
    assert.match(offer.browserFallback, /local|locale/i);
    assert.doesNotMatch(JSON.stringify(language), /[\u2013\u2014]/);
  }
});
