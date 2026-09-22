# Model, effort and fast mode

A chat runs on four selections:

1. **Provider** — the harness (`claude-acp`, `codex-acp`, `grok-acp`, …).
2. **Model** — the bridge's own base id (`opus[1m]`, `gpt-5.6-sol`,
   `grok-4.6`). A model id names a model and nothing else.
3. **Reasoning effort** — the harness's own value id for that model
   (`xhigh`, `default`, `ultra`). There is no app-wide effort ladder.
4. **Fast mode** — on or off, for a model that has it.

Each is chosen on its own, stored on its own, and applied in a fixed order.
Distill used to fold the effort into the model id (`gpt-5.6-sol[low]`); that
shape survives only as legacy input that is read, never written (see
[Legacy folded ids](#legacy-folded-ids)).

## Where each selection lives

### Agent host (Rust, `src-tauri/src/services/agent_host/`)

- **Sessions table.** `sessions.harness` and `sessions.model_id` hold provider
  and model; `reasoning_effort` (TEXT) and `fast_mode` (INTEGER 0/1) were added
  by `migrations_agent_host/20260914000000_session_selection.sql`, together
  with `legacy_model_id`, the pre-split original of a folded id. NULL means
  nobody chose. The host persists what the **bridge acknowledged**, not what
  was asked, and also updates the columns when a bridge changes an option on
  its own (`config_option_update`).
- **Inventory.** `providers/supported_models/list` rows carry `group`
  (`main`/`more`), `order`, `aliasOf`, `efforts`, `defaultEffort`,
  `supportsFast`, `opensOnModel` and `capabilitySource`
  (`probed`/`declared`/`unknown`), with a `schemaVersion` and a `revision` on
  the answer. Bridge rows are probed (kv scope `harness_models_v2`) and the
  record remembers which harness executable listed them (`probedOn`: path,
  size, mtime); a list is probed again when the executable that answers for
  the harness — the running bridge's, or the one on disk — is another file,
  so a CLI updated in place serves its new models without a reinstall.
  Claude's extra models are declared in `harness.rs` because each needs its
  own bridge session to read.
- **Session answers.** `session/new`, `session/load`, `session/fork` and
  session info carry `_meta.modelId`, `_meta.reasoningEffort` and
  `_meta.fastMode`.

### Renderer (`src/`)

- **Target: `ChatSession.executionTarget`** — provider and model identity only
  (`sessionExecutionTarget.ts`).
- **Intent: `ChatSession.desiredRunSettings`** — `{ effort?, fast? }`
  (`sessionRunSettings.ts`). What the operator (or an agent, a ranking, a wave
  step, distillctl) asked for. It survives model switches.
- **Observed menus: `ChatSession.reasoningEffort` / `ChatSession.fastMode`** —
  the live options for the **current** model, as the bridge last reported
  them. Cleared on a model change; intent is not.
- **`ChatSession.runSettingsNotice`** — shown when the current model cannot
  honour the intent.
- **Preferences** — `distill:preferredModelsByAgent` (localStorage) keeps
  `reasoningEffort`, `fastMode` and a per-model `byModel` map beside the
  model, because effort menus differ per model on every harness.
- **Queued messages** — `payload.runSettings` records the values in force when
  the message was queued. Dispatch still reads the chat's intent at send time;
  the record is not an instruction (open question in
  `LAWS/PROPOSAL-2026-09-model-effort.md`).

### Agents, rankings, waves, distillctl

- **Personas** — frontmatter `effort` and `fast_mode` beside `model`.
- **Model rankings** — each entry stores a base `modelId` plus `effort` and
  `fastMode` (ranking version unchanged). A ranking's effort the chosen model
  does not offer still runs the model, with a notice (`effortApplied: false`).
- **Wave steps** — `effort` and `fast` fields next to `model` and `class`. A
  step naming an effort or fast mode its model does not offer refuses the
  whole plan. Run journals, telemetry and the conductor graph record `effort`
  and `fast` beside the model; old records stay as written.
- **distillctl** (protocolVersion 6) — `session create --effort/--fast-mode`,
  `agent create --effort/--fast-mode`; `info models` lists `efforts`,
  `default_effort`, `supports_fast` and `group`; `session get`, `session list`
  and `session fork` report `effort` and `fast_mode`. Refusals are
  `effort_not_available` (naming what is offered) and `fast_not_supported`.

## Apply order: mode → model → effort → fast

Every path that puts a session on a selection applies it in this order:
`session/new` (including a fork), attach, reopen on another model, and the
renderer's model apply (`acpSessionRegistry` runs model, effort and fast in one
serialized mutation). Order matters because an effort or fast option belongs
to a model: the options a bridge answers the model write with are the only
truthful menu for the next step.

Each step is skipped when the previous answer does not advertise that option
or list that value, and nothing in the sequence fails an attach: a refused
value becomes a substitution (below) and the stored intent stays, so the next
model that offers it gets it back.

Distill re-applies effort and fast after **every** model change instead of
trusting the bridge to keep them, because the three bridges disagree: Claude
loses the effort after a session passes through Haiku (it reports `default`),
codex clamps to the new model's default effort, and grok keeps an effort per
model. Acknowledgement comes from the write's response — the Claude and codex
bridges send no `config_option_update` for a client's own write, grok does —
so the reconciler (`runSettingsReconciler.ts`) is idempotent against the
duplicate.

## Why effort and fast are a sibling record, not target fields

`SessionRunSettings` sits next to `SessionExecutionTarget`, never inside it:

- `withExecutionTarget` in the session store returns the same session object
  when identity, model name and source are unchanged, so an effort-only change
  written onto the target would be silently discarded.
- `normalizeSessionExecutionTarget` rebuilds the target field by field and
  `materializeSessionExecutionModel` spreads it through, so any added field is
  one call site away from being dropped.
- The target means identity. An effort click is not a target change, so it
  cannot supersede a queued send or reset session state.

## Why the host does not rename bridge option ids

The host classifies an option by role (model, effort, fast) to route and
persist writes, and forwards the bridge's own id and value shape verbatim.
The renderer already finds effort by the `thought_level` category (Claude's
`effort`, codex's and grok's `reasoning_effort`) and fast by id `fast` /
`fast-mode` or an on/off `model_config` option. Canonical ids would need a
per-harness mapping table, and a gap in it makes a control disappear rather
than degrade. It would also switch Ultracode on for codex, which stays
Claude-only because it is gated on the `effort` config id.

## `_meta.substitutions`

Every presented snapshot the host returns — from `session/new`,
`session/load`, `session/set_config_option` and a reopen — carries a record of
what a bridge would not take:

```json
"_meta": { "substitutions": [
  { "role": "effort", "requested": "xhigh", "applied": "high", "reason": "not offered by claude-opus-4-6" }
] }
```

An entry is written when a read-back value differs from the request or an
option the host meant to apply was absent. It is the only machine-readable
record of a downgrade, and it feeds `runSettingsNotice`.

A `model` entry on the `session/new` answer means the bridge would not run the
model the chat was asked to open on — typically a remembered preference the
harness has since retired, or one its API would not confirm. The session
exists all the same, on the harness's own model, and `acpCreateSession`
reports it as `rejectedModel` instead of asking the bridge a second time or
archiving the session. The caller (`rejectedCreationModel.ts`) then puts the
chat's target on the model the host named, drops the stored preference that
failed, and says so in a toast — the same words a switch that left its model
behind uses. A draft whose creation fails for any other reason stays a draft
with no host session, so the picker never writes to it over the wire: choosing
another agent or model records the choice on the draft and hands it back to
the app shell to be created again (`draftSessionRetry.ts`).

## Per-model asymmetries

The live inventory is authoritative; this is what the harnesses offered when
the split was built.

- **Haiku** has neither an effort control nor fast mode; the effort pill is
  hidden.
- **Opus 4.6 and Sonnet 4.6** have no `xhigh`.
- **Fast mode on Claude** exists only on `default`, `opus[1m]`, Opus 4.8 and
  Opus 4.7 — not on Fable 5 / 5.1, Sonnet 5, Haiku, Opus 4.6 or Sonnet 4.6.
- **Fast mode on codex** exists on every model except GPT-5.3-Codex-Spark.
  codex offers `ultra` on some models (not all), and Luna tops out at `max`.
- **grok** has a real `reasoning_effort` option (four stops) and no fast mode
  at all; distillctl answers `fast_not_supported`. grok accepts an effort a model
  does not advertise, so Distill validates against the advertised menu.
- **Claude's extra models** (Fable 5.1, Opus 4.8, 4.7, 4.6, Sonnet 4.6) open a
  bridge session on the model and are then asserted with
  `set_config_option model=<id>`; without the assert the session describes
  the alias's options. Switching to one mid-turn is refused, so those rows are
  disabled while a turn runs.
- `[1m]` is a context lane, not an effort: `opus[1m]`, `claude-fable-5[1m]`
  and `claude-fable-5-1[1m]` are whole ids and are never split.

## Legacy folded ids

Folded ids are still read, never written:

- `src/shared/lib/foldedModelId.ts` — the renderer's only reader
  (`splitLegacyFoldedModelId`, `baseModelId`, `sameModelIdentity`). It has no
  compose function on purpose.
- `split_effort_model` in `router.rs` — the host's inbound path inside
  `apply_model`, for a folded id from an old renderer, an old distillctl client or
  a stored value the lazy split skipped.
- The host's lazy per-session split (kv flag `migrations/selection_split`):
  on first load, a stored `model_id` whose suffix the harness advertises as an
  effort becomes base id plus `reasoning_effort`, with the original kept in
  `legacy_model_id`.
- `resolveRequestedModelSelection` in `src/features/distillctl/commands/runtime/providers.ts`
  — serves both `session create` and `agent create`: an exact listed id wins,
  otherwise a folded id is split and answered with a `deprecated` note.
- Preferences, persona files, ranking entries, wave plans, journals,
  telemetry, the facts ledger, the usage ledger and queued messages all read a
  folded id tolerantly and are never rewritten on read.

**Sunset condition, not a date.** All of these readers — including both
callers of `resolveRequestedModelSelection` — may be removed once **no
`sessions.legacy_model_id` rows remain and no pre-protocolVersion-6 distillctl
clients are in use**. Removing them earlier breaks operator history, imported
personas and external agents.

Source rules keep folding from coming back:
`src/shared/lib/__tests__/modelSelectionSourceRules.test.ts` and the
`source_rules` module in `router.rs` fail on a composed `base[effort]` id or a
retired folded-effort identifier, and
`src/features/chat/lib/__tests__/sessionExecutionTargetProvenance.test.ts`
pins which modules mint a target or name a chat's run-settings intent.

## Warning: do not reopen codex through `availableModels`

codex's `options.settings.availableModels` looks like a cheaper alternative to
Claude's reopen-on-model seam. It is not. Inside such a session an alias the
list does not contain is fuzzy-resolved to a sibling model without an error —
a silent model substitution happening below Distill, where no notice can
report it. Keep codex on its own model option.
