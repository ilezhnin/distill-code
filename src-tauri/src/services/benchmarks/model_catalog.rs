//! Effective-dated model facts: vendor list prices, context size and display
//! overrides. Measurements never store these; a report resolves the entry that
//! applied when the measurement was taken, so a later price change adds an
//! entry instead of rewriting history.
use super::types::{CatalogEntry, Configuration, TokenUsage};

pub const ANTHROPIC_PRICING: &str = "https://platform.claude.com/docs/en/about-claude/pricing";
pub const ANTHROPIC_MODELS: &str = "https://platform.claude.com/docs/en/models/overview";
pub const OPENAI_PRICING: &str = "https://developers.openai.com/api/docs/pricing";
pub const XAI_MODELS: &str = "https://docs.x.ai/docs/models";
pub const MOONSHOT_PRICING: &str = "https://platform.kimi.ai/docs/pricing/chat";

/// 2026-10-02T12:00:00Z: the day the seed sources were read, at noon so every
/// time zone shows the same date.
const SEED_CHECKED_AT: i64 = 1_790_942_400_000;
/// 2026-10-03T12:00:00Z: the day the OpenAI, xAI and Moonshot sources were read.
const VENDOR_SEEDS_CHECKED_AT: i64 = 1_791_028_800_000;
/// 2026-10-05T12:00:00Z: the day the estimates for unpriced models were set.
const ESTIMATES_CHECKED_AT: i64 = 1_791_201_600_000;

/// The model entry that applied to `configuration` at `at`, as
/// `lib/modelCatalog.ts` resolves it: an entry of its provider or of none,
/// whose needle is in the model's name or id, with the latest effective date
/// not after `at`. A price recorded afterwards is no evidence about a run.
pub fn resolve<'a>(
    entries: &'a [CatalogEntry],
    configuration: &Configuration,
    at: i64,
) -> Option<&'a CatalogEntry> {
    let haystack = format!(
        "{} {}",
        configuration.model_name.as_deref().unwrap_or(""),
        configuration.model_id
    )
    .to_lowercase();
    entries
        .iter()
        .filter(|entry| {
            entry.kind == "model"
                && entry
                    .provider_id
                    .as_deref()
                    .is_none_or(|provider| provider == configuration.provider_id)
                && haystack.contains(&entry.needle.to_lowercase())
                && entry.effective_from <= at
        })
        .max_by_key(|entry| (entry.effective_from, entry.created_at))
}

/// What `usage` costs at `entry`'s list prices, in USD: uncached input,
/// output, cache reads and cache writes, each at its price per million tokens.
/// Input counts the uncached prompt and output includes reasoning, as the
/// host records a turn's usage. Unknown without both counts, or when tokens
/// of a kind have no price.
pub fn list_cost(entry: &CatalogEntry, usage: &TokenUsage) -> Option<f64> {
    let part = |tokens: Option<u64>, price: Option<f64>| match tokens {
        None | Some(0) => Some(0.0),
        Some(count) => price.map(|per_million| count as f64 * per_million / 1_000_000.0),
    };
    usage.input?;
    usage.output?;
    Some(
        part(usage.input, entry.input_per_million)?
            + part(usage.output, entry.output_per_million)?
            + part(usage.cache_read, entry.cache_read_per_million)?
            + part(usage.cache_write, entry.cache_write_per_million)?,
    )
}

/// An attempt's cost as every report reads it: its tokens at the list prices
/// that applied when it ran (`at`), so every provider is priced the same way;
/// what the provider reported only where no list price resolves. Providers
/// report on different bases (Grok's figure runs near a third of its list
/// price, Kimi reports none), so a reported figure is evidence for the
/// attempt's details, not a board.
pub fn attempt_cost(
    entries: &[CatalogEntry],
    configuration: &Configuration,
    usage: &TokenUsage,
    at: Option<i64>,
) -> Option<f64> {
    at.and_then(|at| list_cost(resolve(entries, configuration, at)?, usage))
        .or(usage.cost)
}

/// The seed sets in the order they shipped, by id. A store adds each set once.
pub fn seed_sets() -> Vec<(&'static str, Vec<CatalogEntry>)> {
    vec![
        ("anthropic-2026-10-02", seeds()),
        ("openai-2026-10-03", openai_seeds()),
        ("xai-2026-10-03", xai_seeds()),
        ("moonshot-2026-10-03", moonshot_seeds()),
        ("estimates-2026-10-05", estimate_seeds()),
    ]
}

/// Models no vendor prices, priced as their nearest published sibling so a
/// board never treats an unpriced model as free or as worst. Each entry names
/// its basis in `source`; a published price added later wins by date.
/// Effective from the vendor seeds' date, so every measurement since is
/// priced; later creation wins the tie against the unpriced vendor rows.
fn estimate_seeds() -> Vec<CatalogEntry> {
    let estimate = |position: i64,
                    slug: &str,
                    provider_id: &str,
                    needle: &str,
                    name: &str,
                    vendor: &str,
                    prices: [Option<f64>; 4],
                    context: Option<u64>,
                    source: &str| CatalogEntry {
        id: format!("seed-estimate-{slug}"),
        kind: "model".into(),
        provider_id: Some(provider_id.into()),
        needle: needle.into(),
        display_name: Some(name.into()),
        vendor: Some(vendor.into()),
        input_per_million: prices[0],
        output_per_million: prices[1],
        cache_read_per_million: prices[2],
        cache_write_per_million: prices[3],
        context_tokens: context,
        effective_from: VENDOR_SEEDS_CHECKED_AT,
        checked_at: ESTIMATES_CHECKED_AT,
        source: source.into(),
        created_at: ESTIMATES_CHECKED_AT + position,
    };
    vec![
        estimate(
            0,
            "grok-4-7-build-fast",
            "grok-acp",
            "grok-4.7-build-fast",
            "Grok 4.7 Fast",
            "xAI",
            [Some(2.0), Some(6.0), Some(0.5), None],
            Some(256_000),
            "estimate: xAI lists no separate price for Grok 4.7 Fast and describes it as Grok 4.7 served faster, so it is priced as Grok 4.7 (https://docs.x.ai/docs/models) until a published price appears",
        ),
        estimate(
            1,
            "kimi-k2-8-preview",
            "kimi-acp",
            "k2.8",
            "Kimi K2.8 Preview",
            "Moonshot AI",
            [Some(0.95), Some(4.0), Some(0.19), None],
            Some(262_144),
            "estimate: Moonshot publishes no price for K2.8 Preview (kimi-for-coding), so it is priced as K2.7 Code, the previous model on the same id (https://platform.kimi.ai/docs/pricing/chat, kimi-k2.7-code), until a published price appears",
        ),
    ]
}

struct Seed {
    slug: &'static str,
    needle: &'static str,
    name: &'static str,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    context: Option<u64>,
}

/// Anthropic's published rates and context windows on the day they were read.
fn seeds() -> Vec<CatalogEntry> {
    let seeds = [
        Seed {
            slug: "fable-5-1",
            needle: "fable 5.1",
            name: "Claude Fable 5.1",
            input: 10.0,
            output: 50.0,
            cache_read: 0.25,
            cache_write: 12.5,
            context: Some(1_000_000),
        },
        Seed {
            slug: "opus-5-5",
            needle: "opus 5.5",
            name: "Claude Opus 5.5",
            input: 4.0,
            output: 20.0,
            cache_read: 0.20,
            cache_write: 5.0,
            context: Some(1_000_000),
        },
        Seed {
            slug: "sonnet-5-5",
            needle: "sonnet 5.5",
            name: "Claude Sonnet 5.5",
            input: 2.0,
            output: 10.0,
            cache_read: 0.20,
            cache_write: 2.5,
            context: Some(1_000_000),
        },
        Seed {
            slug: "sonnet-5",
            needle: "sonnet 5",
            name: "Claude Sonnet 5",
            input: 2.0,
            output: 10.0,
            cache_read: 0.20,
            cache_write: 2.5,
            context: None,
        },
        Seed {
            slug: "haiku-4-5",
            needle: "haiku 4.5",
            name: "Claude Haiku 4.5",
            input: 1.0,
            output: 5.0,
            cache_read: 0.10,
            cache_write: 1.25,
            context: Some(200_000),
        },
    ];
    seeds
        .into_iter()
        .map(|seed| CatalogEntry {
            id: format!("seed-anthropic-{}", seed.slug),
            kind: "model".into(),
            provider_id: None,
            needle: seed.needle.into(),
            display_name: Some(seed.name.into()),
            vendor: Some("Anthropic".into()),
            input_per_million: Some(seed.input),
            output_per_million: Some(seed.output),
            cache_read_per_million: Some(seed.cache_read),
            cache_write_per_million: Some(seed.cache_write),
            context_tokens: seed.context,
            effective_from: SEED_CHECKED_AT,
            checked_at: SEED_CHECKED_AT,
            source: format!("{ANTHROPIC_PRICING} ; {ANTHROPIC_MODELS}"),
            created_at: SEED_CHECKED_AT,
        })
        .collect()
}

/// A model one provider's bridge serves, at the vendor's list price: input,
/// output, cache read and cache write per million tokens. A price the vendor
/// does not publish stays unknown.
struct VendorSeed {
    slug: &'static str,
    needle: &'static str,
    name: Option<&'static str>,
    prices: [Option<f64>; 4],
    context: Option<u64>,
    source: &'static str,
}

/// One vendor's set. Later rows win ties on the same date, so a row whose
/// needle another row's id contains (`grok-4.7` in `grok-4.7-build-fast`)
/// comes before that row.
fn vendor_set(
    vendor_slug: &str,
    vendor: &str,
    provider_id: &str,
    seeds: Vec<VendorSeed>,
) -> Vec<CatalogEntry> {
    seeds
        .into_iter()
        .zip(0i64..)
        .map(|(seed, position)| CatalogEntry {
            id: format!("seed-{vendor_slug}-{}", seed.slug),
            kind: "model".into(),
            provider_id: Some(provider_id.into()),
            needle: seed.needle.into(),
            display_name: seed.name.map(Into::into),
            vendor: Some(vendor.into()),
            input_per_million: seed.prices[0],
            output_per_million: seed.prices[1],
            cache_read_per_million: seed.prices[2],
            cache_write_per_million: seed.prices[3],
            context_tokens: seed.context,
            effective_from: VENDOR_SEEDS_CHECKED_AT,
            checked_at: VENDOR_SEEDS_CHECKED_AT,
            source: seed.source.into(),
            created_at: VENDOR_SEEDS_CHECKED_AT + position,
        })
        .collect()
}

/// Standard short-context rates. The context is what the Codex CLI serves,
/// not the API maximum.
fn openai_seeds() -> Vec<CatalogEntry> {
    let seed = |slug, needle, name, prices, context| VendorSeed {
        slug,
        needle,
        name: Some(name),
        prices,
        context,
        source: OPENAI_PRICING,
    };
    let served = Some(272_000);
    vendor_set(
        "openai",
        "OpenAI",
        "codex-acp",
        vec![
            seed(
                "gpt-6-astra",
                "gpt-6-astra",
                "GPT-6 Astra",
                [Some(10.0), Some(50.0), Some(1.0), Some(12.5)],
                served,
            ),
            seed(
                "gpt-6-sol",
                "gpt-6-sol",
                "GPT-6 Sol",
                [Some(2.0), Some(10.0), Some(0.2), Some(2.5)],
                served,
            ),
            seed(
                "gpt-6-luna",
                "gpt-6-luna",
                "GPT-6 Luna",
                [Some(0.1), Some(0.5), Some(0.01), Some(0.125)],
                served,
            ),
            // Served once the pinned Codex runtime moves past 0.155.1.
            seed(
                "gpt-6-1-sol",
                "gpt-6.1-sol",
                "GPT-6.1 Sol",
                [Some(2.0), Some(10.0), Some(0.1), Some(2.5)],
                None,
            ),
            seed(
                "gpt-5-6-sol",
                "gpt-5.6-sol",
                "GPT-5.6 Sol",
                [Some(4.0), Some(20.0), Some(0.4), Some(5.0)],
                served,
            ),
            seed(
                "gpt-5-6-terra",
                "gpt-5.6-terra",
                "GPT-5.6 Terra",
                [Some(2.0), Some(12.0), Some(0.2), Some(2.5)],
                served,
            ),
            seed(
                "gpt-5-6-luna",
                "gpt-5.6-luna",
                "GPT-5.6 Luna",
                [Some(0.2), Some(1.2), Some(0.02), Some(0.25)],
                served,
            ),
            seed(
                "gpt-5-5",
                "gpt-5.5",
                "GPT-5.5",
                [Some(5.0), Some(30.0), Some(0.5), None],
                served,
            ),
        ],
    )
}

/// The under-200K tier; the context is what the Grok CLI serves.
fn xai_seeds() -> Vec<CatalogEntry> {
    let seed = |slug, needle, name, prices, source| VendorSeed {
        slug,
        needle,
        name: Some(name),
        prices,
        context: Some(256_000),
        source,
    };
    vendor_set(
        "xai",
        "xAI",
        "grok-acp",
        vec![
            seed(
                "grok-4-7",
                "grok-4.7",
                "Grok 4.7",
                [Some(2.0), Some(6.0), Some(0.5), None],
                XAI_MODELS,
            ),
            // After Grok 4.7, whose needle it also matches: the Fast row then
            // resolves to unknown prices instead of Grok 4.7's.
            seed(
                "grok-4-7-build-fast",
                "grok-4.7-build-fast",
                "Grok 4.7 Fast",
                [None; 4],
                "https://docs.x.ai/docs/models; Grok 4.7 Fast is not listed there, so its prices are unknown",
            ),
            seed(
                "grok-4-6",
                "grok-4.6",
                "Grok 4.6",
                [Some(2.0), Some(6.0), Some(0.5), None],
                XAI_MODELS,
            ),
            seed(
                "grok-4-5",
                "grok-4.5",
                "Grok 4.5",
                [Some(2.0), Some(6.0), Some(0.3), None],
                XAI_MODELS,
            ),
        ],
    )
}

/// Kimi Code names its own models; `kimi-code/kimi-for-coding` (K2.8 Preview)
/// has no published price and no entry.
fn moonshot_seeds() -> Vec<CatalogEntry> {
    vendor_set(
        "moonshot",
        "Moonshot AI",
        "kimi-acp",
        vec![
            // Matches `kimi-code/k3-256k` as well: the same model and price,
            // with a different window, so the context stays unknown.
            VendorSeed {
                slug: "k3",
                needle: "kimi-code/k3",
                name: None,
                prices: [Some(3.0), Some(15.0), Some(0.3), Some(3.0)],
                context: None,
                source: MOONSHOT_PRICING,
            },
            VendorSeed {
                slug: "k2-7-code-highspeed",
                needle: "kimi-for-coding-highspeed",
                name: None,
                prices: [Some(1.9), Some(8.0), Some(0.38), None],
                context: Some(262_144),
                source: MOONSHOT_PRICING,
            },
        ],
    )
}

/// Rejects an entry that could not resolve or would misprice a run.
pub fn validate(entry: &CatalogEntry) -> Result<(), String> {
    if entry.kind != "model" {
        return Err(format!("Unknown catalog kind {}", entry.kind));
    }
    if entry.needle.trim().is_empty() {
        return Err("A model needle is required".into());
    }
    if entry.effective_from <= 0 {
        return Err("An effective date is required".into());
    }
    for (label, value) in [
        ("input", entry.input_per_million),
        ("output", entry.output_per_million),
        ("cache read", entry.cache_read_per_million),
        ("cache write", entry.cache_write_per_million),
    ] {
        if value.is_some_and(|v| !v.is_finite() || v < 0.0) {
            return Err(format!("The {label} price must be a non-negative number"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_sets_validate_and_name_their_source() {
        let sets = seed_sets();
        let ids: Vec<_> = sets.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            ids,
            [
                "anthropic-2026-10-02",
                "openai-2026-10-03",
                "xai-2026-10-03",
                "moonshot-2026-10-03",
                "estimates-2026-10-05"
            ]
        );
        let seeds = seeds();
        assert_eq!(seeds.len(), 5);
        assert_eq!(sets[0].1.len(), 5);
        for seed in &seeds {
            validate(seed).unwrap();
            assert!(seed.source.contains("platform.claude.com"));
            assert_eq!(seed.effective_from, seed.checked_at);
        }
        // The renderer's resolution test reads the same rows.
        let vendors: Vec<CatalogEntry> = sets[1..4]
            .iter()
            .flat_map(|(_, entries)| entries.clone())
            .collect();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../src/features/benchmarks/__tests__/fixtures/catalog-seeds-2026-10-03.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(&vendors).unwrap(), fixture);
        let mut ids = std::collections::HashSet::new();
        for seed in &vendors {
            validate(seed).unwrap();
            assert!(ids.insert(seed.id.clone()), "{}", seed.id);
            assert!(seed.source.starts_with("https://"), "{}", seed.id);
            assert!(seed.provider_id.is_some(), "{}", seed.id);
            assert_eq!(seed.effective_from, seed.checked_at);
        }
        let mut broken = seeds[0].clone();
        broken.output_per_million = Some(-1.0);
        assert!(validate(&broken).is_err());
        broken.output_per_million = Some(1.0);
        broken.needle = " ".into();
        assert!(validate(&broken).is_err());
    }

    fn kimi(at: i64, input: f64) -> CatalogEntry {
        CatalogEntry {
            id: format!("kimi-{at}"),
            kind: "model".into(),
            provider_id: Some("kimi-acp".into()),
            needle: "kimi-code/k3".into(),
            display_name: None,
            vendor: None,
            input_per_million: Some(input),
            output_per_million: Some(15.0),
            cache_read_per_million: Some(0.3),
            cache_write_per_million: None,
            context_tokens: None,
            effective_from: at,
            checked_at: at,
            source: "https://example.test".into(),
            created_at: at,
        }
    }

    fn k3() -> Configuration {
        Configuration {
            id: "k3".into(),
            provider_id: "kimi-acp".into(),
            account_id: None,
            model_id: "kimi-code/k3".into(),
            effort: Some("low".into()),
            fast_mode: None,
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: None,
            model_name: Some("Kimi K3".into()),
        }
    }

    fn usage(input: u64, output: u64, cache_read: u64, cache_write: u64) -> TokenUsage {
        TokenUsage {
            input: Some(input),
            output: Some(output),
            cache_read: Some(cache_read),
            cache_write: Some(cache_write),
            reasoning: None,
            cost: None,
            schema: "provider_turn_usage_v1".into(),
        }
    }

    #[test]
    fn an_unreported_cost_is_the_tokens_at_the_prices_of_the_day() {
        let entries = [kimi(100, 3.0), kimi(200, 4.0)];
        let configuration = k3();
        // 1,000,000 input at $3, 100,000 output at $15, 10,000 cached at $0.30.
        let spent = usage(1_000_000, 100_000, 10_000, 0);
        let cost = attempt_cost(&entries, &configuration, &spent, Some(150)).unwrap();
        assert!((cost - (3.0 + 1.5 + 0.003)).abs() < 1e-9, "{cost}");
        // A later price applies only from its own date on.
        let later = attempt_cost(&entries, &configuration, &spent, Some(250)).unwrap();
        assert!((later - (4.0 + 1.5 + 0.003)).abs() < 1e-9, "{later}");
        // Before any price, after a price-less kind or without counts: unknown.
        assert_eq!(
            attempt_cost(&entries, &configuration, &spent, Some(50)),
            None
        );
        assert_eq!(attempt_cost(&entries, &configuration, &spent, None), None);
        assert_eq!(
            attempt_cost(&entries, &configuration, &usage(1, 1, 0, 5), Some(150)),
            None
        );
        let mut silent = spent.clone();
        silent.output = None;
        assert_eq!(
            attempt_cost(&entries, &configuration, &silent, Some(150)),
            None
        );
        // The list price prices every provider alike; the provider's own
        // figure counts only where no list price resolves.
        let mut reported = spent.clone();
        reported.cost = Some(0.42);
        let priced = attempt_cost(&entries, &configuration, &reported, Some(150)).unwrap();
        assert!((priced - (3.0 + 1.5 + 0.003)).abs() < 1e-9, "{priced}");
        assert_eq!(
            attempt_cost(&entries, &configuration, &reported, Some(50)),
            Some(0.42)
        );
        assert_eq!(
            attempt_cost(&entries, &configuration, &reported, None),
            Some(0.42)
        );
        let mut other = configuration.clone();
        other.provider_id = "grok-acp".into();
        assert_eq!(attempt_cost(&entries, &other, &spent, Some(150)), None);
    }

    /// An unpriced model resolves to its labelled estimate from the vendor
    /// seeds' date on, over the vendor row that left it unknown.
    #[test]
    fn unpriced_models_resolve_to_a_labelled_estimate() {
        let entries: Vec<CatalogEntry> = seed_sets()
            .into_iter()
            .flat_map(|(_, entries)| entries)
            .collect();
        let fast = Configuration {
            id: "grok".into(),
            provider_id: "grok-acp".into(),
            account_id: None,
            model_id: "grok-4.7-build-fast".into(),
            effort: Some("xhigh".into()),
            fast_mode: None,
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: None,
            model_name: Some("Grok 4.7 Fast".into()),
        };
        let entry = resolve(&entries, &fast, VENDOR_SEEDS_CHECKED_AT).unwrap();
        assert_eq!(entry.id, "seed-estimate-grok-4-7-build-fast");
        assert!(entry.source.starts_with("estimate:"));
        assert_eq!(entry.output_per_million, Some(6.0));
        let preview = Configuration {
            provider_id: "kimi-acp".into(),
            model_id: "kimi-code/kimi-for-coding".into(),
            model_name: Some("K2.8 Preview".into()),
            ..fast.clone()
        };
        let entry = resolve(&entries, &preview, ESTIMATES_CHECKED_AT).unwrap();
        assert_eq!(entry.id, "seed-estimate-kimi-k2-8-preview");
        // The highspeed row keeps its own published price.
        let highspeed = Configuration {
            model_id: "kimi-code/kimi-for-coding-highspeed".into(),
            model_name: Some("K2.7 Code Highspeed".into()),
            ..preview
        };
        let entry = resolve(&entries, &highspeed, ESTIMATES_CHECKED_AT).unwrap();
        assert_eq!(entry.id, "seed-moonshot-k2-7-code-highspeed");
        for seed in estimate_seeds() {
            validate(&seed).unwrap();
        }
    }
}
