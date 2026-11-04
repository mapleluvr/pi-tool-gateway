# Pi Tool Gateway

`README.md` describes the current public behavior and boundaries. `docs/OVERVIEW.md` is the maintenance entry. Changes and their rationale live under `docs/changes/`, durable validation summaries under `docs/validation/`, and scratch plans/raw output under the ignored `docs/.temp/`.

- Follow the current contract and the user's explicit scope. Keep unimplemented interaction plans distinct from existing runtime behavior.
- Use test-first changes for production code. A control-flow test does not prove isolation: MXC access, output, exit and cleanup claims require the real executor plus host-side observations.
- Preserve native shell/background semantics. Effective MXC mode requires Windows and PowerShell 7. CMD is not a backend.
- Availability-check failures produce a visible native fallback. Normal permission denials retain MXC. Do not replay an already-executed or uncertain operation on the host.
- Pi and unhandled extensions/MCP/LSP/subagents belong to their own execution domains. Core tool interception does not isolate the whole Pi process.
- A protected file identity shared with an RW domain makes MXC unavailable. Preserve RO/deny entries and the distinction between protected-domain aliases and ordinary RW-only hardlinks.
- Report cleanup errors and residual state, retaining the original execution error and any known side effects.
- Tests use independent, credential-free fixtures; do not change production package settings, request a real model, or automate browsers/desktops without task-specific authorization.
- Use the locked development peer for loader/CLI tests. Do not add author-specific installation paths or raw local runtime evidence to the repository.
- Run `npm run typecheck`, the affected tests and `npm pack --dry-run` for publication changes. Report unsupported, skipped, failed or unverified paths explicitly.
- Review or scanner failures/timeouts are not acceptance. Launch subagents only when the user authorizes delegation.
