# Distill bundled app defaults

`distro/` contains generic resources and defaults that ship with the single Distill app build. It is not a customer/org profile system.

## Supported files

- `distro.json` — minimal bundled manifest for app-level defaults that still need to be available before runtime config owns them
- `skills/` — bundled skills seeded into the user's global skills directory
- `agents/` — bundled agents seeded into the user's global agents directory

## Discovery

The Tauri app resolves bundled defaults in this order:

1. `DISTILL_DISTRO_DIR`, if set
2. bundled Tauri resource dir at `resource_dir()/distro`

In development, `just dev-windows` (`scripts/windows/Dev-Windows.ps1`) exports `DISTILL_DISTRO_DIR` to this repository's `distro/` directory when it exists.

## Manifest shape

`distro.json` is optional. It carries generic app-level defaults only:

- `appVersion?: string` — optional app version tag supplied by bundled defaults
- `distribution?: { npmRegistryUrl, nodeDistBaseUrl }` — where the managed Node runtime and ACP bridges are downloaded from

## Runtime effects

When bundled defaults are present, the Tauri shell:

- installs Distill-owned `distro/skills/<name>/` entries into the platform app-data `skills/<name>/` directory; Personal skills remain in `~/.agents/skills`
- installs `distro/agents/<name>.md` entries into `~/.agents/agents/<name>.md`
- resolves bundled `agent-avatar:` images from `distro/agents/.avatars/`

Bundled skills reinstall existing copies only when the installed `SKILL.md` frontmatter has the `metadata.distillBundled: true` marker; unmarked Personal skills are left untouched.

Bundled agents use the `metadata.distillBundled: true` marker. The app records seeded files in `.distill-bundled-agents.json` so deleted starter agents do not reappear on later launches. Existing unmarked user agents are left untouched.

## Scope guidance

Use bundled app defaults for generic packaged-app resources and shell-level startup defaults only.

Good fits:

- bundled skills
- bundled agents
- temporary generic app defaults that cannot yet move to runtime config

Do not use bundled app defaults for policy, provider allowlists, runtime feature toggles, normal app state, user preferences, or ACP-backed data.

Personal skills, agent definitions, prompts and delivery hooks are managed in the
user's own configuration directories. Keep them outside the shared repository and
do not add app UI tied to a particular user's skill. Generic built-in skills and
starter agents remain part of the app distribution.
