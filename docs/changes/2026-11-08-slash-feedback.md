# 2026-11-08: Slash feedback and global application

## Scope and source

The user requested completion of the slash-interaction work, then asked for concise feedback after trying it in Pi TUI. This delivery synchronizes that implementation into the independent public repository and applies it to the machine's global gateway package declaration. The public Git remote is updated; npm publication is outside this operation.

The imported runtime is the original development line at `581725d` (implementation commits `f98c0ca` and `0609a09`). Its 13 runtime Git blobs are verified against the public checkout. Source history, machine-specific operational documents, crash dumps and raw local evidence are not imported. Public package metadata, license/notice and portable development-peer discovery are preserved.

## Interaction and feedback

- `/mxc` offers a menu; help and completions expose the supported operations. Partial commands use selection/input/confirmation; complete commands execute directly.
- A per-operation widget reports real phases and elapsed wait time. Session/configuration replacement invalidates stale feedback and prevents an old Shell dialog from committing over a newer choice.
- Final TUI receipts use Pi custom entries. Consecutive receipts remain separate without entering model context or triggering a model turn. RPC retains notifications and basic dialogs.
- Routine receipts report the result and necessary changes, not a repeated mode summary or generic scope advice. Status, path details and task identity remain available on demand.
- `/mxc stop` is wired to the task registry and requires an exact registered ID. Cancellation/cleanup errors remain visible and cannot be promoted to confirmed exit. Existing running tasks with older permissions are reported when they actually exist.

The renderer imports `@earendil-works/pi-tui`, now declared as a host-supplied peer. Lockfile package versions, resolution URLs and integrity values remain unchanged. A stale RPC assertion is updated to recognize the shortened directory-validation phase; its filesystem and process-exit assertions are retained.

## Validation and local scope

[Validation](../validation/slash-feedback.md) separates the checks run for this public synchronization from historical real-MXC verification. A reported host Windows watchdog crash remains unattributed; no new MXC execution or crash reproduction is performed here.

The authorized global change replaces only the active gateway package source with this public checkout. The former package remains disabled, other settings and the saved Shell preference are preserved, and existing windows are not automatically reloaded. The original development worktrees and their remote are left intact.
