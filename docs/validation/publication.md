# Public snapshot validation

Date: 2026-11-04. Scope: initial `pi-tool-gateway` public repository, based on source checkpoint `01fccac996619dca642e19e4b88ce1df540de7fa`.

## Verification layers

| Layer | Evidence and boundary |
| --- | --- |
| Runtime preservation | The 12 committed Git blobs for `index.ts` and `src/` match the source checkpoint byte-for-byte. Windows checkout line endings are handled by Git clean filters. Publication changes documentation, metadata and two smoke tests' package discovery. |
| Dependency installation | `npm ci --ignore-scripts --no-audit --fund=false` completed from the lockfile. No lifecycle scripts were executed. |
| Type checking | `npm run typecheck` passed with the pinned TypeScript 5.9.3 development dependency. |
| Runtime/permission regression | `npm test`: 172 passed, 0 failed, 0 skipped, about 145.4 seconds. Real Windows MXC, the installed Pi 1.4.0 development peer and isolated fixtures were used. |
| Package boundary | `npm pack --dry-run --ignore-scripts --json` passed. The 19-file payload contains runtime code, package metadata, README, license/notice and linked public documentation; tests and local evidence are excluded. This does not publish an npm package. |
| Public-content boundary | The initial staged tree is checked for unexpected files, sensitive filenames, credential-like literals, author-machine installation paths, broken local Markdown links and runtime differences. This is a bounded scan, not a proof that arbitrary secrets are impossible. |
| GitHub delivery | Repository visibility, description and the remote `main` commit are checked after push. |

## Repeatable checks

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts --json
```

The two real Pi smoke tests resolve their package via the installed development peer's `getPackageDir()`. Their loader/CLI paths do not rely on a global Pi installation. Real-MXC tests require a capable Windows host and PowerShell 7; platform skips or control-flow substitutes do not establish isolation.

Raw local test output and test-runtime material remain under ignored `docs/.temp/`. They are not shipped in Git or the npm payload. No real model, browser/desktop automation, production credential or production-settings change is involved.

## Compatibility and acceptance limits

- The pinned full-regression development peer is Pi 1.4.0 with TypeBox 1.3.27 and MXC SDK 1.0.1. Windows ProcessContainer behavior is measured on the executing host, not asserted for every Windows build.
- A separate local Pi 1.5.0 investigation compared the installed 1.4/1.5 argument validators and checked the gateway's fixed schemas and native file factories. It found no immediate fixed-schema rejection regression. That parameter-only investigation is not a full Pi 1.5 business/lifecycle acceptance run.
- Actual Windows TUI observation previously covered mode/fallback notices, directory commands and cancellation/PID recovery for user `!`. Model-driven tool TUI Escape and arbitrary subprocess/forced-termination cases retain their own validation boundary; loader/RPC success is not equivalent to screen/key verification.
- A successful layout audit is runtime-cached. A trusted host can later change filesystem aliases; `/mxc retry` establishes a new runtime and audit. Core tool containment does not isolate the host Pi process or other extensions.
- Native fallback restores host filesystem privileges. A sandbox availability failure is not a continuing RO/deny enforcement mode.

## Publication results

The executing host used Windows build 26200, Node.js 24.18.0 and PowerShell 7.6.9. All 172 tests passed with no skips, including both real Pi loader/CLI smoke paths after package-discovery changes. No runtime implementation change was needed.

The staged initial snapshot contains 49 files. The bounded content scan reported no findings; repository and packaged Markdown links resolved, all 12 runtime source blobs matched the checkpoint, and the npm payload contained 19 expected files. Active LSP checks of the two changed tests, package manifest and five public Markdown documents reported no errors.

Preparation is complete. GitHub delivery is verified separately against the pushed `main` ref; npm release and production activation are separate operations.
