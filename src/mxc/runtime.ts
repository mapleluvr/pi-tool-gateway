import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BackendCandidate } from "../backends.ts";
import { killProcessTree, spawnArguments, type BackendExecutor } from "../operations.ts";

import { MxcRuntimeUnavailable } from "./errors.ts";
import { collectProtectedFileIds } from "./hardlinks.ts";
export { MxcRuntimeUnavailable } from "./errors.ts";
export interface MxcRuntimeOptions {
  candidate: BackendCandidate;
  workspace: string;
  piPackageRoot: string;
  readonlyPaths?: string[];
  readwritePaths?: string[];
  deniedPaths?: string[];
  profilePath?: string;
  cliPath?: string;
  scratchRoot?: string;
}
export interface MxcFileOptions {
  signal?: AbortSignal;
  model?: { id?: string; name?: string; input?: string[]; inputLimits?: unknown };
}
interface CliOptions {
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

function inside(path: string, root: string): boolean {
  const relative = win32.relative(root, path);
  return relative === "" || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
}
async function canonicalPath(input: string): Promise<string> {
  if (!win32.isAbsolute(input)) throw new MxcRuntimeUnavailable("MXC resource paths must be absolute");
  let path = win32.normalize(input);
  const suffix: string[] = [];
  for (;;) {
    try { return win32.join(await realpath(path), ...suffix); }
    catch (error) {
      const parent = win32.dirname(path);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
      suffix.unshift(win32.basename(path));
      path = parent;
    }
  }
}
async function executablePath(path: string): Promise<string> {
  // MSIX App Execution Aliases can fail realpath/stat despite a readable target.
  try { return await realpath(path); }
  catch (error) {
    if ((await lstat(path)).isSymbolicLink()) {
      const target = await readlink(path);
      return await realpath(target);
    }
    throw error;
  }
}
function quoteWindows(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}
function defaultCli(): string {
  const require = createRequire(import.meta.url);
  const metadata = require.resolve("@microsoft/mxc-sdk/package.json");
  return join(dirname(metadata), "bin", process.arch, "wxc-exec.exe");
}

export async function createMxcRuntime(options: MxcRuntimeOptions) {
  if (process.platform !== "win32") throw new MxcRuntimeUnavailable("MXC mode requires Windows ProcessContainer");
  const workspace = await realpath(options.workspace);
  const writablePaths = [...new Map((await Promise.all([workspace, ...(options.readwritePaths ?? [])].map(canonicalPath))).map((path) => [path.toLowerCase(), path])).values()];
  const shellPath = await executablePath(options.candidate.path);
  const cliPath = await executablePath(options.cliPath ?? defaultCli());
  const nodePath = await executablePath(process.execPath);
  const piPackageRoot = await realpath(options.piPackageRoot);
  const sourceRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const pluginRoot = dirname(sourceRoot);
  const scratchRoot = await canonicalPath(options.scratchRoot ?? join(tmpdir(), "pi-tool-gateway", "mxc"));
  const readonlyPaths = [...new Set(await Promise.all([
    dirname(nodePath), dirname(shellPath), sourceRoot,
    dirname(dirname(piPackageRoot)), ...(options.readonlyPaths ?? []),
  ].map(canonicalPath)))];
  const deniedPaths = [...new Set(await Promise.all((options.deniedPaths ?? []).map(canonicalPath)))];
  // Namespace overlap and shared file identities both threaten trusted inputs.
  const protectedPaths = [...new Set(await Promise.all([
    ...readonlyPaths, dirname(cliPath), join(pluginRoot, "node_modules"),
    join(pluginRoot, "index.ts"), join(pluginRoot, "package.json"),
    ...(options.profilePath ? [options.profilePath] : []),
  ].map(canonicalPath)))];
  for (const protectedPath of protectedPaths) {
    if (writablePaths.some((root) => inside(protectedPath, root) || inside(root, protectedPath))) {
      throw new MxcRuntimeUnavailable(`Trusted runtime/reference is inside the RW workspace or contains it: ${protectedPath}`);
    }
    if (inside(scratchRoot, protectedPath)) {
      throw new MxcRuntimeUnavailable(`Private control storage is inside a readonly/protected reference: ${protectedPath}`);
    }
  }
  if (writablePaths.some((root) => inside(scratchRoot, root) || inside(root, scratchRoot))) throw new MxcRuntimeUnavailable("MXC control materials must be separate from every RW root");
  for (const denied of deniedPaths) {
    if (writablePaths.some((root) => inside(denied, root) || inside(root, denied))) {
      throw new MxcRuntimeUnavailable(`Denied path overlaps a renameable RW workspace: ${denied}`);
    }
  }
  const rootKey = Object.keys(process.env).find((key) => key.toLowerCase() === "systemroot");
  const systemRoot = rootKey ? process.env[rootKey]! : "C:\\Windows";
  const candidate: BackendCandidate = { ...options.candidate, path: shellPath, args: [...options.candidate.args] };
  const policyId = createHash("sha256").update(JSON.stringify({ workspace, shellPath, nodePath, piPackageRoot, writablePaths, readonlyPaths, deniedPaths })).digest("hex").slice(0, 16);
  const controllers = new Set<AbortController>();
  const active = new Set<Promise<unknown>>();
  let disposed = false;
  let layoutCheck: Promise<void> | undefined;

  async function privateEnvironment(dir: string): Promise<NodeJS.ProcessEnv> {
    const home = join(dir, "home");
    const temp = join(dir, "tmp");
    const local = join(home, "AppData", "Local");
    const roaming = join(home, "AppData", "Roaming");
    for (const path of [home, temp, local, roaming]) await mkdir(path, { recursive: true });
    return {
      SYSTEMROOT: systemRoot, WINDIR: systemRoot, USERPROFILE: home, HOME: home,
      LOCALAPPDATA: local, APPDATA: roaming, TEMP: temp, TMP: temp,
      PATH: [dirname(shellPath), dirname(nodePath), join(systemRoot, "System32")].join(";"),
      PI_CODING_AGENT_DIR: join(home, "pi-agent"), PI_SKIP_VERSION_CHECK: "1", PYTHONUNBUFFERED: "1",
    };
  }

  async function withJob<T>(signal: AbortSignal | undefined, run: (dir: string, env: NodeJS.ProcessEnv, ownSignal: AbortSignal) => Promise<T>): Promise<T> {
    if (disposed || signal?.aborted) throw new Error("Operation aborted");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    controllers.add(controller);
    const promise = (async () => {
      let dir: string | undefined;
      let executionError: unknown;
      try {
        await mkdir(scratchRoot, { recursive: true });
        dir = await mkdtemp(join(scratchRoot, "job-"));
        const env = await privateEnvironment(dir);
        if (signal?.aborted || disposed) controller.abort();
        return await run(dir, env, controller.signal);
      } catch (error) {
        executionError = error;
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        controllers.delete(controller);
        if (dir) {
          try { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
          catch (error) {
            const message = `MXC private-material cleanup failed; execution effects may already exist, this call was not replayed. ${error instanceof Error ? error.message : String(error)}`;
            if (executionError instanceof Error) {
              executionError.message += `\n${message}`;
              throw executionError;
            }
            const cleanupError = new Error(message, { cause: error }) as NodeJS.ErrnoException;
            cleanupError.code = (error as NodeJS.ErrnoException)?.code;
            throw cleanupError;
          }
        }
      }
    })();
    active.add(promise);
    try { return await promise; }
    finally { active.delete(promise); }
  }

  function runCli(args: string[], env: NodeJS.ProcessEnv, cliOptions: CliOptions): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      if (cliOptions.signal?.aborted) { resolve({ exitCode: null }); return; }
      let child: ChildProcess;
      let settled = false;
      const cleanup = () => cliOptions.signal?.removeEventListener("abort", onAbort);
      const onAbort = () => killProcessTree(child);
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; cleanup();
        reject(new MxcRuntimeUnavailable(`MXC launcher failed; this call was not replayed: ${error instanceof Error ? error.message : String(error)}`));
      };
      try {
        child = spawn(cliPath, args, { cwd: workspace, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) { fail(error); return; }
      child.stdout?.on("data", cliOptions.onStdout ?? (() => undefined));
      child.stderr?.on("data", cliOptions.onStderr ?? (() => undefined));
      child.once("error", fail);
      child.once("close", (code) => {
        if (settled) return;
        settled = true; cleanup();
        resolve({ exitCode: cliOptions.signal?.aborted ? null : code });
      });
      cliOptions.signal?.addEventListener("abort", onAbort, { once: true });
      if (cliOptions.signal?.aborted) onAbort();
    });
  }

  function config(argv: string[], cwd: string, dir: string, env: NodeJS.ProcessEnv, timeout = 0) {
    const readwritePaths = [...writablePaths, dir];
    const parents = new Set<string>();
    for (const path of [...readonlyPaths, ...readwritePaths]) {
      for (let parent = dirname(path);; parent = dirname(parent)) {
        parents.add(parent);
        if (dirname(parent) === parent) break;
      }
    }
    return {
      version: "1.0.0", containerId: `PiToolGateway-${randomUUID()}`,
      lifecycle: { destroyOnExit: true, preservePolicy: false },
      process: { commandLine: argv.map(quoteWindows).join(" "), cwd, timeout,
        env: Object.entries(env).map(([key, value]) => `${key}=${value}`), inheritDefaultEnv: false },
      containment: "processcontainer",
      filesystem: { readonlyPaths, readwritePaths, deniedPaths },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      ui: { disable: false, clipboard: "none", injection: false },
      processContainer: { capabilities: [],
        filesystem: { enumeratePaths: [...parents] },
        ui: { isolation: "container", desktopSystemControl: false, systemSettings: "none", ime: false } },
      telemetry: { enabled: false },
    };
  }

  async function launch(argv: string[], cwd: string, dir: string, env: NodeJS.ProcessEnv, cliOptions: CliOptions, dryRun = false) {
    const path = join(dir, "policy.json");
    await writeFile(path, JSON.stringify(config(argv, cwd, dir, env)), "utf8");
    return runCli(["--config", path, ...(dryRun ? ["--dry-run"] : [])], env, cliOptions);
  }

  function createExecutor(): BackendExecutor {
    return {
      candidate,
      async exec(command, cwd, execOptions) {
        await ensureSafeLayout(execOptions.signal);
        const invocation = spawnArguments(candidate, command);
        if (invocation.stdin !== undefined) throw new Error("MXC pwsh requires argv command transport");
        return withJob(execOptions.signal, (dir, env, signal) => launch(
          [shellPath, ...invocation.args], cwd, dir, env,
          { signal, onStdout: execOptions.onData, onStderr: execOptions.onData },
        ));
      },
    };
  }

  async function invokeWorker(input: Record<string, unknown>, dir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<AgentToolResult<unknown>> {
    const request = join(dir, "request.json");
    await writeFile(request, JSON.stringify(input), "utf8");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outcome = await launch([nodePath, join(sourceRoot, "mxc", "file-worker.mjs"), request], workspace, dir, env, {
      signal, onStdout: (data) => stdout.push(data), onStderr: (data) => stderr.push(data),
    });
    if (signal.aborted) throw new Error("Operation aborted");
    let response: any;
    try { response = JSON.parse(Buffer.concat(stdout).toString("utf8")); }
    catch {
      throw new MxcRuntimeUnavailable(`MXC worker response unavailable; effects may be partial, no replay. ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`);
    }
    if (!response.ok) {
      if (response.kind === "runtime") throw new MxcRuntimeUnavailable(response.error.message);
      const error = new Error(response.error.message) as NodeJS.ErrnoException;
      error.code = response.error.code;
      throw error;
    }
    if (outcome.exitCode !== 0 || !response.result?.content) throw new MxcRuntimeUnavailable("Invalid MXC worker completion; call not replayed");
    return { ...response.result, details: response.result.details };
  }

  async function ensureSafeLayout(signal?: AbortSignal): Promise<void> {
    if (disposed || signal?.aborted) throw new Error("Operation aborted");
    layoutCheck ??= withJob(signal, async (dir, env, ownSignal) => {
      try {
        const protectedFileIds = await collectProtectedFileIds([...protectedPaths, ...deniedPaths], writablePaths, canonicalPath, ownSignal, scratchRoot);
        if (protectedFileIds.length) {
          await invokeWorker({ audit: { protectedFileIds, writablePaths }, cwd: workspace }, dir, env, ownSignal);
        }
      } catch (error) {
        if (ownSignal.aborted) throw new Error("Operation aborted");
        if (error instanceof MxcRuntimeUnavailable) throw error;
        throw new MxcRuntimeUnavailable(`MXC protected-resource audit unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch((error) => {
      layoutCheck = undefined;
      throw error;
    });
    await layoutCheck;
  }

  async function executeFile(tool: "read" | "write" | "edit", params: Record<string, unknown>, fileOptions: MxcFileOptions = {}): Promise<AgentToolResult<unknown>> {
    await ensureSafeLayout(fileOptions.signal);
    return withJob(fileOptions.signal, (dir, env, signal) => invokeWorker(
      { tool, params, cwd: workspace, piPackageRoot, model: fileOptions.model }, dir, env, signal,
    ));
  }

  async function check(signal?: AbortSignal): Promise<void> {
    await withJob(signal, async (dir, env, ownSignal) => {
      let output = "";
      const probe = await runCli(["--probe"], env, { signal: ownSignal, onStdout: (data) => { output += data.toString("utf8"); } });
      let facts: { tier?: unknown; needsDaclAugmentation?: unknown; probes?: Record<string, unknown> } | null;
      try { facts = JSON.parse(output); }
      catch { throw new MxcRuntimeUnavailable("MXC detector returned malformed JSON"); }
      if (!facts || probe.exitCode !== 0 || facts.tier !== "base-container" || facts.needsDaclAugmentation !== false ||
        facts.probes?.baseContainerSupportsEnumeratePaths !== true || facts.probes?.baseContainerSupportsDenyPaths !== true || facts.probes?.nativeCaptureAvailable !== true) {
        throw new MxcRuntimeUnavailable("MXC requires native base-container, explicit deny/enumeration and capture without host ACL preparation");
      }
      const invocation = spawnArguments(candidate, "$PSVersionTable.PSVersion.ToString()");
      const argv = [shellPath, ...invocation.args];
      const valid = await launch(argv, workspace, dir, env, { signal: ownSignal }, true);
      if (valid.exitCode !== 0) throw new MxcRuntimeUnavailable("MXC full policy validation failed");
      let version = "";
      const smoke = await launch(argv, workspace, dir, env, { signal: ownSignal, onStdout: (data) => { version += data.toString("utf8"); } });
      if (smoke.exitCode !== 0 || !/^7\./m.test(version)) throw new MxcRuntimeUnavailable("MXC top-level pwsh self-check failed");
    });
    const read = await executeFile("read", { path: join(piPackageRoot, "package.json"), limit: 4 }, { signal });
    if (!read.content.some((block) => block.type === "text" && block.text.includes("@earendil-works/pi-coding-agent"))) {
      throw new MxcRuntimeUnavailable("MXC complete Pi file-worker self-check failed");
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...active]);
  }

  const paths = { readwritePaths: writablePaths, readonlyPaths, deniedPaths, scratchRoot };
  return { policyId, workspace, cliPath, candidate, paths, check, createExecutor, executeFile, dispose };
}
export type MxcRuntime = Awaited<ReturnType<typeof createMxcRuntime>>;
