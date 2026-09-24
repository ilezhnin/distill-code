# Distill data storage

The configured Distill root holds app-owned documents. It is resolved from
`DISTILL_ROOT`, then the `root-path` pointer in the OS config directory, then
`~/.distill`. Changing it in Settings takes effect after restart and does not move
existing files.

Personal prompt organization and delivery are user configuration, outside the
shared application's data model. The app does not prescribe a personal document
collection, create its templates, or inject it into chat prompts. Existing custom
files remain untouched.

The built-in memory, project wiki, workspace instructions and bundled skills and
agents remain application features. Repository `AGENTS.md` files supply workspace
conventions; the target project's configured instructions apply to its chats.

The `distro/` catalog supplies generic built-in skills and starter agents.
Personal definitions and delivery hooks stay in the user's own configuration.

Conductor graph and wave documents use the configured root on desktop. Their
legacy browser copies are removed only after successful migration; browser
previews retain their localStorage fallback.
