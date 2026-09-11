# Berd bundled app defaults

`distro/` contains generic resources and defaults that ship with the single Berd app build. It is not a customer/org profile system.

## Supported files

- `distro.json` — minimal bundled manifest for app-level defaults that still need to be available before runtime config owns them
- `bin/` — optional executables or helper scripts prepended to `PATH` for the harness bridges
- `skills/` — bundled skills seeded into the user's global skills directory
- `agents/` — bundled agents seeded into the user's global agents directory

## Discovery

The Tauri app resolves bundled defaults in this order:

1. `DISTILL_DISTRO_DIR`, if set
2. bundled Tauri resource dir at `resource_dir()/distro`

In development, `just dev` exports `DISTILL_DISTRO_DIR` to this repository's `distro/` directory when it exists.

## Manifest shape

`distro.json` is optional. It carries generic app-level defaults only:

- `appVersion?: string` — optional app version tag supplied by bundled defaults
- `distribution?: { npmRegistryUrl, nodeDistBaseUrl }` — where the managed Node runtime and ACP bridges are downloaded from
- `telemetry?: { channel }` — which telemetry channel a packaged build reports to

## Runtime effects

When bundled defaults are present, the Tauri shell:

- prepends `distro/bin` to `PATH` when present
- sets `DISTILL_DISTRO_DIR` to the resolved distro root
- installs Berd-owned `distro/skills/<name>/` entries into the platform app-data `skills/<name>/` directory; Personal skills remain in `~/.agents/skills`
- installs `distro/agents/<name>.md` entries into `~/.agents/agents/<name>.md`
- warms installed bundled agent `app-avatar:` media when network access is available

Bundled skills reinstall existing copies only when the installed `SKILL.md` frontmatter has the `metadata.berdBundled: true` marker; unmarked Personal skills are left untouched.

Bundled agents use the `metadata.berdBundled: true` marker. The app records seeded files in `.berd-bundled-agents.json` so deleted starter agents do not reappear on later launches. Existing unmarked user agents are left untouched.

## Scope guidance

Use bundled app defaults for generic packaged-app resources and shell-level startup defaults only.

Good fits:

- bundled skills
- bundled agents
- bundled `bin/`
- temporary generic app defaults that cannot yet move to runtime config

Do not use bundled app defaults for policy, provider allowlists, runtime feature toggles, normal app state, user preferences, or ACP-backed data.
