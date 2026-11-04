import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createExtension } from "../../index.ts";
import { createBackendStateStore } from "../../src/state.ts";
import type { GatewayDependencies } from "../../src/gateway.ts";
import { backends, createMxcFixture } from "./mxc-fixture.ts";

/** Registers the production extension. Only the Pi registration/UI surface is
 * held here; execution defaults to the real MXC runtime, worker and pwsh. */
export async function withGateway(
  run: (harness: {
    fixture: Awaited<ReturnType<typeof createMxcFixture>>; extra: string; ctx: any;
    notices: { text: string; kind: string }[]; statuses: string[];
    command: (args: string) => Promise<{ text: string; kind: string }[]>;
    call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
    restart: () => Promise<void>;
    pi: any;
  }) => Promise<void>,
  configure?: (fixture: Awaited<ReturnType<typeof createMxcFixture>>, extra: string) => GatewayDependencies | Promise<GatewayDependencies>,
) {
  const fixture = await createMxcFixture();
  const extra = join(fixture.dir, "Shared Temp 中文");
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const handlers = new Map<string, any>(); const flags = new Map<string, unknown>();
  const notices: { text: string; kind: string }[] = []; const statuses: string[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: (name: string, flag: any) => flags.set(name, flag.default),
    getFlag: (name: string) => flags.get(name),
    getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()], getSettings: () => ({}),
    on: (name: string, handler: any) => handlers.set(name, handler),
  };
  const ctx: any = { cwd: fixture.workspace, ui: {
    notify: (text: string, kind: string) => notices.push({ text, kind }),
    setStatus: (_key: string, text: string) => statuses.push(text),
  } };
  let sequence = 0;
  try {
    await mkdir(extra);
    const configured = await configure?.(fixture, extra);
    createExtension(pi, {
      stateStore: createBackendStateStore({ statePath: join(fixture.dir, "shell.json") }),
      discoverBackends: () => backends, outputDir: join(fixture.dir, "logs"),
      gateway: { enabled: true, runtimeOptions: fixture.options, ...configured },
    });
    const restart = () => handlers.get("session_start")({}, ctx);
    await restart();
    await run({
      fixture, extra, ctx, pi, notices, statuses, restart,
      command: async (args) => { const offset = notices.length; await commands.get("mxc").handler(args, ctx); return notices.slice(offset); },
      call: (name, args, signal) => tools.get(name).execute(`path-${++sequence}`, args, signal, undefined, ctx),
    });
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await fixture.cleanup();
  }
}
