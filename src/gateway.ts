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
import { createCommandFeedback, type CommandOperation } from "./feedback.ts";

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
  stopTask?: (taskId: string) => Promise<BgTaskSnapshot>,
) {
  let enabled = false;
  let policyPath = dependencies.policyPath;
  let started = false;
  let installed = false;
  let powershellControlled = false;
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
  const feedback = createCommandFeedback(pi);
  const checkingOperations = new Map<CommandOperation, number>();
  let selectedPolicyId: string | undefined;

  function inside(path: string, root: string): boolean {
    const relative = win32.relative(root, path);
    return relative === "" || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
  }
  function pathKey(path: string): string { return win32.normalize(path).toLowerCase(); }

  function fallbackHint(reason: string): string {
    return `[已回退] MXC 不可用：${reason}。已切回普通 pwsh（Native 宿主原生权限）。\n修正后 /mxc retry。`;
  }
  function effectiveMode(): string {
    const state = mode.snapshot();
    return state.phase === "ready" ? "MXC" : state.phase === "checking" ? "checking" : "Native";
  }
  function statusText(): string {
    const state = mode.snapshot();
    const effective = effectiveMode();
    const shell = isMxcShell(selectedCandidate) ? "pwsh" : selectedCandidate?.id ?? "shell";
    const requested = enabled && state.phase === "inactive" ? " (MXC requested, inactive)" : "";
    return `${shell}: ${selectedCandidate ? effective : "unavailable"} | files: ${effective}${state.phase === "fallback" ? " (MXC fallback)" : requested}`;
  }
  function describeMode(): string {
    const state = mode.snapshot();
    const effective = effectiveMode();
    return [
      `请求: ${enabled ? "开启（on）" : "关闭（off）"}，本会话 | state: ${state.phase}`,
      `当前实际: 命令: ${selectedCandidate ? effective : "不可执行"}；文件: ${effective}`,
      ...(effective === "Native" ? ["Native 使用宿主原生权限；会话目录权限当前不约束受控工具。"] : []),
    ].join("\n");
  }
  function describeStatus(): string {
    const state = mode.snapshot();
    return [
      `${statusText()} | requested: ${enabled ? "on" : "off"} | state: ${state.phase}`,
      describeMode(),
      `Shell: ${selectedCandidate ? `${selectedCandidate.id} ${selectedCandidate.version ?? ""} | ${selectedCandidate.path}` : "不可执行，尚无可用 Shell"}`,
      `workspace: ${latestContext?.cwd ?? "尚未建立"}`,
      `profile: ${policyPath ?? dependencies.runtimeOptions?.profilePath ?? "内置最小策略（无额外 profile）"}`,
      `核心路由: bash、bg_run、read / write / edit、用户 ! / !!；文件代理${installed ? "已注册" : "在 MXC 开启时注册，当前沿 Pi Native 路径"}。`,
      `powershell: ${powershellControlled ? "已受管（启用的条件入口）" : (pi.getActiveTools?.() ?? []).includes("powershell") ? "Host，未接管（代理安装后启用的入口）" : "未接管，当前未启用"}`,
      "覆盖边界: 其它编辑器、Lens/LSP、MCP、子代理及 Ego/cu 未接入本 gateway；宿主能力分别授权，不属于统一隔离。",
      ...(state.reason ? [`原因: ${state.reason}`] : []),
    ].join("\n");
  }
  function publish(): void {
    latestContext?.ui?.setStatus?.("pi-tool-gateway", statusText());
    const state = mode.snapshot();
    for (const [operation, generation] of checkingOperations) {
      if (generation === state.generation) continue;
      checkingOperations.delete(operation);
      operation.finish("被较新配置取代", "旧检查结果未提交。");
    }
    if (state.phase !== "fallback" || !state.reason) return;
    const key = `${state.generation}:${state.reason}`;
    if (notices.has(key) || !latestContext?.ui || latestContext.hasUI === false) return;
    feedback.notify(latestContext, fallbackHint(state.reason), "warning");
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

  async function select(candidate: BackendCandidate | undefined, ctx: ExtensionContext, signal?: AbortSignal, operation?: CommandOperation): Promise<MxcModeLease<MxcRuntime>> {
    if (disposed) throw new Error("Operation aborted");
    latestContext = ctx;
    selectedCandidate = candidate;
    const generation = mode.snapshot().generation;
    const requested = enabled;
    const ownPathVersion = pathVersion;
    const paths = sessionPaths.map((entry) => ({ ...entry }));
    const workspace = ctx.cwd ?? process.cwd();
    if (operation) checkingOperations.set(operation, generation);
    try {
      let snapshot: ProfileSnapshot = { profile: { readonlyPaths: [], deniedPaths: [] }, paths };
      if (requested && isMxcShell(candidate)) {
        operation?.stage("正在准备可信 profile 与目录策略");
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
      // The operation adopts its own new generation; only older operations are superseded.
      if (operation) checkingOperations.delete(operation);
      mode.configure(configuration);
      operation?.stage(mode.snapshot().phase === "checking" ? "正在验证 MXC 执行环境" : "正在读取当前执行状态");
      if (operation) checkingOperations.set(operation, mode.snapshot().generation);
      const lease = await mode.resolve(signal);
      selectedPolicyId = lease.mode === "mxc" ? lease.runtime.policyId : undefined;
      publish();
      return lease;
    } finally { if (operation) checkingOperations.delete(operation); }
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
      powershellControlled = true;
    }
    installed = true;
  }

  function differsFromCurrent(task: BgTaskSnapshot, policyId = selectedPolicyId): boolean {
    const identity = task.execution;
    return !identity || identity.mode !== (mode.snapshot().phase === "ready" ? "mxc" : "native") ||
      pathKey(identity.shellPath) !== pathKey(selectedCandidate?.path ?? "") ||
      (identity.mode === "mxc" && identity.policyId !== policyId);
  }
  function oldTaskNotice(policyId = mode.snapshot().phase === "ready" ? selectedPolicyId : undefined): string {
    const tasks = getTasks().filter((task) => task.status === "running" && differsFromCurrent(task, policyId));
    return tasks.map((task) => `${task.execution?.mode === "mxc" ? "旧策略任务" : "旧模式任务"} ${task.id} (${task.execution?.mode === "mxc" ? "MXC" : task.execution?.mode === "native" ? "Native" : "未知"})；/mxc stop ${task.id}`).join("\n");
  }

  async function listPaths(ctx: ExtensionContext, operation: CommandOperation, details = false): Promise<string> {
    const lease = await select(getBackend(ctx), ctx, undefined, operation);
    let fixed: FilesystemProfile = { readonlyPaths: [], deniedPaths: [] };
    let profileError: string | undefined;
    operation.stage("正在读取目录来源与可信 profile");
    try { fixed = await checkedProfile(ctx.cwd); }
    catch (error) { profileError = error instanceof Error ? error.message : String(error); }
    const runtimeOptions = dependencies.runtimeOptions;
    const readonly = [...(runtimeOptions?.readonlyPaths ?? []), ...fixed.readonlyPaths];
    const denied = [...(runtimeOptions?.deniedPaths ?? []), ...fixed.deniedPaths];
    const rows = [
      ...(lease.mode === "native" ? ["以下目录配置尚未生效。"] : []),
      ...(profileError ? [`PROFILE ERROR（该 profile 内容未列出）: ${profileError}`] : []),
      `RW [workspace] ${ctx.cwd}`,
      ...(runtimeOptions?.readwritePaths ?? []).map((path) => `RW [fixed] ${path}`),
      ...readonly.map((path) => `RO [profile/fixed] ${path}`),
      ...denied.map((path) => `DENY [profile/fixed] ${path}`),
      ...sessionPaths.map((entry) => `${entry.access.toUpperCase()} [session${entry.access === "deny" ? " revoked" : ""}] ${entry.path}`),
    ];
    if (lease.mode === "mxc") {
      const known = new Set([...readonly, ...sessionPaths.map((entry) => entry.path)].map(pathKey));
      const resources = lease.runtime.paths.readonlyPaths.filter((path) => !known.has(pathKey(path)));
      if (details) {
        rows.push(...resources.map((path) => `RO [runtime] ${path}`));
        rows.push(`RW [private job only] ${lease.runtime.paths.scratchRoot}\\job-*（每作业独立，非整个控制目录授权）`);
        rows.push(`policyId: ${lease.runtime.policyId}`);
      } else rows.push(`RO [runtime] ${resources.length} 项可信运行资源；RW [private job only] 每作业私有 TEMP。`);
    } else if (details) rows.push("MXC 运行资源尚未建立。");
    rows.push(oldTaskNotice(lease.mode === "mxc" ? lease.runtime.policyId : undefined));
    if (!details) rows.push("/mxc paths --details 查看运行资源。");
    return rows.filter(Boolean).join("\n");
  }

  async function changePaths(args: string, ctx: ExtensionContext, operation: CommandOperation, preview = false): Promise<void> {
    if (disposed || !operation.live()) throw new Error("Session changed before directory command");
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
    operation.stage("正在确认目录与 canonical 路径");
    const existing = sessionPaths.find((entry) => pathKey(entry.path) === pathKey(input));
    const path = await boundedPreparation(async () => {
      if (revoke && existing) return existing.path;
      const canonical = await realpath(input);
      if (!(await stat(canonical)).isDirectory()) throw new Error("Session path must be an existing directory");
      return sessionPaths.find((entry) => pathKey(entry.path) === pathKey(canonical))?.path ?? canonical;
    }, "directory");
    const current = sessionPaths.find((entry) => pathKey(entry.path) === pathKey(path));
    if (revoke && (!current || current.access === "deny")) throw new Error("No active session grant for this directory; /mxc paths shows workspace/profile origins");
    const workspace = await boundedPreparation(() => realpath(ctx.cwd), "workspace");
    if (inside(path, workspace) || inside(workspace, path)) throw new Error("Session roots must be separate from the default RW workspace");
    if (sessionPaths.some((entry) => pathKey(entry.path) !== pathKey(path) && (inside(path, entry.path) || inside(entry.path, path)))) throw new Error("Session permission roots must not overlap; adjust the existing grant first");
    const access = allow ? allow[1].toLowerCase() as "ro" | "rw" : "deny";
    if (preview) {
      operation.stage("等待确认目录变更");
      const accepted = await ctx.ui.confirm("确认会话目录变更", `目录: ${path}\n会话条目: ${current?.access.toUpperCase() ?? "无"} → ${access.toUpperCase()}${requested ? "" : "\n启用 MXC 后生效。"}`);
      if (!operation.live()) throw new Error("Session changed before directory command");
      if (!accepted) { operation.finish("已取消", ""); return; }
    }
    if (!operation.live()) throw new Error("Session changed before directory command");
    const next: SessionPath[] = [...sessionPaths.filter((entry) => pathKey(entry.path) !== pathKey(path)), { path, access }];
    operation.stage("正在验证目录候选策略");
    const fixed = await checkedProfile(ctx.cwd, undefined, next);
    const snapshot: ProfileSnapshot = { profile: fixed, paths: next };
    const configuration = { requested, candidate, workspace: ctx.cwd, revision: JSON.stringify(snapshot) };
    const staged = createMxcModeController<MxcRuntime>({ check: checkConfiguration, checkTimeoutMs: dependencies.checkTimeoutMs });
    stagedChecks.add(staged);
    let checked: MxcRuntime | undefined;
    let retained = false;
    let committed = false;
    let report = "";
    try {
      try {
        staged.configure({ ...configuration, requested: true });
        const lease = await staged.resolve();
        if (lease.mode !== "mxc") throw new Error(lease.reason ?? "MXC candidate is unavailable");
        checked = lease.runtime;
        const freshProfile = await checkedProfile(ctx.cwd, undefined, next);
        if (disposed || !operation.live() || generation !== mode.snapshot().generation || requested !== enabled || ownPathVersion !== pathVersion ||
          JSON.stringify(candidate) !== JSON.stringify(getBackend(ctx)) || JSON.stringify(fixed) !== JSON.stringify(freshProfile)) {
          throw new Error("MXC configuration changed before directory candidate commit");
        }
        operation.stage("候选验证通过，正在提交新会话策略");
        checkingOperations.delete(operation);
        if (requested) { mode.commit(configuration, checked, generation); retained = true; }
        else mode.configure(configuration);
        sessionPaths = next;
        pathVersion++;
        committed = true;
        selectedPolicyId = requested ? checked.policyId : undefined;
        selectedConfigurationKey = JSON.stringify(configuration);
        report = [
          `会话目录 ${access.toUpperCase()}: ${path}${current && current.access !== access ? ` (${current.access.toUpperCase()} → ${access.toUpperCase()})` : ""}`,
          ...(requested ? [] : ["已登记，启用 MXC 后生效。"]),
          oldTaskNotice(),
        ].filter(Boolean).join("\n");
        publish();
      } finally {
        staged.invalidate(); stagedChecks.delete(staged);
        if (checked && !retained) { await checked.dispose(); runtimes.delete(checked); }
      }
    } catch (error) {
      if (committed) {
        const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
        Object.assign(failure, { directoryCommitted: true, directoryReport: report || `会话目录已登记: ${path} (${access.toUpperCase()})` });
        throw failure;
      }
      throw error;
    }
    operation.finish(current?.access === access ? "未发生变更" : "完成", report);
  }

  async function enable(requested: boolean, ctx: ExtensionContext, operation?: CommandOperation): Promise<void> {
    latestContext = ctx;
    const generation = ++preferenceGeneration;
    for (const staged of stagedChecks) staged.invalidate();
    let error: unknown;
    if (requested) {
      operation?.stage("正在准备核心文件工具代理");
      try { await installFiles(ctx); }
      catch (failure) { error = failure; }
    }
    if (disposed || generation !== preferenceGeneration) throw new Error("MXC configuration changed before activation completed");
    if (requested) installationError = error;
    enabled = requested;
    mode.invalidate();
    await select(getBackend(ctx), ctx, undefined, operation);
  }

  function reportMode(operation: CommandOperation, unchanged = false): void {
    const state = mode.snapshot();
    if (state.phase === "fallback" && state.reason) {
      const alreadyShown = notices.has(`${state.generation}:${state.reason}`);
      operation.finish("已回退", fallbackHint(state.reason), "warning", !alreadyShown);
      return;
    }
    const shellHint = selectedCandidate ? "当前 Shell 不适用 MXC" : "没有可用 Shell";
    const reason = enabled && !state.eligible
      ? `${shellHint}；请求已保留。使用 /bash-select pwsh7。`
      : "";
    operation.finish(unchanged ? "未发生变更" : "完成", [reason, oldTaskNotice()].filter(Boolean).join("\n"));
  }

  const commandDescriptions = [
    ["on", "开启 MXC 请求并检查可用性"], ["off", "后续调用改用 Native"],
    ["status", "当前状态、Shell 与工具覆盖"], ["retry", "重新检测已开启的 MXC"],
    ["paths", "目录授权与来源"], ["paths --details", "展开运行资源和私有材料"],
    ["allow", "引导配置会话 RO/RW 目录（需要 pwsh7）"], ["revoke", "撤销会话目录授权"],
    ["tasks", "登记任务、旧权限和退出确认"], ["stop", "精确停止一个登记 taskId"], ["help", "语法、范围与恢复入口"],
  ];
  function helpText(): string {
    return [
      ...commandDescriptions.map(([value, label]) => `/mxc ${value} — ${label}`),
      '/mxc allow ro|rw "D:\\Temp\\project-name" — 已存在的本地绝对目录，仅本会话。',
      '/mxc revoke "D:\\Temp\\project-name" — 撤销该会话目录授权。',
      "/mxc stop <完整 taskId> — 只操作本插件登记的任务，不接受宿主 PID 或缩写。",
      "/bash-select auto|pwsh7|gitbash|powershell51|<absolute-shell-path> — 持久 Shell 选择。",
      "MXC 仅在 Windows 合格 pwsh 下生效；不可用时提示并切回 Native，正常权限拒绝不降级。",
      "会话授权在 reload/换会话/退出后结束；Native 使用宿主权限。MCP/LSP/其它宿主工具未接入统一隔离。",
      "完整参数一次提交；缺参数进入引导；Escape 取消尚未提交的交互。检查提交后等待真实结果/超时。",
    ].join("\n");
  }
  function completions(argumentPrefix: string) {
    const prefix = argumentPrefix.trimStart().toLowerCase();
    let entries = commandDescriptions.map(([value, label]) => ({ value, label: `${value} — ${label}` }));
    if (prefix.startsWith("allow ")) {
      entries = ["ro", "rw"].map((access) => ({ value: `allow ${access}`, label: `allow ${access} — 会话${access === "ro" ? "只读" : "可读写"}目录` }));
      const match = /^allow\s+(ro|rw)\s/.exec(prefix);
      if (match) {
        const paths = [...sessionPaths.map((entry) => entry.path), ...(dependencies.runtimeOptions?.readonlyPaths ?? [])];
        entries = [...new Set(paths)].map((path) => ({ value: `allow ${match[1]} "${path}"`, label: `${match[1].toUpperCase()} — ${path}` }));
      }
    } else if (prefix.startsWith("revoke ")) entries = sessionPaths.filter((entry) => entry.access !== "deny").map((entry) => ({ value: `revoke "${entry.path}"`, label: `撤销 ${entry.access.toUpperCase()} — ${entry.path}` }));
    else if (prefix.startsWith("stop ")) entries = getTasks().map((task) => ({ value: `stop ${task.id}`, label: `${task.id} — ${task.status} ${task.name}` }));
    return entries.filter((entry) => entry.value.toLowerCase().startsWith(prefix));
  }
  function requireUI(ctx: ExtensionContext, syntax: string): void {
    if (ctx.hasUI === false || typeof ctx.ui?.select !== "function") throw new Error(`此操作需要交互 UI；请给出完整参数：${syntax}`);
  }
  async function directoryInput(input: string, ctx: ExtensionContext, operation: CommandOperation): Promise<{ input: string; preview: boolean } | undefined> {
    let access = /^allow\s+(ro|rw)$/i.exec(input)?.[1].toLowerCase();
    if (/^allow$/i.test(input)) {
      requireUI(ctx, "/mxc allow ro|rw <absolute-directory>");
      operation.stage("请选择会话目录权限");
      const values = ["ro — 只读", "rw — 可读写"];
      const selected = await ctx.ui.select("会话目录权限", values);
      if (!operation.live()) return;
      if (!selected) { operation.finish("已取消", ""); return; }
      const index = values.indexOf(selected);
      if (index < 0) throw new Error("Unknown directory permission selection");
      access = index === 0 ? "ro" : "rw";
    }
    if (access) {
      requireUI(ctx, "/mxc allow ro|rw <absolute-directory>");
      operation.stage("请输入已存在的绝对目录");
      const path = await ctx.ui.input("会话目录（现有本地绝对目录）", "D:\\Temp\\project-name");
      if (!operation.live()) return;
      if (path === undefined) { operation.finish("已取消", ""); return; }
      if (!path.trim()) throw new Error("Directory path is required; /mxc allow ro|rw <absolute-directory>");
      return { input: `allow ${access} ${path.trim()}`, preview: true };
    }
    if (/^revoke$/i.test(input)) {
      requireUI(ctx, "/mxc revoke <absolute-directory>");
      const grants = sessionPaths.filter((entry) => entry.access !== "deny");
      if (!grants.length) { operation.finish("未发生变更", "没有可撤销的会话授权。"); return; }
      operation.stage("请选择要撤销的会话授权");
      const choices = grants.map((entry) => ({ text: `${entry.access.toUpperCase()} — ${entry.path}`, entry }));
      const selected = await ctx.ui.select("撤销会话目录授权", choices.map((choice) => choice.text));
      if (!operation.live()) return;
      if (!selected) { operation.finish("已取消", ""); return; }
      const choice = choices.find((value) => value.text === selected);
      if (!choice) throw new Error("Unknown session directory selection");
      return { input: `revoke "${choice.entry.path}"`, preview: true };
    }
    return { input, preview: false };
  }
  function exitConfirmed(task: BgTaskSnapshot): boolean {
    if (task.status === "running" || task.executionError !== undefined) return false;
    if (task.status === "killed") return task.execution?.mode === "mxc";
    return task.exitCode !== null;
  }
  function taskText(task: BgTaskSnapshot): string {
    return `${task.id} [${task.status}] ${task.name}\n启动: ${task.execution?.mode === "mxc" ? "MXC" : task.execution?.mode === "native" ? "Native" : "未知"} | Shell: ${task.execution?.shellPath ?? "未知"} | policyId: ${task.execution?.policyId ?? "-"}\n退出确认: ${exitConfirmed(task) ? "已确认（执行器收尾）" : "未确认"} | 与当前配置: ${mode.snapshot().phase === "checking" ? "检测中，未知" : differsFromCurrent(task) ? "不同" : "一致"}${task.executionError !== undefined ? `\n执行器/清理错误: ${task.executionError || "（无错误文本）"}` : ""}`;
  }
  async function stopRegistered(id: string, operation: CommandOperation): Promise<void> {
    const before = getTasks().find((task) => task.id === id);
    if (!before) throw new Error("未知任务：请使用 /mxc tasks 中显示的完整 taskId；不接受缩写或宿主 PID");
    if (!stopTask) throw new Error("Task stop adapter is unavailable; no task was stopped");
    operation.stage(before.status === "running" ? "正在请求取消并等待执行器确认退出" : "正在读取已结束的任务记录");
    const after = before.status === "running" ? await stopTask(id) : before;
    const confirmed = exitConfirmed(after);
    let launchMode = "未知";
    if (after.execution?.mode === "mxc") launchMode = "MXC";
    else if (after.execution?.mode === "native") launchMode = "Native";
    const body = [
      `${after.id} [${after.status}] ${launchMode}${confirmed ? " · 退出已确认" : ""}${before.status === "running" ? "" : "；未重复取消"}`,
      ...(after.executionError !== undefined ? [`执行器/清理错误: ${after.executionError || "（无错误文本）"}`] : []),
      ...(!confirmed ? ["/mxc tasks 查看记录。"] : []),
    ].join("\n");
    operation.finish(confirmed ? "完成" : "退出尚未确认", body, confirmed ? "info" : "warning");
  }
  async function showTasks(ctx: ExtensionContext, operation: CommandOperation, pick = false): Promise<void> {
    const tasks = getTasks();
    const visible = tasks.filter((task) => task.status === "running" || !exitConfirmed(task));
    const body = visible.length
      ? `登记任务: ${tasks.length}；运行中或退出未确认: ${visible.length}\n${visible.map(taskText).join("\n")}\n/mxc stop <完整 taskId> 停止任务。`
      : "没有运行中或退出未确认的任务。";
    if (!visible.length || (!pick && ctx.mode !== "tui") || ctx.hasUI === false || typeof ctx.ui?.select !== "function") { operation.finish("完成", body); return; }
    ctx.ui.notify(`[任务列表]\n${body}`, "info");
    operation.stage("请选择待停止任务");
    const choices = visible.map((task) => ({ text: `${task.id} [${task.status}] ${task.name}`, task }));
    const selected = await ctx.ui.select("选择待停止任务", choices.map((choice) => choice.text));
    if (!operation.live()) return;
    if (!selected) { operation.finish(pick ? "已取消" : "完成", ""); return; }
    const choice = choices.find((value) => value.text === selected);
    if (!choice) throw new Error("Unknown registered task selection");
    const accepted = await ctx.ui.confirm("停止登记任务？", taskText(choice.task));
    if (!operation.live()) return;
    if (!accepted) { operation.finish("已取消", choice.task.id); return; }
    await stopRegistered(choice.task.id, operation);
  }

  pi.registerFlag("mxc", { type: "boolean", default: false, description: "Use optional Windows pwsh/MXC execution (unavailable => native hint/fallback)" });
  pi.registerFlag("mxc-policy", { type: "string", description: "Absolute trusted path to a version=1 MXC filesystem profile" });
  pi.registerCommand("mxc", {
    description: "MXC 操作：on/off/status/retry、目录授权、任务和帮助；无参数打开菜单",
    getArgumentCompletions: completions,
    async handler(args, ctx) {
      if (disposed) throw new Error("Operation aborted");
      let input = args.trim();
      const operation = feedback.start(ctx, `MXC ${input.split(/\s/)[0] || "菜单"}`, "正在解析操作");
      try {
        if (!input) {
          requireUI(ctx, "/mxc status|help 或完整操作参数");
          const choices = commandDescriptions.filter(([value]) => value !== (enabled ? "on" : "off"));
          operation.stage("请选择操作");
          const selected = await ctx.ui.select(`MXC — 请求 ${enabled ? "on" : "off"}\nworkspace: ${ctx.cwd}`, choices.map(([value, label]) => `${value} — ${label}`));
          if (!operation.live()) return;
          if (!selected) { operation.finish("已取消", ""); return; }
          const choice = choices.find(([value, label]) => `${value} — ${label}` === selected);
          if (!choice) throw new Error("Unknown MXC operation selection");
          input = choice[0];
          operation.rename(`MXC ${input}`);
        }
        const argument = input.toLowerCase();
        if (argument === "help") { operation.finish("完成", helpText()); return; }
        if (argument === "paths" || argument === "paths --details") {
          const body = await listPaths(ctx, operation, argument.endsWith("--details"));
          operation.finish("完成", body); return;
        }
        if (/^(allow|revoke)(?:\s|$)/i.test(input)) {
          const prepared = await directoryInput(input, ctx, operation);
          if (!prepared || !operation.live()) return;
          input = prepared.input;
          operation.stage("目录操作已排队，等待前一项完成");
          const ownSession = sessionVersion;
          const pending = pathTail.then(async () => {
            if (disposed || ownSession !== sessionVersion || !operation.live()) throw new Error("Session changed before directory command");
            checkingOperations.set(operation, mode.snapshot().generation);
            try { return await changePaths(input, ctx, operation, prepared.preview); }
            finally { checkingOperations.delete(operation); }
          });
          pathTail = pending.catch(() => undefined);
          await pending; return;
        }
        if (argument === "tasks" || argument === "stop") {
          if (argument === "stop") requireUI(ctx, "/mxc stop <完整 taskId>");
          await showTasks(ctx, operation, argument === "stop"); return;
        }
        if (/^stop\s+/i.test(input)) { await stopRegistered(input.slice(5).trim(), operation); return; }
        if (argument === "on" || argument === "off") {
          const before = { requested: enabled, configuration: selectedConfigurationKey, phase: mode.snapshot().phase };
          await enable(argument === "on", ctx, operation);
          const unchanged = before.requested === enabled && before.configuration === selectedConfigurationKey && before.phase === mode.snapshot().phase;
          reportMode(operation, unchanged); return;
        }
        if (argument === "retry") {
          if (!enabled) { operation.finish("未发生变更", "MXC 未开启；使用 /mxc on。"); return; }
          mode.invalidate(); await select(getBackend(ctx), ctx, undefined, operation); reportMode(operation); return;
        }
        if (argument !== "status") throw new Error("未知 MXC 参数；/mxc help 查看语法，不会猜测或执行其它操作");
        await select(getBackend(ctx), ctx, undefined, operation);
        operation.finish("完成", `${describeStatus()}\n${oldTaskNotice()}\n下一步：/mxc paths 查看目录，/mxc tasks 查看任务。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const replaced = /(?:configuration|session).*changed/i.test(message);
        const committed = error instanceof Error && "directoryCommitted" in error && error.directoryCommitted === true;
        const previousReport = error instanceof Error && "directoryReport" in error && typeof error.directoryReport === "string" ? `${error.directoryReport}\n` : "";
        const scope = committed ? "目录变更已提交；收尾失败不表示旧配置保留，也不会自动重放。" : /^(allow|revoke)(?:\s|$)/i.test(input) ? "未提交目录候选；原会话目录配置保留。" : "本次失败操作不自动重放；请查询当前状态。";
        const next = /^allow(?:\s|$)/i.test(input) && !committed ? "/mxc allow ro|rw <absolute-directory>" : /^stop(?:\s|$)/i.test(input) ? "/mxc tasks" : "/mxc paths 或 /mxc help";
        operation.finish(committed ? "已登记，收尾失败" : replaced ? "被较新配置取代" : "拒绝", `${previousReport}原因: ${message}\n${scope}\n下一步：${next}`, "error");
        if (ctx.hasUI === false) throw error;
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    feedback.reset();
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
    feedback.reset();
    for (const staged of stagedChecks) staged.invalidate();
    mode.configure({ requested: false, workspace: "", revision: "shutdown" });
    await pathTail;
    await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
    await fileTail;
    latestContext?.ui?.setStatus?.("pi-tool-gateway", undefined);
  }
  return { execution, refresh: (ctx: ExtensionContext, operation?: CommandOperation) => select(getBackend(ctx), ctx, undefined, operation), snapshot: mode.snapshot, describeStatus, describeMode, feedback, oldTaskNotice, dispose };
}
