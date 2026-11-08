# Slash feedback synchronization validation

Date: 2026-11-08. Scope: synchronization from development checkpoint `581725d` into the independent public repository, followed by global package-source application and a normal push to public `main`.

## Measured checks

| Layer | Result and boundary |
| --- | --- |
| Regression before import | Three new command-feedback cases failed against the public snapshot because completion/no-change receipts were absent. They passed after the verified runtime was imported. |
| Source preservation | All **13 runtime Git blobs** for `index.ts` and `src/` match the development checkpoint after Git line-ending normalization. No new executor, MXC policy or containment implementation was introduced by this synchronization. |
| Feedback regression | **74 passed, 0 failed, 0 skipped**: gateway, slash contract/feedback/interaction/tasks/lifecycle/preparation and real Pi TUI components. |
| Native regression | **68 passed, 0 failed, 0 skipped**: backend discovery, background registry, Shell selection, extension, real native Shell integration, operations, process identity, naming/state compatibility. |
| Locked Pi 1.4 | Actual loader, AgentSession, custom-entry events and TUI components retain 4 separate receipts with 0 remaining widgets and unchanged model messages. Widths 24/64/120 and dark/light component rendering pass; ordinary off receipt text is one line. |
| Installed Pi 1.5 | Before and after global source application, a credential-free agent fixture reads a **global package declaration** through SettingsManager and DefaultResourceLoader, without a CLI extension override. It loads this checkout and retains 4 receipts/4 components, 0 widgets and unchanged model messages. |
| TypeScript | `npm run typecheck` passed, including the imported tests. |
| Active LSP | 29 changed code/test files probed at error severity: 26 confirmed clean, 3 unconfirmed because the push-only server does not acknowledge a clean recheck. No remaining diagnostic errors were returned; one auxiliary JSON-parse finding was independently checked and marked false-positive because the mode controller already catches the async check rejection. This is not a full lint-clean claim. |
| Dependencies | `@earendil-works/pi-tui` is a host-provided peer. Offline, scripts-disabled lockfile refresh changes only that declaration and dependency classification; all package versions, resolved URLs and integrity values are unchanged. The public checkout uses its own dependency directory. |

The selected suites total **142 passed, 0 failed, 0 skipped**. They are not the full real-MXC suite. The shortened RPC phase assertion was corrected, but real-MXC RPC was not rerun.

## Safety and coverage limits

- A host Windows `0x133 DPC_WATCHDOG_VIOLATION` report remains unattributed. Neither MXC nor MSIX deployment has been established as its cause. This synchronization is not a crash fix.
- No new MXC execution, crash reproduction, driver/service change, model request, browser action or desktop automation was performed. Tests used independent fixtures and Native execution or controlled external runners.
- The real component probes reject an invalid profile before creating an MXC runtime. A test-process guard blocks the gateway's MXC CLI launch entry and is carried into Node children with replacement environments; the recorded regression and package-loader runs made no blocked launch attempts. This guard is local verification tooling, not production containment.
- The development line's earlier 224/224 regression included real MXC and host-side observations. That historical evidence retains its original scope and does not supersede this incident or verify a fresh real-MXC run from the public checkout.
- Component rendering does not establish production-screen, keyboard or arbitrary-theme acceptance. No new independent reviewer was launched; this delivery uses direct review and the stated automated checks.

## Global application

The machine's global `packages` entry resolves to the public checkout. Exactly one active gateway source remains; the legacy provider stays disabled. A before/expected-after text hash confirms that only the authorized source value changed. The saved Shell preference is unchanged.

The source from that declaration is replayed in an independent agent fixture for the Pi 1.5 package/loader check. Other production extensions and credentials are not loaded into the fixture. Existing Pi windows are not automatically reloaded; a new session or explicit user reload adopts the configured source.

## Packaging and remote delivery

`npm pack --dry-run --ignore-scripts --json` passed with **22 files**. The 63-file public tree and the npm payload passed the bounded artifact/path/credential-shape scan; repository and packaged Markdown links resolve. `git diff --check` passed. These checks do not prove that arbitrary secrets are impossible.

The payload excludes tests, local configuration, raw evidence, dependency directories and crash artifacts. Remote delivery uses a normal `main` push and is checked against the advertised remote SHA after upload; no npm package or release tag is published.

Raw command output, hashes, guard tooling and the local global-package fixture remain under ignored `docs/.temp/global-publish-2026-11-08/`. Machine paths and crash-analysis artifacts are not copied into the public Git history.
