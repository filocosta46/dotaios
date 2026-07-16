import test from "node:test";
import assert from "node:assert/strict";
import { googleCommand } from "../../packages/cli/src/commands/google.mjs";
import {
  GWS_READ_ONLY_SCOPES,
  GWS_READ_ONLY_SERVICES,
  gwsReadOnlyLoginArgs
} from "../../packages/cli/src/lib/gws.mjs";

test("google setup rejects full, custom-scope, and custom-service escalation", async () => {
  const rejectedOptions = [
    ["--full"],
    ["--scopes", "https://www.googleapis.com/auth/gmail.modify"],
    ["--services", "gmail,calendar,drive,admin"]
  ];

  for (const optionArgs of rejectedOptions) {
    await assert.rejects(
      () => googleCommand(["setup", ...optionArgs]),
      /fixed Gmail, Calendar, and Drive read-only access/
    );
  }
});

test("gws login arguments are fixed to the supported read-only services", () => {
  assert.deepEqual(GWS_READ_ONLY_SERVICES, ["gmail", "calendar", "drive"]);
  assert.deepEqual(gwsReadOnlyLoginArgs(), [
    "--readonly",
    "--services",
    "gmail,calendar,drive"
  ]);
  assert.deepEqual(GWS_READ_ONLY_SCOPES, [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly"
  ]);
});
