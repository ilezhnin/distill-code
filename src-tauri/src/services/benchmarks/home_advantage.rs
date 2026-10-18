//! Home advantage: how an author's cells on the cases it wrote compare with
//! its cells on other authors' cases, each measured against the non-author
//! candidates on the same case. Read-only; it selects and starts nothing.
use super::{
    analysis,
    routing::{exact_authors, is_author},
    types::*,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Names every rule below; a changed rule is a new recipe.
pub const RECIPE: &str = "author-home-advantage-v1";
const BOOTSTRAP_SAMPLES: usize = 2_000;
const SEED: u64 = 0x484f_4d45;
const INTERVAL_MASS: f64 = 0.95;
/// Fewer independent task groups than this on either side give no interval.
const MIN_GROUPS: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeAdvantageReport {
    pub recipe: String,
    pub cutoff_at: Option<i64>,
    pub bootstrap_samples: usize,
    pub seed: u64,
    pub interval_mass: f64,
    pub authors: Vec<AuthorAdvantage>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorAdvantage {
    pub author: BenchmarkAuthor,
    /// Measured configurations of this author identity.
    pub candidate_keys: Vec<String>,
    /// Mean cell score: positive when the author leads non-authors by more
    /// on its own cases than on other authors' cases.
    pub quality: MetricAdvantage,
    /// Natural log of the median duration over the non-authors' geometric
    /// mean: negative when the author is relatively faster on its own cases.
    pub speed: MetricAdvantage,
    /// Natural log of the mean spend over the non-authors' geometric mean:
    /// negative when the author is relatively cheaper on its own cases.
    pub cost: MetricAdvantage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricAdvantage {
    /// `measured`, or `insufficient` below two task groups on either side.
    pub status: String,
    pub own: CaseSet,
    pub other: CaseSet,
    /// Relative value on own cases minus relative value on other authors' cases.
    pub difference: Option<f64>,
    pub interval: Option<Interval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseSet {
    pub cases: usize,
    pub groups: usize,
    /// Distinct non-author configurations the cases were compared with.
    pub comparators: usize,
    /// Mean relative value, each task group weighted equally.
    pub relative: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    pub lower: f64,
    pub upper: f64,
}

/// One configuration's complete cell on one case.
struct Cell {
    configuration: Configuration,
    quality: f64,
    duration_ms: Option<f64>,
    cost: Option<f64>,
}

/// One case's relative value for one metric.
struct Observation<'a> {
    group: &'a str,
    value: f64,
    comparators: Vec<&'a str>,
}

/// Normalized author identity, so aliases, context window variants and
/// letter case name one author.
fn identity(author: &BenchmarkAuthor) -> (String, String, Option<String>) {
    let normalize = |value: &str| value.trim().to_lowercase();
    let provider = normalize(&author.provider_id);
    let model = normalize(&author.model_id);
    let model = super::runner::model_identity(&provider, &model).unwrap_or(model);
    (provider, model, author.effort.as_deref().map(normalize))
}

fn mean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, count) = values.fold((0.0, 0usize), |(sum, count), v| (sum + v, count + 1));
    (count > 0).then(|| sum / count as f64)
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    match n {
        0 => None,
        _ if n % 2 == 1 => Some(values[n / 2]),
        _ => Some((values[n / 2 - 1] + values[n / 2]) / 2.0),
    }
}

/// The newest complete cell of every configuration on every pool case: the
/// mean score of its scored repetitions, their median duration and, when all
/// report it, their mean spend.
fn cells<'a>(
    data: &'a QueryData,
    pool: &[&'a BenchmarkVersion],
    cutoff: Option<i64>,
) -> BTreeMap<&'a str, BTreeMap<String, Cell>> {
    let runs: BTreeMap<&str, &BenchmarkRun> = data
        .runs
        .iter()
        .filter(|run| !run.request.preview && cutoff.is_none_or(|at| run.created_at <= at))
        .map(|run| (run.id.as_str(), run))
        .collect();
    let in_pool: BTreeSet<&str> = pool.iter().map(|v| v.id.as_str()).collect();
    let mut grouped: BTreeMap<(&str, String), (Configuration, Vec<&Attempt>)> = BTreeMap::new();
    for attempt in data
        .attempts
        .iter()
        .filter(|a| in_pool.contains(a.version_id.as_str()) && runs.contains_key(a.run_id.as_str()))
    {
        let configuration = analysis::execution_configuration(attempt);
        let key = analysis::leaderboard_key(&configuration);
        grouped
            .entry((attempt.version_id.as_str(), key))
            .or_insert_with(|| (configuration.into_owned(), Vec::new()))
            .1
            .push(attempt);
    }
    let mut result: BTreeMap<&str, BTreeMap<String, Cell>> = BTreeMap::new();
    for ((version_id, key), (configuration, list)) in grouped {
        let Some(version) = pool.iter().find(|v| v.id == version_id) else {
            continue;
        };
        let selected = analysis::latest_cell_attempts(&list, &runs, cutoff);
        let scored: Vec<(&Attempt, f64)> = selected
            .iter()
            .filter_map(|a| analysis::score_as_of(a, cutoff).map(|s| (*a, s)))
            .collect();
        if scored.is_empty()
            || (scored.len() as u32) < analysis::required_repetitions(data, version)
        {
            continue;
        }
        let costs: Option<Vec<f64>> = scored.iter().map(|(a, _)| a.usage.cost).collect();
        result.entry(version_id).or_default().insert(
            key,
            Cell {
                configuration,
                quality: mean(scored.iter().map(|(_, s)| *s)).unwrap_or_default(),
                duration_ms: median(
                    scored
                        .iter()
                        .filter_map(|(a, _)| a.duration_ms.map(|d| d as f64))
                        .collect(),
                ),
                cost: costs.and_then(|c| mean(c.into_iter())),
            },
        );
    }
    result
}

/// Mean over groups of the mean over each group's cases.
fn group_mean(observations: &[&Observation], groups: &[&str]) -> Option<f64> {
    mean(groups.iter().filter_map(|group| {
        mean(
            observations
                .iter()
                .filter(|o| o.group == *group)
                .map(|o| o.value),
        )
    }))
}

/// Fixed SplitMix64 stream, as the selector reports use.
struct Stream(u64);
impl Stream {
    fn index(&mut self, len: usize) -> usize {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^= z >> 31;
        ((u128::from(z) * len as u128) >> 64) as usize
    }
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    let at = q * (sorted.len() - 1) as f64;
    let (lo, hi) = (at.floor() as usize, at.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo as f64)
}

/// The distinct task groups of a case set.
fn groups<'a>(list: &[Observation<'a>]) -> Vec<&'a str> {
    list.iter()
        .map(|o| o.group)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn summarize(own: &[Observation], other: &[Observation]) -> MetricAdvantage {
    let (own_groups, other_groups) = (groups(own), groups(other));
    let own_refs: Vec<&Observation> = own.iter().collect();
    let other_refs: Vec<&Observation> = other.iter().collect();
    let set = |list: &[&Observation], groups: &[&str]| CaseSet {
        cases: list.len(),
        groups: groups.len(),
        comparators: list
            .iter()
            .flat_map(|o| o.comparators.iter().copied())
            .collect::<BTreeSet<_>>()
            .len(),
        relative: group_mean(list, groups),
    };
    let own_set = set(&own_refs, &own_groups);
    let other_set = set(&other_refs, &other_groups);
    let difference = own_set.relative.zip(other_set.relative).map(|(a, b)| a - b);
    let sufficient = own_groups.len() >= MIN_GROUPS && other_groups.len() >= MIN_GROUPS;
    // Groups are resampled whole and separately on each side, so related
    // variants of one task move together.
    let interval = (sufficient && difference.is_some()).then(|| {
        let mut stream = Stream(SEED);
        let mut draws = Vec::with_capacity(BOOTSTRAP_SAMPLES);
        for _ in 0..BOOTSTRAP_SAMPLES {
            let mut resample = |groups: &[&str], list: &[&Observation]| {
                mean((0..groups.len()).filter_map(|_| {
                    let group = groups[stream.index(groups.len())];
                    mean(list.iter().filter(|o| o.group == group).map(|o| o.value))
                }))
            };
            let a = resample(&own_groups, &own_refs);
            let b = resample(&other_groups, &other_refs);
            if let (Some(a), Some(b)) = (a, b) {
                draws.push(a - b);
            }
        }
        draws.sort_by(f64::total_cmp);
        let tail = (1.0 - INTERVAL_MASS) / 2.0;
        Interval {
            lower: quantile(&draws, tail),
            upper: quantile(&draws, 1.0 - tail),
        }
    });
    MetricAdvantage {
        status: if sufficient {
            "measured"
        } else {
            "insufficient"
        }
        .into(),
        own: own_set,
        other: other_set,
        difference,
        interval,
    }
}

/// The home advantage of every author identity the pool declares. A case
/// counts only where the author and at least one non-author candidate have
/// a complete cell; cases without a declared author belong to neither side.
pub fn report(data: &QueryData, cutoff: Option<i64>) -> HomeAdvantageReport {
    let pool = analysis::ranked_pool(
        data,
        &ResultQuery {
            as_of: cutoff,
            ..Default::default()
        },
    );
    let cells = cells(data, &pool, cutoff);
    let mut authors: BTreeMap<(String, String, Option<String>), BenchmarkAuthor> = BTreeMap::new();
    for version in &pool {
        for author in exact_authors(&version.manifest) {
            authors.entry(identity(&author)).or_insert(author);
        }
    }
    let mut result = Vec::new();
    for author in authors.into_values() {
        let mut keys = BTreeSet::new();
        let mut quality: (Vec<Observation>, Vec<Observation>) = Default::default();
        let mut speed: (Vec<Observation>, Vec<Observation>) = Default::default();
        let mut cost: (Vec<Observation>, Vec<Observation>) = Default::default();
        for version in &pool {
            let declared = exact_authors(&version.manifest);
            if declared.is_empty() {
                continue;
            }
            let Some(case) = cells.get(version.id.as_str()) else {
                continue;
            };
            let own = declared.iter().any(|a| identity(a) == identity(&author));
            let mine: Vec<(&String, &Cell)> = case
                .iter()
                .filter(|(_, cell)| is_author(&author, &cell.configuration))
                .collect();
            let others: Vec<(&String, &Cell)> = case
                .iter()
                .filter(|(_, cell)| {
                    !is_author(&author, &cell.configuration)
                        && !declared.iter().any(|a| is_author(a, &cell.configuration))
                })
                .collect();
            if mine.is_empty() || others.is_empty() {
                continue;
            }
            keys.extend(mine.iter().map(|(key, _)| (*key).clone()));
            let group = super::export::split_group(&version.manifest);
            let relative = |value: &dyn Fn(&Cell) -> Option<f64>| {
                let subject = mean(mine.iter().filter_map(|(_, cell)| value(cell)))?;
                let compared: Vec<(&str, f64)> = others
                    .iter()
                    .filter_map(|(key, cell)| value(cell).map(|v| (key.as_str(), v)))
                    .collect();
                let baseline = mean(compared.iter().map(|(_, v)| *v))?;
                Some(Observation {
                    group,
                    value: subject - baseline,
                    comparators: compared.iter().map(|(key, _)| *key).collect(),
                })
            };
            // Durations and spend compare as logarithms: a ratio, so a long
            // case does not outweigh a short one.
            let log = |value: Option<f64>| value.filter(|v| *v > 0.0).map(f64::ln);
            for (pair, observation) in [
                (&mut quality, relative(&|cell| Some(cell.quality))),
                (&mut speed, relative(&|cell| log(cell.duration_ms))),
                (&mut cost, relative(&|cell| log(cell.cost))),
            ] {
                if let Some(observation) = observation {
                    if own {
                        pair.0.push(observation);
                    } else {
                        pair.1.push(observation);
                    }
                }
            }
        }
        result.push(AuthorAdvantage {
            author,
            candidate_keys: keys.into_iter().collect(),
            quality: summarize(&quality.0, &quality.1),
            speed: summarize(&speed.0, &speed.1),
            cost: summarize(&cost.0, &cost.1),
        });
    }
    HomeAdvantageReport {
        recipe: RECIPE.into(),
        cutoff_at: cutoff,
        bootstrap_samples: BOOTSTRAP_SAMPLES,
        seed: SEED,
        interval_mass: INTERVAL_MASS,
        authors: result,
        limitations: vec![
            "Comparator sets differ between a case set and the other: each case is compared with the candidates that did not write it".into(),
            "Quality is the mean score of a cell's repetitions; durations and spend include unsolved cells".into(),
            "Percentile intervals over whole task groups are exploratory and not adjusted for multiple comparisons".into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn configuration(model: &str) -> Configuration {
        let mut c = super::super::analysis::tests::dataset().runs[0]
            .request
            .configurations[0]
            .clone();
        c.id = format!("claude:private-account:{model}");
        c.model_id = model.into();
        c
    }

    /// Two cases the author wrote, two another author wrote, two nobody
    /// claims; one peer measured everywhere.
    fn measured() -> QueryData {
        let mut data = super::super::analysis::tests::dataset();
        let author = configuration("model");
        let peer = configuration("peer");
        let template = data.attempts[0].clone();
        data.attempts.clear();
        data.runs.truncate(1);
        data.runs[0].request.configurations = vec![author.clone(), peer.clone()];
        for (index, version) in data.versions.iter_mut().enumerate() {
            version.manifest.environment["authoredBy"] = match index {
                0 | 1 => json!([BenchmarkAuthor::from(&author)]),
                2 | 3 => json!([BenchmarkAuthor::from(&configuration("third"))]),
                _ => json!([]),
            };
        }
        for (index, version) in data.versions.iter().enumerate() {
            let own = index < 2;
            let cells = [
                (
                    &author,
                    own,
                    if own { 50 } else { 100 },
                    if own { 1.0 } else { 2.0 },
                ),
                (&peer, false, 100, 2.0),
            ];
            for (configuration, pass, duration, cost) in cells {
                let mut a = template.clone();
                a.id = format!("{}-{}", configuration.model_id, version.id);
                a.run_id = "before".into();
                a.version_id = version.id.clone();
                a.configuration = configuration.clone();
                a.observed = Some(configuration.clone());
                a.outcome = Some(if pass { "pass" } else { "fail" }.into());
                a.duration_ms = Some(duration);
                a.usage.cost = Some(cost);
                data.attempts.push(a);
            }
        }
        data
    }

    #[test]
    fn an_author_that_leads_only_on_its_own_cases_shows_a_home_advantage() {
        let report = report(&measured(), None);
        assert_eq!(report.recipe, RECIPE);
        let author = report
            .authors
            .iter()
            .find(|a| a.author.model_id == "model")
            .unwrap();
        assert_eq!(author.candidate_keys.len(), 1);
        let quality = &author.quality;
        assert_eq!(quality.status, "measured");
        assert_eq!((quality.own.cases, quality.other.cases), (2, 2));
        assert_eq!((quality.own.groups, quality.own.comparators), (2, 1));
        assert_eq!(
            (quality.own.relative, quality.other.relative),
            (Some(1.0), Some(0.0))
        );
        assert_eq!(quality.difference, Some(1.0));
        assert_eq!(
            quality.interval,
            Some(Interval {
                lower: 1.0,
                upper: 1.0
            })
        );
        let half = 0.5f64.ln();
        assert!((author.speed.difference.unwrap() - half).abs() < 1e-12);
        assert!((author.cost.difference.unwrap() - half).abs() < 1e-12);
        // An author with no measured cell has nothing to compare.
        let third = report
            .authors
            .iter()
            .find(|a| a.author.model_id == "third")
            .unwrap();
        assert_eq!(third.quality.status, "insufficient");
        assert_eq!(third.quality.difference, None);
        assert_eq!(third.quality.interval, None);
    }

    #[test]
    fn one_task_group_gives_an_estimate_without_an_interval() {
        let mut data = measured();
        // Both own cases become variants of one task group.
        for version in data.versions.iter_mut().take(2) {
            version.manifest.environment["splitGroup"] = json!("one-group");
        }
        let report = report(&data, None);
        let author = report
            .authors
            .iter()
            .find(|a| a.author.model_id == "model")
            .unwrap();
        assert_eq!(author.quality.status, "insufficient");
        assert_eq!(author.quality.own.groups, 1);
        assert_eq!(author.quality.difference, Some(1.0));
        assert_eq!(author.quality.interval, None);
    }
}
