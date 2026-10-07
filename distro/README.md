# Distill application help

`distro/` contains generic application resources and help. Operator roles,
avatars, working skills, profiles and internal plans are private local data and
must never be included here or in Git history.

## Public resources

- `skills/distill-help/` documents the application and its commands.
- `skills/distill-monitor/` documents the monitoring CLI.
- An optional `distro.json` may supply `appVersion` and generic download locations
  under `distribution: { npmRegistryUrl, nodeDistBaseUrl }`.

No ready-made operator role catalog or personal workflow skills are shipped.
The application retains support for discovering locally installed roles and skills.

## Discovery and installation

The Tauri app resolves resources from `DISTILL_DISTRO_DIR` when set, otherwise
from `resource_dir()/distro`. The Windows development launcher points the override
at this directory.

Application help is installed into `~/.distill/skills/`. An existing skill is
updated only when its frontmatter has `metadata.distillBundled: true`; unmarked
personal skills remain untouched. Removing a packaged source does not delete
installed local copies. Existing agents and avatars stay in `~/.distill/agents/`.

Keep account data, credentials, session history, preferences, personal prompts,
roles, working skills, evaluation tasks and development plans outside the source
checkout. See [the repository publication rules](../AGENTS.md).
