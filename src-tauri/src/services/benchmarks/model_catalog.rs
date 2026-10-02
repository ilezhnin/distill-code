//! Effective-dated model facts: vendor list prices, context size and display
//! overrides. Measurements never store these; a report resolves the entry that
//! applied when the measurement was taken, so a later price change adds an
//! entry instead of rewriting history.
use super::types::CatalogEntry;

pub const ANTHROPIC_PRICING: &str = "https://platform.claude.com/docs/en/about-claude/pricing";
pub const ANTHROPIC_MODELS: &str = "https://platform.claude.com/docs/en/models/overview";

/// 2026-10-02T12:00:00Z: the day the seed sources were read, at noon so every
/// time zone shows the same date.
const SEED_CHECKED_AT: i64 = 1_790_942_400_000;

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
pub fn seeds() -> Vec<CatalogEntry> {
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
    fn seeds_validate_and_name_their_source() {
        let seeds = seeds();
        assert_eq!(seeds.len(), 5);
        for seed in &seeds {
            validate(seed).unwrap();
            assert!(seed.source.contains("platform.claude.com"));
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
