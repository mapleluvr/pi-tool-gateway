import test from "node:test";
import assert from "node:assert/strict";
import promises from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { controlRuntime, deferred, withSlash } from "./helpers/slash-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };

// Actual metadata/profile reads are paused; no permission result is simulated.
// These cases verify presentation ownership, not MXC isolation capability.
test("off retires a directory operation while its canonical-path lookup is pending", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ command, fixture, widgets, notices }) => {
    const original = promises.realpath;
    promises.realpath = (async (path: any, ...args: any[]) => {
      if (String(path) === fixture.outside) { entered.resolve(); await release.promise; }
      return (original as any)(path, ...args);
    }) as typeof promises.realpath;
    syncBuiltinESMExports();
    const pending = command(`allow ro "${fixture.outside}"`);
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Metadata preparation was not entered"))]);
      await command("off");
      assert.equal(widgets.size, 0, "An obsolete metadata operation must not keep its progress widget");
      assert.ok(notices.some((notice) => /被较新配置取代/.test(notice.text)));
    } finally {
      release.resolve(); promises.realpath = original; syncBuiltinESMExports(); await pending;
    }
    assert.ok(!(await command("paths")).some((notice) => notice.text.includes(`[session] RO ${fixture.outside}`)));
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("off retires on while trusted-profile preparation is still pending", windows, async () => {
  const entered = deferred(); const release = deferred();
  let profile = "";
  await withSlash(async ({ command, widgets, notices, statuses }) => {
    const original = promises.readFile;
    promises.readFile = (async (path: any, ...args: any[]) => {
      if (String(path) === profile) { entered.resolve(); await release.promise; }
      return (original as any)(path, ...args);
    }) as typeof promises.readFile;
    syncBuiltinESMExports();
    const pending = command("on");
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Profile preparation was not entered"))]);
      await command("off");
      assert.equal(widgets.size, 0, "An obsolete preparation must not keep a busy indicator");
      assert.ok(notices.some((notice) => /被较新配置取代/.test(notice.text)));
    } finally {
      release.resolve(); promises.readFile = original; syncBuiltinESMExports(); await pending;
    }
    assert.match(statuses.at(-1)!, /files: Native/);
  }, (fixture) => {
    profile = join(fixture.dir, "slow-profile.json");
    writeFileSync(profile, JSON.stringify({ version: 1, filesystem: {} }));
    return { gateway: { enabled: false, policyPath: profile, runtimeFactory: async () => controlRuntime(fixture) as any } };
  });
});
