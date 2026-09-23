import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, pickClaudeExecutable } from "./claudeExecutable.ts";

test("compareVersions compares dotted parts as integers", () => {
  assert.ok(compareVersions("2.1.280", "2.1.258") > 0);
  assert.ok(compareVersions("2.1.258", "2.1.280") < 0);
  assert.equal(compareVersions("2.1.280", "2.1.280"), 0);
  assert.ok(compareVersions("2.10.0", "2.9.9") > 0);
});

const base = {
  machine: "/m/claude",
  machineVersion: "2.1.281",
  bundledVersion: "2.1.280",
  platform: "darwin" as NodeJS.Platform,
};

test("pickClaudeExecutable takes a newer machine CLI", () => {
  assert.equal(pickClaudeExecutable(base), "/m/claude");
});

test("pickClaudeExecutable takes a machine CLI of the same version", () => {
  assert.equal(pickClaudeExecutable({ ...base, machineVersion: "2.1.280" }), "/m/claude");
});

test("pickClaudeExecutable falls back to the bundled CLI for an older machine CLI", () => {
  assert.equal(pickClaudeExecutable({ ...base, machineVersion: "2.1.200" }), undefined);
});

test("pickClaudeExecutable falls back when there is no machine CLI", () => {
  assert.equal(pickClaudeExecutable({ ...base, machine: null }), undefined);
});

test("pickClaudeExecutable falls back when the version is unreadable", () => {
  assert.equal(pickClaudeExecutable({ ...base, machineVersion: null }), undefined);
  assert.equal(pickClaudeExecutable({ ...base, machineVersion: "garbage" }), undefined);
});

test("pickClaudeExecutable on win32 takes only an .exe", () => {
  assert.equal(
    pickClaudeExecutable({ ...base, platform: "win32", machine: "C:\\bin\\claude.cmd" }),
    undefined,
  );
  assert.equal(
    pickClaudeExecutable({ ...base, platform: "win32", machine: "C:\\bin\\claude.exe" }),
    "C:\\bin\\claude.exe",
  );
});
