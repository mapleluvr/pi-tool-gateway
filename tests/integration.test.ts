import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../index.ts";
import {
  discoverBackends,
  resolveBackend,
  type BackendCandidate,
} from "../src/backends.ts";
import { createBackendExecutor } from "../src/operations.ts";
import { createBackendStateStore } from "../src/state.ts";

const discovered = discoverBackends();
const selected = discovered.length
  ? resolveBackend("auto", discovered)
  : undefined;

function byId(id: string) {
  return discovered.find((candidate) => candidate.id === id);
}

async function runReal(
  candidate: BackendCandidate,
  command: string,
): Promise<{ result: { exitCode: number | null }; output: string }> {
  const output: Buffer[] = [];
  const result = await createBackendExecutor(candidate).exec(
    command,
    process.cwd(),
    { onData: (chunk) => output.push(chunk) },
  );
  return { result, output: Buffer.concat(output).toString("utf8") };
}

test(
  "real auto discovery selects the first installed backend in required order",
  { skip: !selected },
  () => {
    const current = selected!;
    assert.ok(!/cmd\.exe/i.test(current.path));
    assert.equal(
      current.id,
      byId("pwsh7") ? "pwsh7" : byId("gitbash") ? "gitbash" : "powershell51",
    );
  },
);


test(
  "real extension bash tool executes through its selected auto backend",
  { skip: !selected },
  async () => {
    const current = selected!;
    const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-real-extension-"));
    try {
    const tools = new Map<string, any>();
    const pi: any = {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      registerFlag() {},
      getFlag() { return undefined; },
      on() {},
    };
    createExtension(pi, {
      stateStore: createBackendStateStore({
        statePath: join(dir, "pi-bash-bg.json"),
      }),
      discoverBackends: () => discovered,
      outputDir: join(dir, "logs"),
    });
    const command =
      current.kind === "powershell"
        ? "$PSVersionTable.PSVersion.ToString()"
        : "printf '%s\\n' \"$BASH_VERSION\"";
    const result = await tools.get("bash").execute(
      "real-call",
      { command, timeout: 20 },
      undefined,
      undefined,
      { cwd: dir },
    );
    const output = result.content[0].text as string;
    assert.match(tools.get("bash").description, new RegExp(current.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (current.kind === "powershell") {
      assert.match(output.trim(), /^\d+(?:\.\d+){1,3}$/);
    } else {
      assert.match(output.trim(), /^\d+\.\d+/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "real PowerShell 7 executor runs PowerShell syntax",
  { skip: !byId("pwsh7") },
  async () => {
    const candidate = byId("pwsh7")!;
    const { result, output } = await runReal(
      candidate,
      "$PSVersionTable.PSVersion.ToString()",
    );
    assert.equal(result.exitCode, 0);
    assert.match(output.trim(), /^7(?:\.\d+){1,3}$/);
  },
);

test(
  "real Git Bash executor runs Bash syntax",
  { skip: !byId("gitbash") },
  async () => {
    const candidate = byId("gitbash")!;
    const { result, output } = await runReal(
      candidate,
      "printf '%s\\n' \"$BASH_VERSION\"",
    );
    assert.equal(result.exitCode, 0);
    assert.match(output.trim(), /^\d+\.\d+/);
  },
);

test(
  "real PowerShell 5.1 executor runs when installed",
  { skip: !byId("powershell51") },
  async () => {
    const candidate = byId("powershell51")!;
    const { result, output } = await runReal(
      candidate,
      "$PSVersionTable.PSVersion.ToString()",
    );
    assert.equal(result.exitCode, 0);
    assert.match(output.trim(), /^5(?:\.\d+){1,3}$/);
  },
);
