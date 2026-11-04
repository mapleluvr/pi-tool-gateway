import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, join, win32 } from "node:path";

export type BackendId =
  | "auto"
  | "gitbash"
  | "pwsh7"
  | "powershell51"
  | "custom";

export type BackendKind = "bash" | "powershell";

export interface BackendCandidate {
  id: Exclude<BackendId, "auto">;
  kind: BackendKind;
  label: string;
  path: string;
  args: string[];
  commandTransport: "argv" | "stdin";
  version?: string;
}

export interface BackendSelection {
  backend: BackendId;
  shellPath?: string;
}

export interface BackendDiscoveryOptions {
  findOnPath?: (executable: string) => string[];
  probeVersion?: (shellPath: string, args: string[]) => string | undefined;
  programFiles?: string;
  programFilesX86?: string;
}

export const AUTO_BACKEND_ORDER = [
  "pwsh7",
  "gitbash",
  "powershell51",
] as const;

const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];
const POWERSHELL_VERSION_COMMAND = "$PSVersionTable.PSVersion.ToString()";


function getBashConfig(shellPath: string): {
  args: string[];
  commandTransport: "argv" | "stdin";
} {
  const normalized = shellPath.replaceAll("/", "\\").toLowerCase();
  const legacyWsl = /^([a-z]:)?\\windows\\(?:system32|sysnative)\\bash\\.exe$/.test(
    normalized,
  );
  return legacyWsl
    ? { args: ["-s"], commandTransport: "stdin" }
    : { args: ["-c"], commandTransport: "argv" };
}

function normalizedPath(value: string): string {
  return value.replaceAll("/", "\\").replaceAll("\\\\", "\\").toLowerCase();
}


export function isForbiddenShellPath(shellPath: string): boolean {
  const normalized = normalizedPath(shellPath);
  const name = basename(shellPath.replaceAll("\\", "/")).toLowerCase();
  return (
    name === "cmd.exe" ||
    normalized.endsWith("\\windows\\system32\\cmd.exe") ||
    normalized.endsWith("\\windows\\sysnative\\cmd.exe")
  );
}

function isAbsoluteShellPath(shellPath: string): boolean {
  return isAbsolute(shellPath) || win32.isAbsolute(shellPath);
}

function pathIdentity(shellPath: string): string {
  return normalizedPath(appExecutionAliasTarget(shellPath) ?? shellPath);
}

/**
 * Microsoft Store / MSIX installs (for example PowerShell 7 installed from the
 * Store) expose their executable only as an App Execution Alias: a reparse
 * point whose target lives under the ACL-restricted
 * `C:\Program Files\WindowsApps`. `existsSync`/`statSync` on such an alias fail
 * with EACCES from a non-packaged process even though the alias is executable,
 * so the reparse target has to be inspected directly.
 */
function appExecutionAliasTarget(shellPath: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    if (!lstatSync(shellPath).isSymbolicLink()) return undefined;
    const target = readlinkSync(shellPath);
    return target.length > 0 ? target : undefined;
  } catch {
    return undefined;
  }
}

export function isShellFile(shellPath: string): boolean {
  if (existsSync(shellPath)) {
    try {
      if (!statSync(shellPath).isFile()) return false;
      if (process.platform === "win32") return true;
      accessSync(shellPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const aliasTarget = appExecutionAliasTarget(shellPath);
  if (aliasTarget === undefined) return false;
  // A dangling alias is not a usable backend; callers still require a real
  // version probe before trusting the candidate.
  return existsSync(aliasTarget) && isShellFile(aliasTarget);
}

function executableName(shellPath: string): string {
  return basename(shellPath.replaceAll("\\", "/")).toLowerCase();
}

function firstLine(value: string): string | undefined {
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim();
  return line || undefined;
}

function probeVersion(shellPath: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(shellPath, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return undefined;
    return firstLine(result.stdout ?? "");
  } catch {
    return undefined;
  }
}

function versionMajor(version: string | undefined): number | undefined {
  const match = version?.match(/(?:^|\s)(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : undefined;
}

function findOnPath(executable: string): string[] {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = spawnSync(locator, [executable], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return [];
    return (result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line, index, all) => line.length > 0 && all.indexOf(line) === index)
      .filter(isShellFile);
  } catch {
    return [];
  }
}

function gitBashCandidate(
  id: "gitbash" | "custom",
  shellPath: string,
  probe: typeof probeVersion = probeVersion,
): BackendCandidate {
  const config = getBashConfig(shellPath);

  const version = probe(shellPath, ["--version"]);
  return {
    id,
    kind: "bash",
    label: version ? `Git Bash (${version})` : "Git Bash (version unknown)",
    path: shellPath,
    args: [...config.args],
    commandTransport: config.commandTransport ?? "argv",
    version,
  };
}

function powerShellCandidate(
  id: "pwsh7" | "powershell51" | "custom",
  shellPath: string,
  probe: typeof probeVersion = probeVersion,
): BackendCandidate {
  const version = probe(shellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    POWERSHELL_VERSION_COMMAND,
  ]);
  const major = versionMajor(version);
  const name =
    id === "pwsh7" ||
    (id === "custom" &&
      (executableName(shellPath) === "pwsh" ||
        executableName(shellPath) === "pwsh.exe" ||
        major !== undefined && major >= 7))
      ? "PowerShell 7"
      : "PowerShell 5.1";
  return {
    id,
    kind: "powershell",
    label: version ? `${name} (${version})` : `${name} (version unknown)`,
    path: shellPath,
    args: [...POWERSHELL_ARGS],
    commandTransport: "argv",
    version,
  };
}

function addUnique(
  candidates: BackendCandidate[],
  seen: Set<string>,
  candidateValue: BackendCandidate,
): void {
  if (!isAbsoluteShellPath(candidateValue.path) || !isShellFile(candidateValue.path)) return;
  // App Execution Aliases belonging to one packaged app are distinct symlinks
  // pointing at the same target, so identity is the reparse target when there
  // is one: a single install yields a single candidate.
  const key = pathIdentity(candidateValue.path);
  if (seen.has(key) || isForbiddenShellPath(candidateValue.path)) return;
  seen.add(key);
  candidates.push(candidateValue);
}

function isUsableResolvedCandidate(
  candidate: BackendCandidate,
  expectedId: Exclude<BackendId, "auto" | "custom">,
): boolean {
  if (
    candidate.id !== expectedId ||
    !isAbsoluteShellPath(candidate.path) ||
    !isShellFile(candidate.path) ||
    isForbiddenShellPath(candidate.path) ||
    !Array.isArray(candidate.args) ||
    !["argv", "stdin"].includes(candidate.commandTransport)
  ) {
    return false;
  }
  return expectedId === "gitbash"
    ? candidate.kind === "bash"
    : candidate.kind === "powershell";
}

export function discoverBackends(
  options: BackendDiscoveryOptions = {},
): BackendCandidate[] {
  const locate = options.findOnPath ?? findOnPath;
  const probe = options.probeVersion ?? probeVersion;
  const candidates: BackendCandidate[] = [];
  const seen = new Set<string>();

  const powerShell7Paths = locate("pwsh.exe");
  for (const shellPath of powerShell7Paths) {
    const version = probe(shellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      POWERSHELL_VERSION_COMMAND,
    ]);
    if (versionMajor(version) !== undefined && versionMajor(version)! >= 7) {
      addUnique(candidates, seen, powerShellCandidate("pwsh7", shellPath, probe));
    }
  }

  const programFiles = options.programFiles ?? process.env.ProgramFiles;
  const programFilesX86 = options.programFilesX86 ?? process.env["ProgramFiles(x86)"];
  const gitPaths = [
    programFiles ? join(programFiles, "Git", "bin", "bash.exe") : undefined,
    programFilesX86
      ? join(programFilesX86, "Git", "bin", "bash.exe")
      : undefined,
    programFiles ? join(programFiles, "Git", "usr", "bin", "bash.exe") : undefined,
  ].filter((value): value is string => Boolean(value));
  gitPaths.push(...locate("bash.exe"));
  for (const shellPath of gitPaths.filter(isShellFile)) {
    try {
      const candidate = gitBashCandidate("gitbash", shellPath, probe);
      if (candidate.version && /\bGNU bash\b/i.test(candidate.version)) {
        addUnique(candidates, seen, candidate);
      }
    } catch {
      // A stale or malformed PATH entry is not a fatal discovery error.
    }
  }

  const powerShell51Paths = locate("powershell.exe");
  for (const shellPath of powerShell51Paths) {
    const candidate = powerShellCandidate("powershell51", shellPath, probe);
    if (versionMajor(candidate.version) === 5) {
      addUnique(candidates, seen, candidate);
    }
  }

  // PATH probing above is self-contained so loading this extension does not
  // require optional packages imported by the SDK root module.
  return candidates;
}

export function createCustomCandidate(shellPath: string): BackendCandidate {
  if (!isAbsoluteShellPath(shellPath)) {
    throw new Error(`Custom shell path must be absolute: ${shellPath}`);
  }
  if (isForbiddenShellPath(shellPath)) {
    throw new Error(`cmd.exe is not an allowed shell backend: ${shellPath}`);
  }
  if (!isShellFile(shellPath)) {
    throw new Error(`Custom shell path does not exist or is not executable: ${shellPath}`);
  }

  let candidate: BackendCandidate;
  switch (executableName(shellPath)) {
    case "bash":
    case "bash.exe":
      candidate = gitBashCandidate("custom", shellPath);
      if (!candidate.version || !/\bGNU bash\b/i.test(candidate.version)) {
        throw new Error(`Custom shell is not Bash: ${shellPath}`);
      }
      break;
    case "pwsh":
    case "pwsh.exe":
    case "powershell":
    case "powershell.exe":
      candidate = powerShellCandidate("custom", shellPath);
      if (!candidate.version || versionMajor(candidate.version) === undefined) {
        throw new Error(`Custom shell is not PowerShell: ${shellPath}`);
      }
      break;
    default:
      throw new Error(
        `Custom shell must be a Bash or PowerShell executable: ${shellPath}`,
      );
  }
  return candidate;
}

export function resolveBackend(
  selection: BackendId | BackendSelection,
  candidates: BackendCandidate[],
): BackendCandidate {
  const backend = typeof selection === "string" ? selection : selection.backend;
  if (backend === "custom") {
    const shellPath = typeof selection === "string" ? undefined : selection.shellPath;
    if (!shellPath) throw new Error("Custom backend requires shellPath");
    return createCustomCandidate(shellPath);
  }

  if (backend === "auto") {
    for (const id of AUTO_BACKEND_ORDER) {
      const candidate = candidates.find(
        (value) =>
          value.id === id &&
          isUsableResolvedCandidate(value, id),
      );
      if (candidate) return candidate;
    }
    throw new Error(
      "No shell backend available. Tried: PowerShell 7, Git Bash, PowerShell 5.1. " +
        "Install one of these backends or select a valid custom path; cmd.exe is not a fallback.",
    );
  }

  const candidate = candidates.find(
    (value) => value.id === backend && isUsableResolvedCandidate(value, backend),
  );
  if (candidate) return candidate;
  const names: Record<Exclude<BackendId, "auto" | "custom">, string> = {
    pwsh7: "PowerShell 7",
    gitbash: "Git Bash",
    powershell51: "PowerShell 5.1",
  };
  throw new Error(
    `${names[backend]} is not available. Discovered: ${
      candidates.map((value) => value.label).join(", ") || "none"
    }. cmd.exe is not a fallback.`,
  );
}

export function formatBackend(candidate: BackendCandidate): string {
  return `${candidate.label} — ${candidate.path}`;
}
