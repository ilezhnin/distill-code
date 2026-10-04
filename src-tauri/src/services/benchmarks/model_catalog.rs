//! Effective-dated model facts: vendor list prices, context size and display
//! overrides. Measurements never store these; a report resolves the entry that
//! applied when the measurement was taken, so a later price change adds an
//! entry instead of rewriting history.
use super::types::CatalogEntry;

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

/// The seed sets in the order they shipped, by id. A store adds each set once.
pub fn seed_sets() -> Vec<(&'static str, Vec<CatalogEntry>)> {
    vec![
        ("anthropic-2026-10-02", seeds()),
        ("openai-2026-10-03", openai_seeds()),
        ("xai-2026-10-03", xai_seeds()),
        ("moonshot-2026-10-03", moonshot_seeds()),
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
                "moonshot-2026-10-03"
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
        let vendors: Vec<CatalogEntry> = sets[1..]
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
}
