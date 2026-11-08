import test from "node:test";
import assert from "node:assert/strict";
import { sameProcess, type ProcessIdentity } from "./helpers/process-identity.ts";

const original: ProcessIdentity = { id: 12000, name: "pwsh", startedUtcTicks: "1000000" };

test("a PID reused by conhost is not the original pwsh process", () => {
  assert.equal(sameProcess(original, { id: original.id, name: "conhost", startedUtcTicks: "2000000" }), false);
});

test("even the same executable at a reused PID is a different process", () => {
  assert.equal(sameProcess(original, { ...original, startedUtcTicks: "2000000" }), false);
});

test("the same independently observed creation identity remains alive", () => {
  assert.equal(sameProcess(original, { ...original }), true);
});

test("an absent process and a different PID do not match the target identity", () => {
  assert.equal(sameProcess(original, null), false);
  assert.equal(sameProcess(original, { ...original, id: 13000 }), false);
});

test("an incomplete creation identity is an observation failure, not proof of exit", () => {
  assert.throws(() => sameProcess(original, { id: original.id, name: "pwsh" } as ProcessIdentity), /creation time/);
});
