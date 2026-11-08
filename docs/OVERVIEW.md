# Pi Tool Gateway

Windows execution gateway for Pi shell/file tools with optional MXC sandboxing and session-scoped filesystem grants.

## Documentation map

- [Current product state](../README.md): execution domains, tools, permissions, installation, lifecycle and recovery. README is the public state document; it describes implemented behavior rather than an implementation roadmap.
- [Publication record](changes/2026-11-04-public-repository.md): source lineage and the decisions behind the independent public repository.
- [Slash feedback synchronization](changes/2026-11-08-slash-feedback.md): menus, progress, persistent concise receipts and global package application.
- [Latest validation](validation/slash-feedback.md): public-checkout regression, package/global loader checks and the unverified real-MXC/stability boundary.
- [Initial publication validation](validation/publication.md): the original snapshot's measured results and limits.
- `docs/.temp/`: ignored execution plans and raw local evidence.

## Current work

The public source includes the completed slash-interaction flow and concise TUI receipts. README is the current behavior contract. Global activation and remote delivery are documented with their verification boundary in the latest validation record.

A reported Windows watchdog crash remains unattributed. Further crash analysis and real-MXC reproduction are separate work; this update does not claim a stability fix. Production-screen acceptance remains a user-run check.
