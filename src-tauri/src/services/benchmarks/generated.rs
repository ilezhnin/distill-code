//! Parametrized seed families. A variant is derived from a numeric seed by a
//! deterministic generator that also computes the expected answer, so a
//! candidate cannot pass by recalling a published instance. The family keeps
//! the authored seed as its metadata source; only the data changes.
use super::types::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const FAMILIES: [&str; 3] = [
    "seed-rule-ordered-classification",
    "seed-constrained-option-choice",
    "seed-two-worker-schedule",
];

/// splitmix64-seeded xorshift64*; small consecutive seeds must not produce
/// correlated draws, and only the high bits of the output are used.
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Self((z ^ (z >> 31)) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        (self.next() >> 33) % n.max(1)
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

struct Variant {
    prompt: String,
    fixtures: Vec<Fixture>,
    expected: Value,
    known_bad: Value,
}

fn classification(rng: &mut Rng) -> Variant {
    const RULES: [(&str, [&str; 3]); 4] = [
        (
            "outage",
            [
                "the dashboard has been unreachable since this morning",
                "the API is down for everyone on my team",
                "the sync service went down after the update",
            ],
        ),
        (
            "billing",
            [
                "I was charged twice this month",
                "please refund the duplicate charge from Monday",
                "the invoice lists a charge I do not recognize",
            ],
        ),
        (
            "access",
            [
                "I cannot log in after changing my password",
                "my password reset email never arrived",
                "login works only on the second attempt",
            ],
        ),
        (
            "other",
            [
                "can you add a dark theme to the editor",
                "the font in the sidebar is too small",
                "please let me rename a project from the list",
            ],
        ),
    ];
    loop {
        let mut lines = Vec::new();
        let mut labels = Vec::new();
        let mut seen = [false; 4];
        for index in 0..6 {
            let first = rng.below(4) as usize;
            let mut parts = vec![*rng.pick(&RULES[first].1)];
            let mut label = first;
            if rng.below(2) == 1 {
                let second = (first + 1 + rng.below(3) as usize) % 4;
                parts.push(*rng.pick(&RULES[second].1));
                label = label.min(second);
                if rng.below(2) == 1 {
                    parts.reverse();
                }
            }
            seen[label] = true;
            labels.push(RULES[label].0);
            lines.push(format!(
                "T{}: {}.",
                index + 1,
                capitalize(&parts.join(", and "))
            ));
        }
        let mixed = lines.iter().filter(|line| line.contains(", and ")).count();
        if seen.iter().all(|s| *s) && mixed >= 2 {
            let mut bad: Vec<&str> = labels.clone();
            let index = lines
                .iter()
                .position(|line| line.contains(", and "))
                .unwrap_or(0);
            bad[index] = if labels[index] == "other" {
                "access"
            } else {
                "other"
            };
            return Variant {
                prompt: "Classify every support ticket in the public fixture using exactly these rules, applied in priority order so the first matching rule wins: 1) outage when the text says a service is down or unreachable; 2) billing when the text asks for a refund or mentions a charge; 3) access when the text mentions a password or login; 4) other. Return only a JSON array of category strings in ticket order.".into(),
                fixtures: vec![Fixture { path: "tickets.txt".into(), content: lines.join("\n") }],
                expected: json!(labels),
                known_bad: json!(bad),
            };
        }
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn option_choice(rng: &mut Rng) -> Variant {
    const RISKS: [&str; 3] = ["low", "medium", "high"];
    loop {
        let max_cost = 10 + rng.below(4);
        let max_hours = 4 + rng.below(4);
        let options: Vec<(char, u64, u64, &str)> = "ABCDEF"
            .chars()
            .map(|name| (name, 5 + rng.below(10), 2 + rng.below(7), *rng.pick(&RISKS)))
            .collect();
        let mut feasible: Vec<_> = options
            .iter()
            .filter(|(_, cost, hours, risk)| {
                *cost <= max_cost && *hours <= max_hours && *risk != "high"
            })
            .collect();
        feasible.sort_by_key(|(_, cost, hours, _)| (*cost, *hours));
        let unique_winner = feasible.len() >= 2
            && feasible.len() < options.len()
            && (feasible[0].1, feasible[0].2) != (feasible[1].1, feasible[1].2);
        if !unique_winner {
            continue;
        }
        let winner = feasible[0];
        let runner_up = feasible[1];
        let lines: Vec<String> = options
            .iter()
            .map(|(name, cost, hours, risk)| {
                format!("{name}: cost {cost}, {hours} hours, risk {risk}")
            })
            .collect();
        return Variant {
            prompt: format!(
                "Choose the option from the public fixture that satisfies every constraint: cost at most {max_cost}, duration at most {max_hours} hours, and risk not high. If several options remain, pick the lowest cost; break a remaining tie by the shortest duration. Return only JSON {{\"option\":string,\"cost\":number,\"hours\":number}}."
            ),
            fixtures: vec![Fixture { path: "options.txt".into(), content: lines.join("\n") }],
            expected: json!({"option": winner.0.to_string(), "cost": winner.1, "hours": winner.2}),
            known_bad: json!({"option": runner_up.0.to_string(), "cost": runner_up.1, "hours": runner_up.2}),
        };
    }
}

/// List scheduling on two workers: a free worker takes the alphabetically
/// smallest ready task and never idles while a task is ready.
pub fn list_schedule(
    durations: &BTreeMap<char, u64>,
    dependencies: &BTreeMap<char, Vec<char>>,
) -> (u64, BTreeMap<char, u64>) {
    let mut start: BTreeMap<char, u64> = BTreeMap::new();
    let mut finish: BTreeMap<char, u64> = BTreeMap::new();
    let mut free = [0u64; 2];
    let mut time = 0u64;
    while start.len() < durations.len() {
        let ready: Vec<char> = durations
            .keys()
            .copied()
            .filter(|task| {
                !start.contains_key(task)
                    && dependencies
                        .get(task)
                        .into_iter()
                        .flatten()
                        .all(|dependency| finish.get(dependency).is_some_and(|end| *end <= time))
            })
            .collect();
        let idle = free.iter().position(|busy_until| *busy_until <= time);
        match (ready.first(), idle) {
            (Some(task), Some(worker)) => {
                start.insert(*task, time);
                finish.insert(*task, time + durations[task]);
                free[worker] = time + durations[task];
            }
            _ => {
                time = finish
                    .values()
                    .copied()
                    .filter(|end| *end > time)
                    .min()
                    .expect("a running task always ends later");
            }
        }
    }
    (finish.values().copied().max().unwrap_or(0), start)
}

fn two_worker_schedule(rng: &mut Rng) -> Variant {
    let names: Vec<char> = "ABCDEF".chars().collect();
    loop {
        let durations: BTreeMap<char, u64> =
            names.iter().map(|name| (*name, 1 + rng.below(4))).collect();
        let mut dependencies: BTreeMap<char, Vec<char>> = BTreeMap::new();
        for (index, name) in names.iter().enumerate().skip(1) {
            if rng.below(2) == 1 {
                let before = names[rng.below(index as u64) as usize];
                dependencies.entry(*name).or_default().push(before);
            }
            if index >= 3 && rng.below(3) == 0 {
                let before = names[rng.below(index as u64) as usize];
                let entry = dependencies.entry(*name).or_default();
                if !entry.contains(&before) {
                    entry.push(before);
                }
            }
        }
        let edges: usize = dependencies.values().map(Vec::len).sum();
        if !(3..=5).contains(&edges) {
            continue;
        }
        let (finish, start) = list_schedule(&durations, &dependencies);
        let sequential: u64 = durations.values().sum();
        if finish == sequential {
            continue;
        }
        let duration_text = durations
            .iter()
            .map(|(name, hours)| format!("{name} {hours}"))
            .collect::<Vec<_>>()
            .join(", ");
        let dependency_text = dependencies
            .iter()
            .map(|(name, before)| {
                let list = before
                    .iter()
                    .map(char::to_string)
                    .collect::<Vec<_>>()
                    .join(" and ");
                format!("{name} after {list}")
            })
            .collect::<Vec<_>>()
            .join("; ");
        let start_json: BTreeMap<String, u64> = start
            .iter()
            .map(|(name, at)| (name.to_string(), *at))
            .collect();
        let mut bad = start_json.clone();
        if let Some(last) = start
            .iter()
            .max_by_key(|(_, at)| **at)
            .map(|(name, _)| name)
        {
            bad.insert(last.to_string(), start[last] + 1);
        }
        return Variant {
            prompt: format!(
                "Schedule tasks on exactly two workers using list scheduling: whenever a worker is free it takes the ready task (all dependencies finished) with the alphabetically smallest name, and a worker never idles while a task is ready. Tasks and durations in hours: {duration_text}. Dependencies: {dependency_text}. Work starts at hour 0. Return only JSON {{\"finish\":number,\"start\":{{\"A\":number,\"B\":number,\"C\":number,\"D\":number,\"E\":number,\"F\":number}}}}."
            ),
            fixtures: Vec::new(),
            expected: json!({"finish": finish, "start": start_json}),
            known_bad: json!({"finish": finish + 1, "start": bad}),
        };
    }
}

/// Derive a new draft of `family` from `seed`. Seed zero is the authored instance.
pub fn generate(family: &str, seed: u64) -> Result<BenchmarkDraft> {
    let mut draft = super::seeds::definitions()
        .into_iter()
        .find(|d| d.task_family == family)
        .ok_or_else(|| BenchmarkError::new("validation", "Unknown generated family"))?;
    if seed == 0 {
        return Ok(draft);
    }
    let mut rng = Rng::new(seed);
    let variant = match family {
        "seed-rule-ordered-classification" => classification(&mut rng),
        "seed-constrained-option-choice" => option_choice(&mut rng),
        "seed-two-worker-schedule" => two_worker_schedule(&mut rng),
        _ => {
            return Err(BenchmarkError::new(
                "validation",
                "Family has no variant generator",
            ))
        }
    };
    draft.name = format!("{} (variant {seed})", draft.name);
    draft.prompt = variant.prompt;
    draft.fixtures = variant.fixtures;
    draft.evaluator.expected = variant.expected.to_string();
    draft.evaluator.known_good = variant.expected.to_string();
    draft.evaluator.known_bad = variant.known_bad.to_string();
    draft.environment["generator"] = json!({"family": family, "seed": seed});
    super::routing::normalize_draft(&mut draft);
    Ok(draft)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variants_are_deterministic_valid_and_distinct_from_the_authored_instance() {
        for family in FAMILIES {
            let authored = generate(family, 0).unwrap();
            assert_eq!(authored.environment["generator"]["seed"], 0);
            let mut prompts = std::collections::BTreeSet::new();
            for seed in 1..=40u64 {
                let draft = generate(family, seed).unwrap();
                assert_eq!(
                    serde_json::to_value(&draft).unwrap(),
                    serde_json::to_value(generate(family, seed).unwrap()).unwrap(),
                    "{family} seed {seed} must be deterministic"
                );
                let report = super::super::catalog::validate(&draft);
                assert!(report.valid, "{family} seed {seed}: {:?}", report.issues);
                assert_ne!(draft.evaluator.expected, draft.evaluator.known_bad);
                assert_ne!(draft.evaluator.expected, authored.evaluator.expected);
                assert_eq!(draft.task_family, family);
                assert_eq!(draft.environment["generator"]["seed"], seed);
                prompts.insert(format!("{}{:?}", draft.prompt, draft.fixtures));
            }
            assert!(prompts.len() >= 30, "{family} variants must differ");
        }
    }

    #[test]
    fn option_variants_agree_with_a_brute_force_check() {
        for seed in 1..=60u64 {
            let draft = generate("seed-constrained-option-choice", seed).unwrap();
            let expected: Value = serde_json::from_str(&draft.evaluator.expected).unwrap();
            let max_cost: u64 = draft
                .prompt
                .split("cost at most ")
                .nth(1)
                .unwrap()
                .split(',')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            let max_hours: u64 = draft
                .prompt
                .split("duration at most ")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            let mut feasible: Vec<(u64, u64, String)> = draft.fixtures[0]
                .content
                .lines()
                .filter_map(|line| {
                    let (name, rest) = line.split_once(": cost ")?;
                    let (cost, rest) = rest.split_once(", ")?;
                    let (hours, risk) = rest.split_once(" hours, risk ")?;
                    let (cost, hours) = (cost.parse::<u64>().ok()?, hours.parse::<u64>().ok()?);
                    (cost <= max_cost && hours <= max_hours && risk != "high")
                        .then(|| (cost, hours, name.to_string()))
                })
                .collect();
            feasible.sort();
            assert_eq!(expected["option"], feasible[0].2, "seed {seed}");
            assert_eq!(expected["cost"], feasible[0].0);
            assert_eq!(expected["hours"], feasible[0].1);
        }
    }

    #[test]
    fn schedule_variants_respect_dependencies_and_worker_limits() {
        assert_eq!(
            list_schedule(
                &"ABCDEF".chars().zip([3, 2, 4, 1, 2, 3]).collect(),
                &[
                    ('C', vec!['A']),
                    ('D', vec!['B']),
                    ('E', vec!['B', 'C']),
                    ('F', vec!['D'])
                ]
                .into_iter()
                .collect(),
            ),
            (9, "ABCDEF".chars().zip([0, 0, 3, 2, 7, 3]).collect())
        );
        for seed in 1..=60u64 {
            let draft = generate("seed-two-worker-schedule", seed).unwrap();
            let expected: Value = serde_json::from_str(&draft.evaluator.expected).unwrap();
            let durations: BTreeMap<char, u64> = draft
                .prompt
                .split("in hours: ")
                .nth(1)
                .unwrap()
                .split('.')
                .next()
                .unwrap()
                .split(", ")
                .map(|pair| {
                    let (name, hours) = pair.split_once(' ').unwrap();
                    (name.chars().next().unwrap(), hours.parse().unwrap())
                })
                .collect();
            let dependencies: BTreeMap<char, Vec<char>> = draft
                .prompt
                .split("Dependencies: ")
                .nth(1)
                .unwrap()
                .split(". Work starts")
                .next()
                .unwrap()
                .split("; ")
                .map(|clause| {
                    let (name, before) = clause.split_once(" after ").unwrap();
                    (
                        name.chars().next().unwrap(),
                        before
                            .split(" and ")
                            .map(|b| b.chars().next().unwrap())
                            .collect(),
                    )
                })
                .collect();
            let starts: BTreeMap<char, u64> = expected["start"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, at)| (name.chars().next().unwrap(), at.as_u64().unwrap()))
                .collect();
            let mut busy: Vec<(u64, u64)> = Vec::new();
            for (task, at) in &starts {
                for dependency in dependencies.get(task).into_iter().flatten() {
                    assert!(
                        starts[dependency] + durations[dependency] <= *at,
                        "seed {seed}: {task} before {dependency}"
                    );
                }
                busy.push((*at, *at + durations[task]));
            }
            for t in 0..expected["finish"].as_u64().unwrap() {
                assert!(
                    busy.iter().filter(|(s, e)| *s <= t && t < *e).count() <= 2,
                    "seed {seed}: three tasks at {t}"
                );
            }
            assert_eq!(
                expected["finish"].as_u64().unwrap(),
                busy.iter().map(|(_, e)| *e).max().unwrap()
            );
        }
    }
}
