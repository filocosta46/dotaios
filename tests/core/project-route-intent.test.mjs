import assert from "node:assert/strict";
import test from "node:test";
import { hasConcreteAction } from "../../packages/core/src/project-route-intent.mjs";

const career = { slug: "career", name: "Career" };
const careerOps = { slug: "career-ops", name: "Career Ops" };
const dashboard = { slug: "dashboard", name: "Dashboard" };

test("ordinary English tasks are actionable before a project handle", () => {
  for (const intent of [
    "answer this question for career",
    "apply to this job for career",
    "ask about this role for career",
    "book an interview for career",
    "cancel this interview for career",
    "choose a role for career",
    "compile these references for career",
    "draft an application for career",
    "email the recruiter for career",
    "enrol in this course for career",
    "file this application for career",
    "find open roles for career",
    "finish this application for career",
    "follow up on this application for career",
    "handle this reply for career",
    "list upcoming interviews for career",
    "pay this course fee for career",
    "pick an interview time for career",
    "post this portfolio update for career",
    "reply to the recruiter for career",
    "request an interview for career",
    "respond to this offer for career",
    "send this application for career",
    "set a reminder for career",
    "sign this offer for career",
    "sort these applications for career",
    "start this application for career",
    "submit this application for career",
    "tidy these notes for career",
    "try this interview exercise for career",
    "use this resume for career",
    "withdraw this application for career",
    "wrap up this application for career"
  ]) {
    assert.equal(hasConcreteAction(intent, career), true, intent);
  }
});

test("a project handle can prefix English and Italian task commands", () => {
  for (const [intent, project] of [
    ["career ops evaluate this role", careerOps],
    ["career ops apply to this job", careerOps],
    ["career ops submit this application", careerOps],
    ["dashboard fix the release script", dashboard],
    ["dashboard please review this change", dashboard],
    ["in dashboard correggi il bug", dashboard],
    ["dashboard aggiorna il documento", dashboard],
    ["dashboard riassumi il documento", dashboard]
  ]) {
    assert.equal(hasConcreteAction(intent, project), true, intent);
  }
});

test("Italian request words preserve commands after a project handle", () => {
  for (const intent of [
    "dashboard per favore correggi il bug",
    "dashboard ora aggiorna il documento",
    "in dashboard per favore riassumi il documento"
  ]) {
    assert.equal(hasConcreteAction(intent, dashboard), true, intent);
  }
});

test("Italian request words do not turn negation or navigation into commands", () => {
  for (const intent of [
    "dashboard per favore non correggi il bug",
    "dashboard ora non aggiorna il documento",
    "in dashboard per favore non riassumi il documento",
    "dashboard per favore mostra le release notes"
  ]) {
    assert.equal(hasConcreteAction(intent, dashboard), false, intent);
  }
});

test("project references remain non-actionable when their nouns are also verbs", () => {
  for (const intent of [
    "Dashboard release notes",
    "The dashboard release notes",
    "The dashboard release notes for next week's launch",
    "Dashboard needs release notes",
    "Dashboard needs a list of changes",
    "The dashboard request file",
    "The dashboard list of issues"
  ]) {
    assert.equal(hasConcreteAction(intent, dashboard), false, intent);
  }
});

test("action detection accepts handle-free tasks without claiming a project match", () => {
  assert.equal(hasConcreteAction("help me apply to this job", career), true);
  assert.equal(hasConcreteAction("fix the release script", dashboard), true);
});

test("request prefixes preserve ordinary English commands", () => {
  for (const intent of [
    "could you please send this application for career ops",
    "I'd like to apply to this job for career ops",
    "help me submit this application for career ops",
    "please career ops can you evaluate this role",
    "for career ops please find open roles"
  ]) {
    assert.equal(hasConcreteAction(intent, careerOps), true, intent);
  }
});

test("colon-prefixed project commands remain explicit", () => {
  for (const intent of [
    "career ops: evaluate this role",
    "career ops: please apply to this job",
    "career ops: can you submit this application"
  ]) {
    assert.equal(hasConcreteAction(intent, careerOps), true, intent);
  }
  assert.equal(hasConcreteAction("dashboard: release notes", dashboard), true);
  assert.equal(hasConcreteAction("dashboard please release notes", dashboard), true);
});

test("negation prevents English commands before and after a project handle", () => {
  for (const intent of [
    "do not apply to this job for career",
    "don't submit this application for career",
    "never send this application for career",
    "career do not apply to this job",
    "career don't submit this application",
    "career never send this application",
    "career: do not apply to this job"
  ]) {
    assert.equal(hasConcreteAction(intent, career), false, intent);
  }
});

test("navigation and reference prefixes remain non-actionable around task words", () => {
  for (const intent of [
    "go to dashboard",
    "switch to dashboard",
    "show dashboard release notes",
    "could you please show the dashboard file list",
    "tell me about dashboard release notes",
    "what about dashboard release notes",
    "where is the dashboard request file",
    "work in dashboard",
    "load dashboard"
  ]) {
    assert.equal(hasConcreteAction(intent, dashboard), false, intent);
  }
});

test("opening a project alone remains navigation", () => {
  for (const intent of [
    "open dashboard",
    "dashboard open",
    "dashboard: open",
    "dashboard please open it"
  ]) {
    assert.equal(hasConcreteAction(intent, dashboard), false, intent);
  }
});

test("opening a concrete project artifact remains actionable", () => {
  for (const intent of [
    "open a pull request for dashboard",
    "dashboard open the readme",
    "dashboard: open an issue",
    "dashboard please open the file"
  ]) {
    assert.equal(hasConcreteAction(intent, dashboard), true, intent);
  }
});

test("a new action verb inside a project handle is not itself a command", () => {
  const requestFile = { slug: "request-file", name: "Request File" };
  assert.equal(hasConcreteAction("request file", requestFile), false);
  assert.equal(hasConcreteAction("request file: send this document", requestFile), true);
});

test("new verbs work in declarative tasks with and without a project handle", () => {
  assert.equal(hasConcreteAction("career needs to submit this application", career), true);
  assert.equal(hasConcreteAction("career applications need sorting", career), true);
  assert.equal(hasConcreteAction("these applications need sorting", career, { requireHandle: false }), true);
});

test("negated declarative tasks remain non-actionable", () => {
  assert.equal(hasConcreteAction("career does not need to submit this application", career), false);
  assert.equal(hasConcreteAction("career applications never need sorting", career), false);
  assert.equal(hasConcreteAction("these applications do not need sorting", career, { requireHandle: false }), false);
});
