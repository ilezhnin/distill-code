//! Share scoring for a JavaScript check whose answer is a test suite.
//!
//! Each protected case hands the answer's function a bundle of
//! implementations and expects one verdict per implementation, `"accept"` for
//! a correct one and `"reject"` for a defective one. A suite that fails to
//! accept a correct implementation scores 0; otherwise it scores the share of
//! defective implementations it rejects, and passes only when it rejects all.
//!
//! The pinned browser worker reports one boolean per case and is left as it
//! is: editing it would change the renderer revision every browser, JavaScript
//! and visually judged case is bound to. The controller instead asks the same
//! question once per implementation position. Pass `p` sends every bundle that
//! has a position `p` through [`ADAPTER`], which calls the answer's function on
//! the unchanged inputs and returns only the verdict at `p`; the worker
//! compares it with the expected verdict at `p`, as it compares any result.
//!
//! This file depends on `serde_json` alone, so an offline replay can compile
//! it as it stands.
use serde_json::{json, Value};

/// The `scoring` a protected JavaScript specification declares for this rule.
pub const SCORING: &str = "mutation-share";
/// The controller's function in the answer's realm. It never sees an expected
/// verdict: those stay with the worker's own comparison.
pub const ADAPTER: &str = "__flockVerdictAt";
/// Passes one evaluation may take: the most implementations one bundle holds.
pub const MAX_POSITIONS: usize = 16;

const ACCEPT: &str = "accept";
const REJECT: &str = "reject";
/// Arguments the adapter takes before the bundle's own: position and count.
const ADAPTER_ARGUMENTS: u64 = 2;

struct Case {
    args: Vec<Value>,
    /// One entry per implementation: whether it is a correct one.
    correct: Vec<bool>,
}

/// A share-scored specification, read once.
pub struct Plan {
    function: String,
    immutable: Vec<u64>,
    cases: Vec<Case>,
}

/// What the suite said of one implementation.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub case: usize,
    pub position: usize,
    pub correct: bool,
    /// The suite's verdict was the expected one.
    pub matched: bool,
    /// The suite's function threw, or the worker recorded no result.
    pub threw: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub correct_total: usize,
    pub correct_accepted: usize,
    pub defect_total: usize,
    pub defects_caught: usize,
    pub implementations: Vec<Verdict>,
}

impl Plan {
    /// `None` for a specification that declares no scoring: the worker's own
    /// all-cases verdict applies to it, unchanged.
    pub fn parse(spec: &Value) -> Result<Option<Self>, String> {
        match spec.get("scoring") {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::String(scoring)) if scoring == SCORING => {}
            Some(_) => return Err(format!("JavaScript scoring must be \"{SCORING}\" when set")),
        }
        let function = spec["functionName"]
            .as_str()
            .filter(|name| identifier(name) && *name != ADAPTER)
            .ok_or("Share scoring requires a valid functionName")?
            .to_owned();
        let listed = spec["argsCases"]
            .as_array()
            .filter(|cases| (1..=100).contains(&cases.len()))
            .ok_or("Share scoring requires 1-100 argsCases")?;
        let mut cases = Vec::with_capacity(listed.len());
        for (index, case) in listed.iter().enumerate() {
            let invalid = || {
                format!(
                    "Share scoring case {} requires an args array and 1-{MAX_POSITIONS} expected verdicts, each \"{ACCEPT}\" or \"{REJECT}\"",
                    index + 1
                )
            };
            let args = case["args"].as_array().ok_or_else(invalid)?.clone();
            let expected = case["expected"]
                .as_array()
                .filter(|expected| (1..=MAX_POSITIONS).contains(&expected.len()))
                .ok_or_else(invalid)?;
            let correct = expected
                .iter()
                .map(|verdict| match verdict.as_str() {
                    Some(ACCEPT) => Some(true),
                    Some(REJECT) => Some(false),
                    _ => None,
                })
                .collect::<Option<Vec<bool>>>()
                .ok_or_else(invalid)?;
            cases.push(Case { args, correct });
        }
        let implementations = || cases.iter().flat_map(|case| case.correct.iter());
        if !implementations().any(|correct| *correct) || implementations().all(|correct| *correct) {
            return Err(
                "Share scoring requires at least one correct and one defective implementation"
                    .into(),
            );
        }
        let immutable = match spec.get("immutableArgs").filter(|value| !value.is_null()) {
            None => Vec::new(),
            Some(indices) => indices
                .as_array()
                .and_then(|indices| {
                    indices
                        .iter()
                        .map(|index| {
                            index
                                .as_f64()
                                .filter(|index| *index >= 0.0 && index.fract() == 0.0)
                                .map(|index| index as u64)
                        })
                        .collect::<Option<Vec<u64>>>()
                })
                .ok_or("immutableArgs must be an array of argument indices")?,
        };
        Ok(Some(Self {
            function,
            immutable,
            cases,
        }))
    }

    /// How many times the worker is asked: once per implementation position.
    pub fn passes(&self) -> usize {
        self.cases
            .iter()
            .map(|case| case.correct.len())
            .max()
            .unwrap_or(0)
    }

    /// The answer with the controller's adapter after it. The adapter calls
    /// the answer's function on the bundle's own inputs and returns the
    /// verdict at one position, or `null` for a result that is not one
    /// verdict per implementation.
    pub fn source(&self, output: &str) -> String {
        format!(
            "{output}\n;async function {ADAPTER}(position, count, ...inputs) {{\n  const verdicts = await {}(...inputs);\n  if (!Array.isArray(verdicts) || verdicts.length !== count) return null;\n  const verdict = verdicts[position];\n  return typeof verdict === \"string\" ? verdict : null;\n}}",
            self.function
        )
    }

    /// The bytes [`Plan::source`] adds to an answer.
    pub fn source_overhead(&self) -> usize {
        self.source("").len()
    }

    /// The cases pass `position` asks about, in the order of its checks.
    fn asked(&self, position: usize) -> impl Iterator<Item = (usize, &Case)> {
        self.cases
            .iter()
            .enumerate()
            .filter(move |(_, case)| case.correct.len() > position)
    }

    /// The worker specification of pass `position`: every bundle that has
    /// that position, its inputs unchanged after the adapter's two arguments.
    pub fn pass_spec(&self, position: usize) -> Value {
        let cases: Vec<Value> = self
            .asked(position)
            .map(|(_, case)| {
                let mut args = vec![json!(position), json!(case.correct.len())];
                args.extend(case.args.iter().cloned());
                json!({
                    "args": args,
                    "expected": if case.correct[position] { ACCEPT } else { REJECT },
                })
            })
            .collect();
        let mut spec = json!({"functionName": ADAPTER, "argsCases": cases});
        if !self.immutable.is_empty() {
            spec["immutableArgs"] = json!(self
                .immutable
                .iter()
                .map(|index| index + ADAPTER_ARGUMENTS)
                .collect::<Vec<u64>>());
        }
        spec
    }

    /// Reads the worker's results, one per pass in order, into verdicts. A
    /// check the worker did not report counts as a verdict that did not match.
    pub fn outcome(&self, results: &[Value]) -> Outcome {
        let mut implementations = Vec::new();
        for (index, case) in self.cases.iter().enumerate() {
            for (position, correct) in case.correct.iter().enumerate() {
                // This case's place among the checks of its pass.
                let place = self
                    .asked(position)
                    .position(|(asked, _)| asked == index)
                    .unwrap_or(usize::MAX);
                let check = results
                    .get(position)
                    .and_then(|result| result["checks"].as_array())
                    .and_then(|checks| {
                        checks
                            .iter()
                            .find(|check| check["index"].as_u64() == Some(place as u64))
                    });
                implementations.push(Verdict {
                    case: index,
                    position,
                    correct: *correct,
                    matched: check.is_some_and(|check| check["pass"] == true),
                    threw: check.is_none_or(|check| check.get("outputMatches").is_none()),
                });
            }
        }
        let count = |correct: bool, matched: bool| {
            implementations
                .iter()
                .filter(|verdict| verdict.correct == correct && (verdict.matched || !matched))
                .count()
        };
        Outcome {
            correct_total: count(true, false),
            correct_accepted: count(true, true),
            defect_total: count(false, false),
            defects_caught: count(false, true),
            implementations,
        }
    }
}

impl Outcome {
    /// 0 when a correct implementation was not accepted; otherwise the share
    /// of defective implementations rejected.
    pub fn score(&self) -> f64 {
        if self.correct_accepted < self.correct_total || self.defect_total == 0 {
            0.0
        } else {
            self.defects_caught as f64 / self.defect_total as f64
        }
    }

    pub fn passed(&self) -> bool {
        self.correct_accepted == self.correct_total
            && self.defect_total > 0
            && self.defects_caught == self.defect_total
    }

    /// The counts and one entry per implementation, as evidence records them.
    pub fn details(&self) -> Value {
        json!({
            "scoring": SCORING,
            "correctAccepted": self.correct_accepted,
            "correctTotal": self.correct_total,
            "defectsCaught": self.defects_caught,
            "defectTotal": self.defect_total,
            "implementations": self.implementations.iter().map(|verdict| {
                let mut entry = json!({
                    "case": verdict.case,
                    "position": verdict.position,
                    "expected": if verdict.correct { ACCEPT } else { REJECT },
                    "matched": verdict.matched,
                });
                if verdict.threw {
                    entry["threw"] = json!(true);
                }
                entry
            }).collect::<Vec<Value>>(),
        })
    }

    pub fn summary(&self) -> String {
        format!(
            "accepted {}/{} correct implementations, caught {}/{} defective ones",
            self.correct_accepted, self.correct_total, self.defects_caught, self.defect_total
        )
    }
}

fn identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_' || first == b'$')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
}

/// The worker's JavaScript branch for an invented suite, so tests can follow
/// a share evaluation without a browser: `suite` stands for the answer's
/// function, and returns `None` where it throws.
#[cfg(test)]
pub(crate) fn simulated_worker(spec: &Value, suite: &dyn Fn(&[Value]) -> Option<Value>) -> Value {
    let adapted = spec["functionName"] == ADAPTER;
    let checks: Vec<Value> = spec["argsCases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, case)| {
            let args = case["args"].as_array().unwrap();
            let result = if adapted {
                let position = args[0].as_u64().unwrap() as usize;
                let count = args[1].as_u64().unwrap() as usize;
                suite(&args[2..]).map(|verdicts| match verdicts.as_array() {
                    Some(verdicts) if verdicts.len() == count => match &verdicts[position] {
                        Value::String(verdict) => json!(verdict),
                        _ => Value::Null,
                    },
                    _ => Value::Null,
                })
            } else {
                suite(args)
            };
            match result {
                Some(result) => {
                    let matches = result == case["expected"];
                    json!({"index": index, "pass": matches, "outputMatches": matches, "inputsPreserved": true})
                }
                None => json!({"index": index, "pass": false}),
            }
        })
        .collect();
    json!({"pass": checks.iter().all(|check| check["pass"] == true), "checks": checks, "browserVersion": "invented"})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three invented bundles: 2 correct and 5 defective implementations.
    /// Each implementation is a word; a suite here reads the words.
    fn spec() -> Value {
        json!({
            "functionName": "gradeImplementations",
            "scoring": SCORING,
            "argsCases": [
                {"args": [["sound", "leaky", "stale"]], "expected": ["accept", "reject", "reject"]},
                {"args": [["torn", "sound", "late", "lossy"]], "expected": ["reject", "accept", "reject", "reject"]},
                {"args": [["crashing"]], "expected": ["reject"]},
            ],
        })
    }

    /// A suite that rejects exactly the listed words; it throws on a bundle
    /// holding a word in `throws`.
    fn suite<'a>(
        rejects: &'a [&'a str],
        throws: &'a [&'a str],
    ) -> impl Fn(&[Value]) -> Option<Value> + 'a {
        move |args: &[Value]| {
            let bundle = args[0].as_array().unwrap();
            if bundle
                .iter()
                .any(|word| throws.contains(&word.as_str().unwrap()))
            {
                return None;
            }
            Some(json!(bundle
                .iter()
                .map(|word| if rejects.contains(&word.as_str().unwrap()) {
                    "reject"
                } else {
                    "accept"
                })
                .collect::<Vec<_>>()))
        }
    }

    fn graded(suite: &dyn Fn(&[Value]) -> Option<Value>) -> Outcome {
        let plan = Plan::parse(&spec()).unwrap().unwrap();
        let results: Vec<Value> = (0..plan.passes())
            .map(|position| simulated_worker(&plan.pass_spec(position), suite))
            .collect();
        plan.outcome(&results)
    }

    const DEFECTS: [&str; 5] = ["leaky", "stale", "torn", "late", "lossy"];

    #[test]
    fn a_suite_that_catches_every_defect_passes_at_one() {
        let all = [&DEFECTS[..], &["crashing"]].concat();
        let outcome = graded(&suite(&all, &[]));
        assert_eq!(
            (outcome.correct_accepted, outcome.correct_total),
            (2, 2),
            "{outcome:?}"
        );
        assert_eq!((outcome.defects_caught, outcome.defect_total), (6, 6));
        assert_eq!(outcome.score(), 1.0);
        assert!(outcome.passed());
    }

    #[test]
    fn a_partial_catch_scores_its_exact_share_and_fails() {
        // Misses "stale" and "late": 4 of 6 defective implementations caught.
        let outcome = graded(&suite(&["leaky", "torn", "lossy", "crashing"], &[]));
        assert_eq!((outcome.correct_accepted, outcome.correct_total), (2, 2));
        assert_eq!((outcome.defects_caught, outcome.defect_total), (4, 6));
        assert_eq!(outcome.score(), 4.0 / 6.0);
        assert!(!outcome.passed());
        // The missed ones are named by bundle and position.
        let missed: Vec<(usize, usize)> = outcome
            .implementations
            .iter()
            .filter(|verdict| !verdict.correct && !verdict.matched)
            .map(|verdict| (verdict.case, verdict.position))
            .collect();
        assert_eq!(missed, [(0, 2), (1, 2)]);
    }

    #[test]
    fn rejecting_a_correct_implementation_scores_zero_whatever_it_catches() {
        // Rejects everything: every defect caught, both correct ones refused.
        let everything = [&DEFECTS[..], &["crashing", "sound"]].concat();
        let outcome = graded(&suite(&everything, &[]));
        assert_eq!((outcome.correct_accepted, outcome.correct_total), (0, 2));
        assert_eq!((outcome.defects_caught, outcome.defect_total), (6, 6));
        assert_eq!(outcome.score(), 0.0);
        assert!(!outcome.passed());
    }

    #[test]
    fn a_suite_that_cannot_run_scores_zero() {
        // A load error: the function throws for every bundle.
        let outcome = graded(&|_: &[Value]| None);
        assert_eq!((outcome.correct_accepted, outcome.defects_caught), (0, 0));
        assert_eq!(outcome.score(), 0.0);
        assert!(outcome.implementations.iter().all(|verdict| verdict.threw));
        // A result that is not one verdict per implementation is no verdict.
        let malformed = graded(&|_: &[Value]| Some(json!("reject")));
        assert_eq!(malformed.score(), 0.0);
        assert_eq!(malformed.defects_caught, 0);
        assert!(malformed
            .implementations
            .iter()
            .all(|verdict| !verdict.threw));
    }

    #[test]
    fn a_throw_on_a_bundle_without_a_correct_implementation_only_loses_that_bundle() {
        let all = [&DEFECTS[..], &["crashing"]].concat();
        let outcome = graded(&suite(&all, &["crashing"]));
        assert_eq!((outcome.correct_accepted, outcome.correct_total), (2, 2));
        assert_eq!((outcome.defects_caught, outcome.defect_total), (5, 6));
        assert_eq!(outcome.score(), 5.0 / 6.0);
        let thrown: Vec<&Verdict> = outcome
            .implementations
            .iter()
            .filter(|verdict| verdict.threw)
            .collect();
        assert_eq!(thrown.len(), 1);
        assert_eq!((thrown[0].case, thrown[0].position), (2, 0));
    }

    #[test]
    fn each_pass_asks_the_unchanged_bundles_for_one_position() {
        let plan = Plan::parse(&spec()).unwrap().unwrap();
        assert_eq!(plan.passes(), 4);
        // Position 0: all three bundles, inputs intact after position and count.
        assert_eq!(
            plan.pass_spec(0),
            json!({"functionName": ADAPTER, "argsCases": [
                {"args": [0, 3, ["sound", "leaky", "stale"]], "expected": "accept"},
                {"args": [0, 4, ["torn", "sound", "late", "lossy"]], "expected": "reject"},
                {"args": [0, 1, ["crashing"]], "expected": "reject"},
            ]})
        );
        // Position 3 exists in the second bundle only.
        assert_eq!(
            plan.pass_spec(3),
            json!({"functionName": ADAPTER, "argsCases": [
                {"args": [3, 4, ["torn", "sound", "late", "lossy"]], "expected": "reject"},
            ]})
        );
        // The answer stays first, byte for byte; the adapter calls its function.
        let answer = "function gradeImplementations() {}";
        let source = plan.source(answer);
        assert!(source.starts_with("function gradeImplementations() {}\n;async function"));
        assert!(source.contains("await gradeImplementations(...inputs)"));
        assert_eq!(plan.source_overhead(), source.len() - answer.len());
        // Protected inputs keep their immutability check behind the adapter's arguments.
        let mut immutable = spec();
        immutable["immutableArgs"] = json!([0]);
        let plan = Plan::parse(&immutable).unwrap().unwrap();
        assert_eq!(plan.pass_spec(1)["immutableArgs"], json!([2]));
    }

    #[test]
    fn evidence_names_every_implementation_with_its_expected_verdict() {
        let outcome = graded(&suite(&["leaky", "torn", "lossy"], &["crashing"]));
        let details = outcome.details();
        assert_eq!(details["scoring"], SCORING);
        assert_eq!(
            (&details["correctAccepted"], &details["correctTotal"]),
            (&json!(2), &json!(2))
        );
        assert_eq!(
            (&details["defectsCaught"], &details["defectTotal"]),
            (&json!(3), &json!(6))
        );
        let implementations = details["implementations"].as_array().unwrap();
        assert_eq!(implementations.len(), 8);
        assert_eq!(
            implementations[0],
            json!({"case": 0, "position": 0, "expected": "accept", "matched": true})
        );
        assert_eq!(
            implementations[2],
            json!({"case": 0, "position": 2, "expected": "reject", "matched": false})
        );
        assert_eq!(
            implementations[7],
            json!({"case": 2, "position": 0, "expected": "reject", "matched": false, "threw": true})
        );
        assert_eq!(
            outcome.summary(),
            "accepted 2/2 correct implementations, caught 3/6 defective ones"
        );
    }

    #[test]
    fn a_specification_without_scoring_is_not_share_scored() {
        let mut plain = spec();
        plain.as_object_mut().unwrap().remove("scoring");
        assert!(Plan::parse(&plain).unwrap().is_none());
        plain["scoring"] = Value::Null;
        assert!(Plan::parse(&plain).unwrap().is_none());
    }

    #[test]
    fn share_scoring_rejects_specifications_it_cannot_grade() {
        for (pointer, value) in [
            ("/scoring", json!("share")),
            ("/scoring", json!(true)),
            ("/functionName", json!(ADAPTER)),
            ("/functionName", json!("grade();")),
            ("/argsCases", json!([])),
            ("/argsCases/0/expected", json!("accept")),
            ("/argsCases/0/expected", json!([])),
            (
                "/argsCases/0/expected",
                json!(["accept", "maybe", "reject"]),
            ),
            (
                "/argsCases/0/expected",
                json!(vec!["reject"; MAX_POSITIONS + 1]),
            ),
            ("/argsCases/0/args", json!(null)),
            ("/immutableArgs", json!([-1])),
        ] {
            let mut invalid = spec();
            *invalid.pointer_mut(pointer).unwrap_or(&mut json!(null)) = value.clone();
            if pointer == "/immutableArgs" {
                invalid["immutableArgs"] = value;
            }
            assert!(Plan::parse(&invalid).is_err(), "{pointer}");
        }
        // Nothing to catch, or nothing that must be accepted, is no measurement.
        let only = |verdict: &str| {
            json!({"functionName": "grade", "scoring": SCORING,
                "argsCases": [{"args": [[1, 2]], "expected": [verdict, verdict]}]})
        };
        assert!(Plan::parse(&only("accept")).is_err());
        assert!(Plan::parse(&only("reject")).is_err());
    }
}
