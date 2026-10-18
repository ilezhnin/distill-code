//! What a provider may do with what benchmark turns send it. A provider that
//! may train on submitted data would learn the private tasks, so it runs only
//! `train` versions and never judges; the others run every split and may
//! judge. The owner's word is data: `providerDataUse` in the benchmark
//! settings document, `{"<providerId>": {"trainsOnSubmissions": bool}}`. A
//! provider it does not name keeps its default: the native providers the
//! owner confirmed (Anthropic, OpenAI and xAI, 10-18) do not train, every
//! other native provider is assumed to. A provider with no native profile runs
//! nothing natively, so the rule has nothing to hold back from it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::services::agent_host::execution::NativeProvider;

/// The benchmark settings document the renderer writes.
const SETTINGS: &str = "settings.json";
/// The native providers the owner confirmed do not train on what they are
/// sent, unless the settings say otherwise.
const CONFIRMED: &[&str] = &["claude-acp", "codex-acp", "grok-acp"];
/// The one split a provider that may train receives.
pub(crate) const TRAIN: &str = "train";

/// The owner's word on every provider, as read for one decision.
#[derive(Debug, Clone, Default)]
pub struct DataUse {
    /// What the settings say by provider; none when they could not be read,
    /// and then every native provider is assumed to train.
    stated: Option<BTreeMap<String, bool>>,
}

impl DataUse {
    /// The rule a benchmark settings document states.
    pub fn from_settings(settings: &Value) -> Self {
        let stated = settings["providerDataUse"]
            .as_object()
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(|(provider, stated)| {
                        let trains = stated["trainsOnSubmissions"].as_bool()?;
                        Some((provider.clone(), trains))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            stated: Some(stated),
        }
    }

    /// The rule for benchmarks under `root`. No settings document means the
    /// defaults; one that cannot be read means every native provider trains,
    /// so a broken file never lets a private task out.
    pub async fn load(root: &Path) -> Self {
        let unreadable = |error: &dyn std::fmt::Display| {
            log::warn!("[benchmarks] provider data use unreadable, every native provider counts as training: {error}");
            Self::default()
        };
        match tokio::fs::read_to_string(root.join(SETTINGS)).await {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(settings) => Self::from_settings(&settings),
                Err(error) => unreadable(&error),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Self::from_settings(&Value::Null)
            }
            Err(error) => unreadable(&error),
        }
    }

    /// Whether `provider` may train on what it is sent.
    pub fn trains(&self, provider: &str) -> bool {
        if NativeProvider::for_harness(provider).is_none() {
            return false;
        }
        match &self.stated {
            None => true,
            Some(stated) => stated
                .get(provider)
                .copied()
                .unwrap_or(!CONFIRMED.contains(&provider)),
        }
    }

    /// Why `provider` may not receive a task version of `split`.
    pub fn refusal(&self, provider: &str, split: &str) -> Option<String> {
        (self.trains(provider) && split != TRAIN).then(|| {
            format!(
                "{} may train on submitted data, so it runs only train tasks, not {split} ones",
                name(provider)
            )
        })
    }

    /// Why `provider`'s models may not judge.
    pub fn judge_refusal(&self, provider: &str) -> Option<String> {
        self.trains(provider).then(|| {
            format!(
                "{} may train on submitted data, so its models never judge",
                name(provider)
            )
        })
    }

    /// Every native provider and what holds for it, for the owner's view.
    pub fn providers(&self) -> Vec<ProviderDataUse> {
        NativeProvider::ALL
            .iter()
            .map(|native| {
                let provider = native.harness_id();
                ProviderDataUse {
                    provider_id: provider.to_owned(),
                    name: name(provider),
                    trains_on_submissions: self.trains(provider),
                    stated: self
                        .stated
                        .as_ref()
                        .is_some_and(|stated| stated.contains_key(provider)),
                }
            })
            .collect()
    }
}

/// One provider's data use as the owner sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDataUse {
    pub provider_id: String,
    pub name: String,
    pub trains_on_submissions: bool,
    /// The settings name it; otherwise it holds by default.
    pub stated: bool,
}

fn name(provider: &str) -> String {
    super::judge_pool::vendor(provider).map_or_else(|| provider.to_owned(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn confirmed_providers_run_every_split_and_the_others_only_train() {
        let defaults = DataUse::from_settings(&json!({}));
        for provider in CONFIRMED {
            assert!(!defaults.trains(provider), "{provider}");
            assert!(defaults.refusal(provider, "held_out").is_none());
            assert!(defaults.judge_refusal(provider).is_none());
        }
        for provider in ["zai-acp", "kimi-acp"] {
            assert!(defaults.trains(provider), "{provider}");
            assert!(defaults.refusal(provider, TRAIN).is_none());
            for split in ["held_out", "development"] {
                assert!(defaults
                    .refusal(provider, split)
                    .unwrap()
                    .contains("may train on submitted data"));
            }
            assert!(defaults.judge_refusal(provider).is_some());
        }
        // A provider with no native profile runs nothing natively.
        assert!(!defaults.trains("invented-provider"));
    }

    #[test]
    fn the_owners_word_overrides_the_default_and_a_broken_file_restricts_all() {
        let stated = DataUse::from_settings(&json!({"providerDataUse": {
            "grok-acp": {"trainsOnSubmissions": true},
            "zai-acp": {"trainsOnSubmissions": false},
            "kimi-acp": {"trainsOnSubmissions": "no"},
        }}));
        assert!(stated.trains("grok-acp"));
        assert!(!stated.trains("zai-acp"));
        // A value that is not a boolean states nothing.
        assert!(stated.trains("kimi-acp"));
        assert!(!stated.trains("claude-acp"));
        let rows = stated.providers();
        let grok = rows
            .iter()
            .find(|row| row.provider_id == "grok-acp")
            .unwrap();
        assert!(grok.trains_on_submissions && grok.stated);
        let claude = rows
            .iter()
            .find(|row| row.provider_id == "claude-acp")
            .unwrap();
        assert!(!claude.trains_on_submissions && !claude.stated);
        let unread = DataUse::default();
        for provider in CONFIRMED {
            assert!(unread.trains(provider));
        }
    }

    #[tokio::test]
    async fn settings_are_read_from_the_benchmark_root() {
        let root = tempfile::tempdir().unwrap();
        assert!(!DataUse::load(root.path()).await.trains("codex-acp"));
        std::fs::write(
            root.path().join(SETTINGS),
            json!({"providerDataUse": {"codex-acp": {"trainsOnSubmissions": true}}}).to_string(),
        )
        .unwrap();
        assert!(DataUse::load(root.path()).await.trains("codex-acp"));
        std::fs::write(root.path().join(SETTINGS), "{").unwrap();
        assert!(DataUse::load(root.path()).await.trains("claude-acp"));
    }
}
