//! The external agent harnesses the host knows how to drive. Each one is an
//! ACP agent speaking JSON-RPC over stdio; the host spawns it on demand and
//! multiplexes every session for that harness over the one process.

use serde_json::{json, Value};

const CLAUDE_HARNESS: &str = "claude-acp";

/// Where a model sits in the picker: the list it opens on, or the "more
/// models" page behind it. Presentation only — a model its bridge advertises
/// is always listed, whichever group it lands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelGroup {
    Main,
    More,
}

impl ModelGroup {
    fn as_str(self) -> &'static str {
        match self {
            ModelGroup::Main => "main",
            ModelGroup::More => "more",
        }
    }
}

/// A model Distill declares for a harness: where it belongs in the menu and,
/// for one the probe cannot reach, what it offers. A model the bridge lists
/// is declared only to place and name it; its effort levels and fast support
/// are probed.
#[derive(Debug, Clone, Copy)]
pub struct ModelDecl {
    pub id: &'static str,
    /// `None` keeps the bridge's own name.
    pub name: Option<&'static str>,
    /// Leads with the model's name, which is what the renderer labels by.
    pub description: Option<&'static str>,
    pub group: ModelGroup,
    pub order: u16,
    /// The model this row is another name for. An alias is hidden while its
    /// twin is listed, and survives when it is the selection.
    pub alias_of: Option<&'static str>,
    /// The harness runs this model only in a session opened on it
    /// (`session_model_meta`), so its bridge never lists it.
    pub opens_on_model: bool,
    /// Effort values, for a model the probe cannot select. `None` where they
    /// are probed.
    pub efforts: Option<&'static [&'static str]>,
    pub supports_fast: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
pub struct HarnessSpec {
    /// Stable id used by the frontend (`providerId` / `harnessId`).
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Executable name resolved on the extended PATH (managed shims first).
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// Environment variables stripped before spawning.
    pub env_remove: &'static [&'static str],
    /// Distill agent mode → the bridge's ACP session mode id.
    pub modes: &'static [(&'static str, &'static str)],
    /// What Distill knows about this harness's models beyond the probe.
    pub models: &'static [ModelDecl],
    /// `_meta` for `session/new` / `session/load` that opens a session on a
    /// given model, for harnesses with `opens_on_model` rows.
    pub session_model_meta: Option<fn(&str) -> Value>,
}

/// claude-agent-acp hands `_meta.claudeCode.options` to the Claude Agent SDK.
fn claude_session_model_meta(model_id: &str) -> Value {
    json!({ "claudeCode": { "options": { "model": model_id } } })
}

/// The effort values claude-agent-acp builds for the models Distill opens a
/// session on. They are declared because reading them takes a bridge session
/// per model: the bridge offers exactly one of these models at a time.
const CLAUDE_EFFORTS: &[&str] = &["default", "low", "medium", "high", "xhigh", "max"];
/// The 4.6-class models have no `xhigh`; asking for it lands on `default`.
const CLAUDE_EFFORTS_NO_XHIGH: &[&str] = &["default", "low", "medium", "high", "max"];

pub const HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude-acp",
        label: "Claude Code",
        description:
            "Claude Code through the claude-agent-acp bridge, billed to your Claude subscription.",
        command: "claude-agent-acp",
        args: &[],
        // Prevent nested-session detection inside the wrapped Claude Code.
        env_remove: &["CLAUDECODE"],
        modes: &[
            ("auto", "bypassPermissions"),
            ("approve", "default"),
            ("smartApprove", "acceptEdits"),
            ("chat", "plan"),
        ],
        // Claude Code's own model menu. The bridge lists five aliases
        // (default, opus[1m], claude-fable-5[1m], sonnet, haiku); the other
        // five it refuses in `session/set_config_option` but runs in a
        // session opened on them through `options.model`, which is what
        // `opens_on_model` means — and why their effort levels and fast
        // support are declared here rather than probed.
        models: &[
            ModelDecl {
                id: "claude-fable-5-1[1m]",
                name: Some("Fable 5.1"),
                description: Some("Fable 5.1 with 1M context"),
                group: ModelGroup::Main,
                order: 10,
                alias_of: None,
                opens_on_model: true,
                efforts: Some(CLAUDE_EFFORTS),
                supports_fast: Some(false),
            },
            ModelDecl {
                id: "opus[1m]",
                name: Some("Opus 5"),
                description: None,
                group: ModelGroup::Main,
                order: 20,
                alias_of: None,
                opens_on_model: false,
                efforts: None,
                supports_fast: None,
            },
            ModelDecl {
                id: "default",
                name: None,
                description: None,
                group: ModelGroup::Main,
                order: 20,
                alias_of: Some("opus[1m]"),
                opens_on_model: false,
                efforts: None,
                supports_fast: None,
            },
            ModelDecl {
                id: "sonnet",
                name: Some("Sonnet 5"),
                description: None,
                group: ModelGroup::Main,
                order: 30,
                alias_of: None,
                opens_on_model: false,
                efforts: None,
                supports_fast: None,
            },
            ModelDecl {
                id: "haiku",
                name: Some("Haiku 4.5"),
                description: None,
                group: ModelGroup::Main,
                order: 40,
                alias_of: None,
                opens_on_model: false,
                efforts: None,
                supports_fast: None,
            },
            ModelDecl {
                id: "claude-fable-5[1m]",
                name: Some("Fable 5"),
                description: None,
                group: ModelGroup::More,
                order: 50,
                alias_of: None,
                opens_on_model: false,
                efforts: None,
                supports_fast: None,
            },
            ModelDecl {
                id: "claude-opus-4-8",
                name: Some("Opus 4.8"),
                description: Some("Opus 4.8"),
                group: ModelGroup::More,
                order: 60,
                alias_of: None,
                opens_on_model: true,
                efforts: Some(CLAUDE_EFFORTS),
                supports_fast: Some(true),
            },
            ModelDecl {
                id: "claude-opus-4-7",
                name: Some("Opus 4.7"),
                description: Some("Opus 4.7"),
                group: ModelGroup::More,
                order: 70,
                alias_of: None,
                opens_on_model: true,
                efforts: Some(CLAUDE_EFFORTS),
                supports_fast: Some(true),
            },
            ModelDecl {
                id: "claude-opus-4-6",
                name: Some("Opus 4.6"),
                description: Some("Opus 4.6"),
                group: ModelGroup::More,
                order: 80,
                alias_of: None,
                opens_on_model: true,
                efforts: Some(CLAUDE_EFFORTS_NO_XHIGH),
                supports_fast: Some(false),
            },
            ModelDecl {
                id: "claude-sonnet-4-6",
                name: Some("Sonnet 4.6"),
                description: Some("Sonnet 4.6"),
                group: ModelGroup::More,
                order: 90,
                alias_of: None,
                opens_on_model: true,
                efforts: Some(CLAUDE_EFFORTS_NO_XHIGH),
                supports_fast: Some(false),
            },
        ],
        session_model_meta: Some(claude_session_model_meta),
    },
    HarnessSpec {
        id: "codex-acp",
        label: "Codex",
        description:
            "OpenAI Codex CLI through the codex-acp bridge, billed to your ChatGPT subscription.",
        command: "codex-acp",
        args: &[],
        env_remove: &[],
        modes: &[
            ("auto", "agent-full-access"),
            ("approve", "read-only"),
            ("smartApprove", "agent"),
            ("chat", "read-only"),
        ],
        // codex-acp, grok-acp, copilot-acp and amp-acp describe their own
        // models well enough: every row the bridge lists is probed.
        models: &[],
        session_model_meta: None,
    },
    HarnessSpec {
        id: "grok-acp",
        label: "Grok",
        description: "xAI's Grok CLI in ACP mode.",
        command: "grok",
        args: &["agent", "stdio"],
        env_remove: &[],
        modes: &[],
        // codex-acp, grok-acp, copilot-acp and amp-acp describe their own
        // models well enough: every row the bridge lists is probed.
        models: &[],
        session_model_meta: None,
    },
    HarnessSpec {
        id: "copilot-acp",
        label: "GitHub Copilot",
        description: "GitHub Copilot CLI in ACP mode.",
        command: "copilot",
        args: &["--acp"],
        env_remove: &[],
        modes: &[
            ("auto", "agent"),
            ("approve", "agent"),
            ("smartApprove", "agent"),
            ("chat", "plan"),
        ],
        // codex-acp, grok-acp, copilot-acp and amp-acp describe their own
        // models well enough: every row the bridge lists is probed.
        models: &[],
        session_model_meta: None,
    },
    HarnessSpec {
        id: "amp-acp",
        label: "Amp",
        description: "Sourcegraph Amp through the amp-acp bridge.",
        command: "amp-acp",
        args: &[],
        env_remove: &[],
        modes: &[
            ("auto", "bypass"),
            ("approve", "default"),
            ("smartApprove", "default"),
            ("chat", "default"),
        ],
        // codex-acp, grok-acp, copilot-acp and amp-acp describe their own
        // models well enough: every row the bridge lists is probed.
        models: &[],
        session_model_meta: None,
    },
];

pub const DEFAULT_AGENT_MODE: &str = "auto";

pub fn harness(id: &str) -> Option<&'static HarnessSpec> {
    HARNESSES.iter().find(|spec| spec.id == id)
}

pub fn bridge_mode(spec: &HarnessSpec, agent_mode: &str) -> Option<&'static str> {
    spec.modes
        .iter()
        .find(|(distill_mode, _)| *distill_mode == agent_mode)
        .map(|(_, bridge_mode)| *bridge_mode)
}

/// `_meta` for the throwaway session the model probe opens. Claude Code's
/// bridge writes no transcript at all for a session it is told not to persist
/// — not even a project directory — which is what lets the probe open one
/// without leaving a chat behind in the user's own history.
pub fn probe_session_meta(harness_id: &str) -> Option<Value> {
    (harness_id == CLAUDE_HARNESS)
        .then(|| json!({ "claudeCode": { "options": { "persistSession": false } } }))
}

/// Where a bridge row the harness does not declare is filed: after every
/// declared one, in the order the bridge listed it. A model its harness
/// advertises is never hidden — that would be the app deciding what the
/// harness serves.
const UNDECLARED_ORDER: u16 = 1000;

/// A harness's whole model list: what Distill declares for it merged with
/// what the probe found, in menu order.
///
/// Declared rows place and name a model; probed rows say what it can do.
/// The merge happens at request time, so a change to the table above reaches
/// the picker without re-probing a bridge.
pub fn merge_inventory(harness_id: &str, probed: Vec<Value>) -> Vec<Value> {
    let declared: &[ModelDecl] = harness(harness_id).map(|spec| spec.models).unwrap_or(&[]);
    let mut rows: Vec<(u16, Value)> = declared
        .iter()
        .filter_map(|decl| {
            let found = probed.iter().find(|row| row["id"] == decl.id);
            // A declaration only places and names a model the bridge lists;
            // it does not conjure one. The models Distill opens a session on
            // are the exception — no bridge ever lists those.
            (found.is_some() || decl.opens_on_model)
                .then(|| (decl.order, declared_row(decl, found)))
        })
        .collect();
    for (index, row) in probed.iter().enumerate() {
        let Some(id) = row["id"].as_str() else {
            continue;
        };
        if declared.iter().any(|decl| decl.id == id) {
            continue;
        }
        let order = UNDECLARED_ORDER.saturating_add(u16::try_from(index).unwrap_or(u16::MAX));
        rows.push((order, bridge_row(row, order)));
    }
    rows.sort_by_key(|(order, _)| *order);
    rows.into_iter().map(|(_, row)| row).collect()
}

/// A declared model, wearing whatever the probe learned about it. What the
/// bridge itself reported always wins: the declared effort levels and fast
/// support exist for the models the probe cannot select, and would otherwise
/// go on being believed after a bridge starts offering one of them.
fn declared_row(decl: &ModelDecl, probed: Option<&Value>) -> Value {
    let probed_str = |key: &str| {
        probed
            .and_then(|row| row.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let name = decl
        .name
        .map(str::to_string)
        .or_else(|| probed_str("name"))
        .unwrap_or_else(|| decl.id.to_string());
    let description = decl
        .description
        .map(str::to_string)
        .or_else(|| probed_str("description"));
    let found = probed_capabilities(probed);
    let declares = decl.efforts.is_some() || decl.supports_fast.is_some();
    let (efforts, default_effort, supports_fast, source) = if found.3 == "probed" || !declares {
        found
    } else {
        (
            decl.efforts
                .unwrap_or(&[])
                .iter()
                .map(|value| effort(value, None, None))
                .collect(),
            Value::Null,
            json!(decl.supports_fast),
            "declared",
        )
    };
    json!({
        "id": decl.id,
        "name": name,
        "description": description,
        "group": decl.group.as_str(),
        "order": decl.order,
        "aliasOf": decl.alias_of,
        "efforts": efforts,
        "defaultEffort": default_effort,
        "supportsFast": supports_fast,
        "opensOnModel": decl.opens_on_model,
        "capabilitySource": source,
    })
}

/// A model the harness advertises that Distill says nothing about.
fn bridge_row(probed: &Value, order: u16) -> Value {
    let id = probed["id"].as_str().unwrap_or_default();
    let (efforts, default_effort, supports_fast, source) = probed_capabilities(Some(probed));
    json!({
        "id": id,
        "name": probed.get("name").and_then(Value::as_str).unwrap_or(id),
        "description": probed.get("description").cloned().unwrap_or(Value::Null),
        "group": ModelGroup::Main.as_str(),
        "order": order,
        "aliasOf": Value::Null,
        "efforts": efforts,
        "defaultEffort": default_effort,
        "supportsFast": supports_fast,
        "opensOnModel": false,
        "capabilitySource": source,
    })
}

/// What a probed row says a model offers. An empty effort list with a source
/// of `probed` means the model has no effort control; with `unknown` it means
/// nobody has asked yet. The two must never read the same.
fn probed_capabilities(probed: Option<&Value>) -> (Vec<Value>, Value, Value, &'static str) {
    let source = probed
        .and_then(|row| row.get("capabilitySource"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if source == "unknown" {
        return (Vec::new(), Value::Null, Value::Null, "unknown");
    }
    let efforts = probed
        .and_then(|row| row.get("efforts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let default_effort = probed
        .and_then(|row| row.get("defaultEffort"))
        .cloned()
        .unwrap_or(Value::Null);
    let supports_fast = probed
        .and_then(|row| row.get("supportsFast"))
        .cloned()
        .unwrap_or(Value::Null);
    (efforts, default_effort, supports_fast, "probed")
}

/// One effort value as the renderer lists it. A declared value carries no
/// name of its own, so it wears its id with a capital.
pub fn effort(value: &str, name: Option<&str>, description: Option<&str>) -> Value {
    let mut chars = value.chars();
    let capitalized = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    json!({
        "value": value,
        "name": name.unwrap_or(&capitalized),
        "description": description,
    })
}

/// The `_meta` that opens a session on `model_id`, when that model is one the
/// harness runs only that way; `None` for a model the bridge selects itself.
pub fn session_model_meta(spec: &HarnessSpec, model_id: &str) -> Option<Value> {
    let meta = spec.session_model_meta?;
    spec.models
        .iter()
        .any(|decl| decl.opens_on_model && decl.id == model_id)
        .then(|| meta(model_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row as `probe_models` writes it: the bridge's own name, plus what
    /// selecting the model showed.
    fn probed(id: &str, name: &str, efforts: &[&str], fast: bool) -> Value {
        json!({
            "id": id,
            "name": name,
            "description": Value::Null,
            "efforts": efforts.iter().map(|value| effort(value, None, None)).collect::<Vec<_>>(),
            "defaultEffort": Value::Null,
            "supportsFast": fast,
            "capabilitySource": "probed",
        })
    }

    fn claude_bridge_rows() -> Vec<Value> {
        vec![
            probed("default", "Default", CLAUDE_EFFORTS, true),
            probed("opus[1m]", "Opus (1M context)", CLAUDE_EFFORTS, true),
            probed("claude-fable-5[1m]", "Fable 5 (1M)", CLAUDE_EFFORTS, false),
            probed("sonnet", "Sonnet", CLAUDE_EFFORTS, false),
            probed("haiku", "Haiku 4.5", &[], false),
        ]
    }

    #[test]
    fn claudes_menu_is_the_one_claude_code_shows() {
        let models = merge_inventory("claude-acp", claude_bridge_rows());
        let layout: Vec<(&str, &str, u64, Option<&str>, bool)> = models
            .iter()
            .map(|model| {
                (
                    model["id"].as_str().unwrap_or_default(),
                    model["group"].as_str().unwrap_or_default(),
                    model["order"].as_u64().unwrap_or_default(),
                    model["aliasOf"].as_str(),
                    model["opensOnModel"].as_bool().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            layout,
            [
                ("claude-fable-5-1[1m]", "main", 10, None, true),
                ("opus[1m]", "main", 20, None, false),
                ("default", "main", 20, Some("opus[1m]"), false),
                ("sonnet", "main", 30, None, false),
                ("haiku", "main", 40, None, false),
                ("claude-fable-5[1m]", "more", 50, None, false),
                ("claude-opus-4-8", "more", 60, None, true),
                ("claude-opus-4-7", "more", 70, None, true),
                ("claude-opus-4-6", "more", 80, None, true),
                ("claude-sonnet-4-6", "more", 90, None, true),
            ]
        );
        // Declared names replace the bridge's aliases; a row Distill does not
        // name keeps the bridge's own.
        assert_eq!(models[1]["name"], "Opus 5");
        assert_eq!(models[2]["name"], "Default");
    }

    #[test]
    fn a_model_the_probe_cannot_select_carries_what_distill_declares() {
        let models = merge_inventory("claude-acp", claude_bridge_rows());
        let row = |id: &str| {
            models
                .iter()
                .find(|model| model["id"] == id)
                .cloned()
                .expect("row")
        };

        let opus_4_6 = row("claude-opus-4-6");
        assert_eq!(opus_4_6["capabilitySource"], "declared");
        let efforts: Vec<&str> = opus_4_6["efforts"]
            .as_array()
            .expect("efforts")
            .iter()
            .filter_map(|value| value["value"].as_str())
            .collect();
        // 4.6-class models have no xhigh: asking for it lands on "default".
        assert_eq!(efforts, ["default", "low", "medium", "high", "max"]);
        assert_eq!(opus_4_6["efforts"][0]["name"], "Default");
        assert_eq!(opus_4_6["supportsFast"], false);
        assert_eq!(row("claude-opus-4-8")["supportsFast"], true);

        // A bridge row keeps what the probe saw, and "no effort control" is
        // not the same answer as "nobody has looked".
        let haiku = row("haiku");
        assert_eq!(haiku["capabilitySource"], "probed");
        assert_eq!(haiku["efforts"].as_array().expect("efforts").len(), 0);
        assert_eq!(row("opus[1m]")["capabilitySource"], "probed");
        assert_eq!(row("opus[1m]")["supportsFast"], true);
    }

    #[test]
    fn a_bridge_that_starts_offering_a_declared_model_is_believed_over_the_table() {
        // The declared levels are a stand-in for a model the probe cannot
        // select. The day claude-agent-acp lists one, it stops being one.
        let mut rows = claude_bridge_rows();
        rows.push(probed(
            "claude-opus-4-6",
            "Opus 4.6",
            &["default", "high", "xhigh"],
            true,
        ));
        let models = merge_inventory("claude-acp", rows);
        let opus_4_6 = models
            .iter()
            .find(|model| model["id"] == "claude-opus-4-6")
            .expect("row");
        assert_eq!(opus_4_6["capabilitySource"], "probed");
        assert_eq!(opus_4_6["supportsFast"], true);
        assert_eq!(opus_4_6["efforts"].as_array().expect("efforts").len(), 3);
        // Its place in the menu is still Distill's to decide.
        assert_eq!(opus_4_6["group"], "more");
        assert_eq!(opus_4_6["order"], 80);
        assert_eq!(opus_4_6["opensOnModel"], true);
    }

    #[test]
    fn a_harness_that_declares_nothing_lists_its_bridge_in_its_own_order() {
        let models = merge_inventory(
            "codex-acp",
            vec![
                probed("gpt-6-astra", "GPT-6-Astra", &["low", "ultra"], true),
                probed(
                    "gpt-5.3-codex-spark",
                    "GPT-5.3-Codex-Spark",
                    &["low"],
                    false,
                ),
            ],
        );
        let placed: Vec<(&str, &str, u64)> = models
            .iter()
            .map(|model| {
                (
                    model["id"].as_str().unwrap_or_default(),
                    model["group"].as_str().unwrap_or_default(),
                    model["order"].as_u64().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            placed,
            [
                ("gpt-6-astra", "main", 1000),
                ("gpt-5.3-codex-spark", "main", 1001),
            ]
        );
        assert_eq!(models[1]["supportsFast"], false);
        assert!(merge_inventory("codex-acp", Vec::new()).is_empty());
    }

    #[test]
    fn a_model_the_bridge_adds_is_listed_rather_than_hidden() {
        let mut rows = claude_bridge_rows();
        rows.push(probed("claude-opus-5-1", "Opus 5.1", &["high"], false));
        let models = merge_inventory("claude-acp", rows);
        let newcomer = models.last().expect("the new model");
        assert_eq!(newcomer["id"], "claude-opus-5-1");
        assert_eq!(newcomer["group"], "main");
        assert_eq!(newcomer["order"], 1005);
        assert_eq!(models.len(), 11);
    }

    #[test]
    fn a_declaration_places_a_bridge_row_rather_than_inventing_one() {
        // Only opus[1m] came back: a bridge that stops listing a model has
        // stopped serving it, and Distill does not list it on its behalf.
        // The five it opens a session on are its own to offer.
        let models = merge_inventory(
            "claude-acp",
            vec![probed(
                "opus[1m]",
                "Opus (1M context)",
                CLAUDE_EFFORTS,
                true,
            )],
        );
        let ids: Vec<&str> = models
            .iter()
            .filter_map(|model| model["id"].as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "claude-fable-5-1[1m]",
                "opus[1m]",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-sonnet-4-6",
            ]
        );
    }

    #[test]
    fn a_list_cached_before_capabilities_existed_reads_as_unknown() {
        let models = merge_inventory(
            "grok-acp",
            vec![json!({ "id": "grok-4.6", "name": "Grok 4.6" })],
        );
        assert_eq!(models[0]["capabilitySource"], "unknown");
        assert_eq!(models[0]["efforts"].as_array().expect("efforts").len(), 0);
        assert_eq!(models[0]["supportsFast"], Value::Null);
    }

    #[test]
    fn only_an_unlisted_model_opens_a_session_on_it() {
        let claude = harness("claude-acp").expect("claude harness");
        assert_eq!(
            session_model_meta(claude, "claude-opus-4-7"),
            Some(json!({ "claudeCode": { "options": { "model": "claude-opus-4-7" } } }))
        );
        for id in [
            "claude-fable-5-1[1m]",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ] {
            assert!(session_model_meta(claude, id).is_some(), "{id} opens on it");
        }
        // The rows the bridge lists itself are selected, not opened on —
        // including the two that carry a context suffix in their id.
        for id in [
            "default",
            "opus[1m]",
            "claude-fable-5[1m]",
            "sonnet",
            "haiku",
        ] {
            assert_eq!(
                session_model_meta(claude, id),
                None,
                "{id} is bridge-listed"
            );
        }
        let codex = harness("codex-acp").expect("codex harness");
        assert_eq!(session_model_meta(codex, "claude-opus-4-7"), None);
    }
}
