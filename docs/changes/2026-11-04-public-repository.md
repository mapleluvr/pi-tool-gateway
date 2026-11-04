# 2026-11-04: Independent public repository

## Approved scope

The user approved `pi-tool-gateway` as a public GitHub repository with this description:

> MXC-backed sandboxing and session-scoped filesystem access control for Pi's shell and file tools on Windows.

The user requested a README shaped like a current-state document: it directly describes the product, behavior, conditions and boundaries. Repository creation and pushing after preparation were authorized. npm publication and production installation changes were not part of this delivery.

## Source and publication boundary

The source checkpoint is `01fccac996619dca642e19e4b88ce1df540de7fa` from the gateway development branch. That checkpoint is also the source used by the existing production installation at publication time. A separate worktree contains unfinished slash-interaction changes; those changes are outside this snapshot.

The public repository starts with an independent source snapshot. It contains the runtime, tests and locked manifests, plus public-facing documentation. It does not copy the local development history, production settings, credential material, raw investigation output or private runtime caches. The existing production package path and the original repository's remotes remain unchanged.

Shell and background-task lineage is acknowledged in `NOTICE`; the package's existing MIT declaration is accompanied by a complete license file. Pi/TypeBox remain host-provided peers, and the MXC SDK remains an optional pinned dependency.

## Preparation changes

- Write README as the current public product state, with Native fallback and execution-domain boundaries visible in the use path.
- Add GitHub package metadata, license and provenance. npm payload includes runtime source, README, license/notice and public validation summaries.
- Resolve the two real Pi smoke tests through the installed development peer's `getPackageDir()`, replacing author-specific installation paths. This affects test discovery only; runtime source is unchanged.
- Replace local operational documentation with this public maintenance map and a bounded validation summary. Product behavior is unchanged by the publication.

## Validation and publication

Actual commands, results and remaining verification boundaries are recorded in [publication validation](../validation/publication.md). The remote repository and pushed commit are checked after upload. A public repository is not an npm release, and a successful upload is not an isolation acceptance test.
