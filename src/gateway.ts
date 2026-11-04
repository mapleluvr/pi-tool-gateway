import { readFile, realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import type { TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BackendCandidate } from "./backends.ts";
import { createBackendExecutor, createExecutionEnv, type BackendExecutor, type ExecutionContextLike, type ExecutionIdentity } from "./operations.ts";
import { createMxcModeController, isMxcShell, type MxcModeConfiguration, type MxcModeLease } from "./mxc/mode.ts";
import type { BgTaskSnapshot } from "./registry.ts";
import { MxcRuntimeUnavailable } from "./mxc/errors.ts";
import type { MxcRuntime, MxcRuntimeOptions } from "./mxc/runtime.ts";

type PiModule = typeof import("@earendil-works/pi-coding-agent");
type FilesystemProfile = { readonlyPaths: string[]; deniedPaths: string[] };
type SessionPath = { path: string; access: "ro" | "rw" | "deny" };
type ProfileSnapshot = ({ profile: FilesystemProfile } | { error: string }) & { paths: SessionPath[] };
export interface GatewayDependencies {
  enabled?: boolean;
  policyPath?: string;
  /** Per-stage bound for trusted profile preparation and backend availability. */
  checkTimeoutMs?: number;
  runtimeOptions?: Omit<MxcRuntimeOptions, "candidate" | "workspace" | "piPackageRoot"> & { piPackageRoot?: string };
  runtimeFactory?: (options: MxcRuntimeOptions) => Promise<MxcRuntime>;
}
export interface GatewayExecution {
  executor: BackendExecutor;
  env?: NodeJS.ProcessEnv;
  identity: ExecutionIdentity;
  warning?: string;
}

export function createToolGateway(
  pi: ExtensionAPI,
  dependencies: GatewayDependencies,
  getBackend: (ctx?: ExtensionContext) => BackendCandidate | undefined,
  getTasks: () => BgTaskSnapshot[] = () => [],
) {
  let enabled = false;
  let policyPath = dependencies.policyPath;
  let started = false;
  let installed = false;
  let installationError: unknown;
  let sdk: PiModule | undefined;
  let latestContext: ExtensionContext | undefined;
  let selectedCandidate: BackendCandidate | undefined;
  let fileTail: Promise<void> = Promise.resolve();
  let disposed = false;
  let selectedConfigurationKey = "";
  let preferenceGeneration = 0;
  const runtimes = new Set<MxcRuntime>();
  const notices = new Set<string>();
  let sessionPaths: SessionPath[] = [];
  let pathVersion = 0;
  let sessionVersion = 0;
  let pathTail: Promise<unknown> = Promise.resolve();
  const stagedChecks = new Set<ReturnType<typeof createMxcModeController<MxcRuntime>>>();

  function inside(path: string, root: string): boolean {
    const relative = win32.relative(root, path);
    return relative === "" || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
  }
  function pathKey(path: string): string { return win32.normalize(path).toLowerCase(); }

  function fallbackHint(reason: string): string {
    return `MXC 不可用：${reason}。已切回普通 pwsh；文件与命令工具当前使用原生权限。`;
  }
  function statusText(): string {
    const state = mode.snapshot();
    let effective = "Native";
    if (state.phase === "ready") effective = "MXC";
    else if (state.phase === "checking") effective = "checking";
    const shell = isMxcShell(selectedCandidate) ? "pwsh" : selectedCandidate?.id ?? "shell";
    return `${shell}: ${effective} | files: ${effective}${state.phase === "fallback" ? " (MXC fallback)" : ""}`;
  }
  function publish(): void {
    latestContext?.ui?.setStatus?.("pi-tool-gateway", statusText());
    const state = mode.snapshot();
    if (state.phase !== "fallback" || !state.reason) return;
    const key = `${state.generation}:${state.reason}`;
    if (notices.has(key) || !latestContext?.ui) return;
    latestContext.ui.notify(fallbackHint(state.reason), "warning");
    notices.add(key);
  }
  async function boundedPreparation<T>(prepare: (signal: AbortSignal) => Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error("Operation aborted");
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => { reject(new Error("Operation aborted")); controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        reject(new MxcRuntimeUnavailable(`MXC ${label} check timed out`));
        controller.abort();
      }, dependencies.checkTimeoutMs ?? 15_000);
    });
    try { return await Promise.race([prepare(controller.signal), stopped]); }
    finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  function checkedProfile(workspace: string, signal?: AbortSignal, paths = sessionPaths): Promise<FilesystemProfile> {
    return boundedPreparation((ownSignal) => profile(workspace, paths, ownSignal), "policy profile", signal);
  }
  async function profile(workspace: string, entries: SessionPath[], signal?: AbortSignal): Promise<FilesystemProfile> {
    if (!policyPath) return { readonlyPaths: [], deniedPaths: [] };
    if (!win32.isAbsolute(policyPath)) throw new MxcRuntimeUnavailable("MXC policy profile path must be absolute");
    const metadata = await stat(policyPath);
    if (metadata.nlink !== 1) throw new MxcRuntimeUnavailable("MXC policy profile must not have hard links");
    const canonicalProfile = await realpath(policyPath);
    const roots = [workspace, ...(dependencies.runtimeOptions?.readwritePaths ?? []), ...entries.filter((entry) => entry.access === "rw").map((entry) => entry.path)];
    for (const root of roots) {
      if (inside(canonicalProfile, await realpath(root))) throw new MxcRuntimeUnavailable(`MXC policy profile must be outside every RW workspace/root: ${root}`);
    }
    const text = await readFile(canonicalProfile, { encoding: "utf8", signal });
    let parsed: { version?: unknown; filesystem?: { readonlyPaths?: unknown; deniedPaths?: unknown } };
    try { parsed = JSON.parse(text); }
    catch { throw new MxcRuntimeUnavailable("Invalid MXC policy profile JSON"); }
    if (!parsed || parsed.version !== 1 || !parsed.filesystem) throw new MxcRuntimeUnavailable("MXC policy profile requires version=1 and filesystem");
    function paths(value: unknown): string[] {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !win32.isAbsolute(path))) {
        throw new MxcRuntimeUnavailable("MXC policy paths must be arrays of absolute Windows paths");
      }
      return [...value];
    }
    return { readonlyPaths: paths(parsed.filesystem.readonlyPaths), deniedPaths: paths(parsed.filesystem.deniedPaths) };
  }

  async function checkConfiguration(configuration: MxcModeConfiguration, signal: AbortSignal): Promise<MxcRuntime> {
    if (installationError) throw installationError;
    const snapshot = JSON.parse(configuration.revision) as ProfileSnapshot;
    if ("error" in snapshot) throw new MxcRuntimeUnavailable(snapshot.error);
    const policy = snapshot.profile;
    const paths = (access: SessionPath["access"]) => snapshot.paths.filter((entry) => entry.access === access).map((entry) => entry.path);
    sdk ??= await import("@earendil-works/pi-coding-agent");
    const runtimeOptions = dependencies.runtimeOptions ?? {};
    const factory = dependencies.runtimeFactory ?? (await import("./mxc/runtime.ts")).createMxcRuntime;
    const runtime = await factory({
      ...runtimeOptions, candidate: configuration.candidate!, workspace: configuration.workspace,
      piPackageRoot: runtimeOptions.piPackageRoot ?? sdk.getPackageDir(),
      readonlyPaths: [...(runtimeOptions.readonlyPaths ?? []), ...policy.readonlyPaths, ...paths("ro")],
      readwritePaths: [...(runtimeOptions.readwritePaths ?? []), ...paths("rw")],
      deniedPaths: [...(runtimeOptions.deniedPaths ?? []), ...policy.deniedPaths, ...paths("deny")],
      profilePath: policyPath ?? runtimeOptions.profilePath,
    });
    runtimes.add(runtime);
    try {
      if (disposed || signal.aborted) throw new Error("Operation aborted");
      await runtime.check(signal);
      if (disposed || signal.aborted) throw new Error("Operation aborted");
      return runtime;
    } catch (error) {
      await runtime.dispose();
      runtimes.delete(runtime);
      throw error;
    }
  }
  const mode = createMxcModeController<MxcRuntime>({
    onChange: publish, checkTimeoutMs: dependencies.checkTimeoutMs, check: checkConfiguration,
  });

  async function select(candidate: BackendCandidate | undefined, ctx: ExtensionContext, signal?: AbortSignal): Promise<MxcModeLease<MxcRuntime>> {
    if (disposed) throw new Error("Operation aborted");
    latestContext = ctx;
    selectedCandidate = candidate;
    const generation = mode.snapshot().generation;
    const requested = enabled;
    const ownPathVersion = pathVersion;
    const paths = sessionPaths.map((entry) => ({ ...entry }));
    const workspace = ctx.cwd ?? process.cwd();
    let snapshot: ProfileSnapshot = { profile: { readonlyPaths: [], deniedPaths: [] }, paths };
    if (requested && isMxcShell(candidate)) {
      try { snapshot = { profile: await checkedProfile(workspace, signal, paths), paths }; }
      catch (error) { snapshot = { error: error instanceof Error ? error.message : String(error), paths }; }
    }
    if (disposed || signal?.aborted) throw new Error("Operation aborted");
    const configuration = { requested, candidate, workspace, revision: JSON.stringify(snapshot) };
    const key = JSON.stringify(configuration);
    if (requested !== enabled || ownPathVersion !== pathVersion || (generation !== mode.snapshot().generation && key !== selectedConfigurationKey)) {
      throw new Error("MXC configuration changed while preparing the policy profile");
    }
    selectedConfigurationKey = key;
    mode.configure(configuration);
    const lease = await mode.resolve(signal);
    publish();
    return lease;
  }

  function watchedExecutor(lease: Extract<MxcModeLease<MxcRuntime>, { mode: "mxc" }>): BackendExecutor {
    return {
      candidate: lease.runtime.candidate,
      async exec(command, cwd, options) {
        try { return await lease.runtime.createExecutor().exec(command, cwd, options); }
        catch (error) {
          if (!options.signal?.aborted && error instanceof MxcRuntimeUnavailable) mode.unavailable(lease.generation, error);
          throw error;
        }
      },
    };
  }
  async function execution(candidate: BackendCandidate, ctx: ExtensionContext, signal?: AbortSignal): Promise<GatewayExecution> {
    const lease = await select(candidate, ctx, signal);
    if (lease.mode === "mxc") return {
      executor: watchedExecutor(lease),
      identity: { mode: "mxc", shellPath: lease.runtime.candidate.path, workspace: lease.runtime.workspace, policyId: lease.runtime.policyId },
    };
    return {
      executor: createBackendExecutor(candidate), env: createExecutionEnv(ctx as ExecutionContextLike),
      identity: { mode: "native", shellPath: candidate.path, workspace: ctx.cwd },
      ...(lease.reason ? { warning: fallbackHint(lease.reason) } : {}),
    };
  }
  function annotate<D>(result: AgentToolResult<D>, reason?: string): AgentToolResult<D> {
    if (!reason) return result;
    const hint = fallbackHint(reason);
    let structuredContent = result.structuredContent;
    if (typeof structuredContent === "string") structuredContent = `${hint}\n\n${structuredContent}`;
    else if (structuredContent && typeof structuredContent === "object" && "type" in structuredContent && structuredContent.type === "image") {
      const image = structuredContent as { note?: string };
      structuredContent = { ...image, note: `${hint}\n\n${image.note ?? ""}` };
    }
    return { ...result, structuredContent, content: [{ type: "text", text: hint }, ...result.content] };
  }

  async function installFiles(ctx: ExtensionContext): Promise<void> {
    if (installed) return;
    sdk ??= await import("@earendil-works/pi-coding-agent");
    if (installed || disposed) return;
    function register<T extends TSchema, D>(native: ToolDefinition<T, D>) {
      pi.registerTool({
        ...native,
        async execute(id, params, signal, onUpdate, toolContext) {
          const lease = await select(getBackend(toolContext), toolContext, signal);
          const run = fileTail.then(async () => {
            if (disposed || signal?.aborted) throw new Error("Operation aborted");
            if (lease.mode === "native") return annotate(await native.execute(id, params, signal, onUpdate, toolContext), lease.reason);
            try {
              return await lease.runtime.executeFile(native.name as "read" | "write" | "edit", params as Record<string, unknown>, {
                signal,
                model: toolContext.model ? {
                  id: toolContext.model.id, name: toolContext.model.name,
                  input: [...toolContext.model.input], inputLimits: toolContext.model.inputLimits,
                } : undefined,
              }) as AgentToolResult<D>;
            } catch (error) {
              if (!signal?.aborted && error instanceof MxcRuntimeUnavailable) mode.unavailable(lease.generation, error);
              throw error;
            }
          });
          fileTail = run.then(() => undefined, () => undefined);
          return run;
        },
      });
    }
    register(sdk.createReadToolDefinition(ctx.cwd));
    register(sdk.createWriteToolDefinition(ctx.cwd));
    register(sdk.createEditToolDefinition(ctx.cwd));
    if (pi.getActiveTools().includes("powershell")) {
      const native = sdk.createPowerShellToolDefinition(ctx.cwd);
      pi.registerTool({
        ...native, defaultActive: false,
        async execute(id, params, signal, onUpdate, toolContext) {
          const lease = await select(getBackend(toolContext), toolContext, signal);
          if (lease.mode === "native") return annotate(await native.execute(id, params, signal, onUpdate, toolContext), lease.reason);
          const tool = sdk!.createPowerShellToolDefinition(toolContext.cwd, {
            exposeSessionEnvironment: false,
            operations: { exec: (command, cwd, options) => watchedExecutor(lease).exec(command, cwd, options) },
          });
          return tool.execute(id, params, signal, onUpdate, toolContext);
        },
      });
    }
    installed = true;
  }

  function oldTaskNotice(policyId?: string): string {
    const tasks = getTasks().filter((task) => task.status === "running" && task.execution?.mode === "mxc" && task.execution.policyId !== policyId);
    return [
      "已取得 lease 的调用保留启动时权限；撤销不删除目录，也不迁移旧任务。",
      ...tasks.map((task) => `旧策略任务 ${task.id} | policyId: ${task.execution?.policyId} | bg_kill {"taskId":"${task.id}"}`),
    ].join("\n");
  }

  async function listPaths(ctx: ExtensionContext): Promise<void> {
    const lease = await select(getBackend(ctx), ctx);
    let fixed: FilesystemProfile = { readonlyPaths: [], deniedPaths: [] };
    let profileError: string | undefined;
    try { fixed = await checkedProfile(ctx.cwd); }
    catch (error) { profileError = error instanceof Error ? error.message : String(error); }
    const runtimeOptions = dependencies.runtimeOptions;
    const readonly = [...(runtimeOptions?.readonlyPaths ?? []), ...fixed.readonlyPaths];
    const denied = [...(runtimeOptions?.deniedPaths ?? []), ...fixed.deniedPaths];
    const rows = [
      `${statusText()} | state: ${mode.snapshot().phase}`,
      "以下会话配置仅在 MXC 生效时约束受控工具；Native/fallback 使用宿主权限。",
      ...(profileError ? [`PROFILE ERROR（该 profile 内容未列出）: ${profileError}`] : []),
      `RW [workspace] ${ctx.cwd}`,
      ...(runtimeOptions?.readwritePaths ?? []).map((path) => `RW [fixed] ${path}`),
      ...readonly.map((path) => `RO [profile/fixed] ${path}`),
      ...denied.map((path) => `DENY [profile/fixed] ${path}`),
      ...sessionPaths.map((entry) => `${entry.access.toUpperCase()} [session${entry.access === "deny" ? " revoked" : ""}] ${entry.path}`),
    ];
    if (lease.mode === "mxc") {
      const known = new Set([...readonly, ...sessionPaths.map((entry) => entry.path)].map(pathKey));
      rows.push(...lease.runtime.paths.readonlyPaths.filter((path) => !known.has(pathKey(path))).map((path) => `RO [runtime] ${path}`));
      rows.push(`RW [private job only] ${lease.runtime.paths.scratchRoot}\\job-*（每作业独立，非整个控制目录授权）`);
    } else rows.push("私有 TEMP 与可信运行资源在实际 MXC 启用时配置。");
    rows.push(oldTaskNotice(lease.mode === "mxc" ? lease.runtime.policyId : undefined));
    ctx.ui.notify(rows.join("\n"), "info");
  }

  async function changePaths(args: string, ctx: ExtensionContext): Promise<void> {
    if (disposed) throw new Error("Operation aborted");
    const candidate = getBackend(ctx);
    if (process.platform !== "win32" || !isMxcShell(candidate)) throw new Error("目录授权验证需要选中 pwsh7；使用 /bash-select pwsh7，不会自动切换 Shell");
    const requested = enabled;
    const generation = mode.snapshot().generation;
    const ownPathVersion = pathVersion;
    const allow = /^allow\s+(ro|rw)\s+(.+)$/i.exec(args);
    const revoke = /^revoke\s+(.+)$/i.exec(args);
    if (!allow && !revoke) throw new Error("Use /mxc allow ro|rw <absolute-directory> or /mxc revoke <absolute-directory>");
    let input = (allow?.[2] ?? revoke![1]).trim();
    if (input.startsWith('"') || input.startsWith("'")) {
      if (input.length < 2 || input.at(-1) !== input[0]) throw new Error("Directory path has unmatched quotes");
      input = input.slice(1, -1);
    }
    input = win32.normalize(input);
    if (input.startsWith("\\\\?\\")) input = input.slice(4);
    if (!/^[a-z]:\\/i.test(input)) throw new Error("Directory path must be an absolute local Windows drive path");
    const existing = sessionPaths.find((entry) => pathKey(entry.path) === pathKey(input));
    const path = await boundedPreparation(async () => {
      if (revoke && existing) return existing.path;
      const canonical = await realpath(input);
      if (!(await stat(canonical)).isDirectory()) throw new Error("Session path must be an existing directory");
      return sessionPaths.find((entry) => pathKey(entry.path) === pathKey(canonical))?.path ?? canonical;
    }, "directory");
    const current = sessionPaths.find((entry) => pathKey(entry.path) === pathKey(path));
    if (revoke && (!current || current.access === "deny")) throw new Error("No active session grant for this directory");
    const workspace = await boundedPreparation(() => realpath(ctx.cwd), "workspace");
    if (inside(path, workspace) || inside(workspace, path)) throw new Error("Session roots must be separate from the default RW workspace");
    if (sessionPaths.some((entry) => pathKey(entry.path) !== pathKey(path) && (inside(path, entry.path) || inside(entry.path, path)))) throw new Error("Session permission roots must not overlap; adjust the existing grant first");
    const access = allow ? allow[1].toLowerCase() as "ro" | "rw" : "deny";
    const next: SessionPath[] = [...sessionPaths.filter((entry) => pathKey(entry.path) !== pathKey(path)), { path, access }];
    const fixed = await checkedProfile(ctx.cwd, undefined, next);
    const snapshot: ProfileSnapshot = { profile: fixed, paths: next };
    const configuration = { requested, candidate, workspace: ctx.cwd, revision: JSON.stringify(snapshot) };
    const staged = createMxcModeController<MxcRuntime>({ check: checkConfiguration, checkTimeoutMs: dependencies.checkTimeoutMs });
    stagedChecks.add(staged);
    let checked: MxcRuntime | undefined;
    let retained = false;
    try {
      staged.configure({ ...configuration, requested: true });
      const lease = await staged.resolve();
      if (lease.mode !== "mxc") throw new Error(lease.reason ?? "MXC candidate is unavailable");
      checked = lease.runtime;
      const freshProfile = await checkedProfile(ctx.cwd, undefined, next);
      if (disposed || generation !== mode.snapshot().generation || requested !== enabled || ownPathVersion !== pathVersion ||
        JSON.stringify(candidate) !== JSON.stringify(getBackend(ctx)) || JSON.stringify(fixed) !== JSON.stringify(freshProfile)) {
        throw new Error("MXC configuration changed before directory candidate commit");
      }
      if (requested) { mode.commit(configuration, checked, generation); retained = true; }
      else mode.configure(configuration);
      sessionPaths = next;
      pathVersion++;
      selectedConfigurationKey = JSON.stringify(configuration);
      publish();
      ctx.ui.notify(`会话目录 ${access.toUpperCase()}: ${path}\n${statusText()}\n${oldTaskNotice(requested ? checked.policyId : undefined)}`, "info");
    } finally {
      staged.invalidate(); stagedChecks.delete(staged);
      if (checked && !retained) { await checked.dispose(); runtimes.delete(checked); }
    }
  }

  async function enable(requested: boolean, ctx: ExtensionContext): Promise<void> {
    latestContext = ctx;
    const generation = ++preferenceGeneration;
    for (const staged of stagedChecks) staged.invalidate();
    let error: unknown;
    if (requested) {
      try { await installFiles(ctx); }
      catch (failure) { error = failure; }
    }
    if (disposed || generation !== preferenceGeneration) return;
    if (requested) installationError = error;
    enabled = requested;
    mode.invalidate();
    await select(getBackend(ctx), ctx);
  }

  pi.registerFlag("mxc", { type: "boolean", default: false, description: "Use optional Windows pwsh/MXC execution (unavailable => native hint/fallback)" });
  pi.registerFlag("mxc-policy", { type: "string", description: "Absolute trusted path to a version=1 MXC filesystem profile" });
  pi.registerCommand("mxc", {
    description: "MXC session: on/off/status/retry, paths, allow ro|rw <directory>, revoke <directory>",
    async handler(args, ctx) {
      const input = args.trim();
      const argument = input.toLowerCase();
      try {
        if (argument === "paths") { await listPaths(ctx); return; }
        if (/^(allow|revoke)(?:\s|$)/i.test(input)) {
          const ownSession = sessionVersion;
          const pending = pathTail.then(() => {
            if (disposed || ownSession !== sessionVersion) throw new Error("Session changed before directory command");
            return changePaths(input, ctx);
          });
          pathTail = pending.catch(() => undefined);
          await pending; return;
        }
        if (argument === "on" || argument === "off") { await enable(argument === "on", ctx); return; }
        if (argument === "retry") { mode.invalidate(); await select(getBackend(ctx), ctx); return; }
        if (argument && argument !== "status") throw new Error("Use /mxc on|off|status|retry|paths or allow ro|rw <directory> / revoke <directory>");
        await select(getBackend(ctx), ctx);
        ctx.ui.notify(`${statusText()} | requested: ${enabled ? "on" : "off"} | state: ${mode.snapshot().phase}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    notices.clear();
    sessionPaths = []; pathVersion++; sessionVersion++;
    for (const staged of stagedChecks) staged.invalidate();
    if (started) { mode.invalidate(); await select(getBackend(ctx), ctx); }
    else {
      started = true;
      policyPath ??= pi.getFlag("mxc-policy") as string | undefined;
      await enable(dependencies.enabled ?? pi.getFlag("mxc") === true, ctx);
    }
  });
  pi.on("user_bash", async (_event, ctx) => {
    const candidate = getBackend(ctx);
    if (!enabled || !isMxcShell(candidate)) return;
    const route = await execution(candidate!, ctx);
    return { operations: { exec: (command, cwd, options) => route.executor.exec(command, cwd, { ...options, env: route.env }) } };
  });

  async function dispose(): Promise<void> {
    disposed = true;
    for (const staged of stagedChecks) staged.invalidate();
    mode.configure({ requested: false, workspace: "", revision: "shutdown" });
    await pathTail;
    await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
    await fileTail;
    latestContext?.ui?.setStatus?.("pi-tool-gateway", undefined);
  }
  return { execution, refresh: (ctx: ExtensionContext) => select(getBackend(ctx), ctx), snapshot: mode.snapshot, dispose };
}
