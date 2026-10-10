use super::{store::now, types::*};

/// Answers are compared without a single Markdown fence around the whole
/// output: the fence is a formatting habit, not a wrong answer, and every
/// candidate is treated the same way. Returns the inner text and whether a
/// fence was removed.
pub fn strip_markdown_fence(output: &str) -> (&str, bool) {
    let trimmed = output.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return (trimmed, false);
    };
    let Some(body) = rest.strip_suffix("```") else {
        return (trimmed, false);
    };
    let inner = body.split_once('\n').map_or("", |(_, inner)| inner);
    (inner.trim(), true)
}

/// A function returned as a module export is still the requested function;
/// the protected realm cannot load module syntax, so the keyword is removed
/// and the removal is recorded.
pub fn strip_module_export(source: &str) -> (&str, bool) {
    let trimmed = source.trim();
    for prefix in ["export default ", "export "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return (rest.trim_start(), true);
        }
    }
    (trimmed, false)
}

pub fn evaluate(evaluator: &Evaluator, output: &str) -> Result<Evaluation> {
    let (output, stripped) = strip_markdown_fence(output);
    let (verdict, score, reason) = match evaluator.kind.as_str() {
        "exact" => {
            let pass = output == evaluator.expected.trim();
            (
                if pass { "pass" } else { "fail" },
                Some(if pass { 1.0 } else { 0.0 }),
                "Exact normalized answer comparison",
            )
        }
        "json" => {
            let expected: serde_json::Value = serde_json::from_str(&evaluator.expected)?;
            let actual = serde_json::from_str::<serde_json::Value>(output);
            let pass = actual.is_ok_and(|v| v == expected);
            (
                if pass { "pass" } else { "fail" },
                Some(if pass { 1.0 } else { 0.0 }),
                "Complete structured JSON value comparison",
            )
        }
        "rubric" => ("pending_review", None, "Human rubric review is required"),
        _ => {
            return Err(BenchmarkError::new(
                "capability_missing",
                "Evaluator requires the isolated artifact worker",
            ))
        }
    };
    Ok(Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: evaluator.revision.clone(),
        verdict: verdict.into(),
        score,
        reason: if stripped {
            format!("{reason}; Markdown fence stripped")
        } else {
            reason.into()
        },
        created_at: now(),
        provenance: "objective".into(),
        artifacts: Vec::new(),
        details: None,
        judge: None,
        usage: None,
    })
}
pub fn validate(e: &Evaluator) -> Vec<String> {
    let mut issues = Vec::new();
    if e.revision.trim().is_empty() {
        issues.push("Evaluator revision is required".into());
    }
    match e.kind.as_str() {
        "exact" | "json" => {
            if !matches!(evaluate(e,&e.known_good),Ok(v) if v.verdict=="pass") {
                issues.push("Evaluator must pass its known-good reference".into());
            }
            if !matches!(evaluate(e,&e.known_bad),Ok(v) if v.verdict=="fail") {
                issues.push("Evaluator must reject its known-bad reference".into());
            }
        }
        "rubric" => {
            if e.rubric.trim().is_empty() {
                issues.push("Review rubric is required".into());
            }
        }
        // The check and its references are verified against the snapshot at
        // publication (`repository::validate`, `Store::publish`).
        "repository" => {}
        "javascript" | "browser" => {
            match serde_json::from_str::<serde_json::Value>(&e.expected) {
                Ok(spec) if e.kind == "javascript" => {
                    issues.extend(validate_javascript_spec(&spec));
                }
                Ok(_) => {}
                Err(_) => {
                    issues.push("Protected evaluator specification must be valid JSON".into());
                }
            }
            if e.known_good.is_empty() || e.known_bad.is_empty() {
                issues.push("Protected evaluator reference outputs are required".into());
            }
        }
        _ => issues.push("Unknown evaluator kind".into()),
    }
    issues
}

/// Reject authoring errors before publication launches a candidate artifact.
/// The protected worker still checks this boundary independently at execution.
fn validate_javascript_spec(spec: &serde_json::Value) -> Vec<String> {
    let mut issues = Vec::new();
    let valid_name = spec["functionName"].as_str().is_some_and(|name| {
        let mut bytes = name.bytes();
        bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_' || first == b'$')
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
    });
    if !valid_name {
        issues.push("JavaScript checks require a valid functionName".into());
    }
    let Some(cases) = spec["argsCases"]
        .as_array()
        .filter(|cases| (1..=100).contains(&cases.len()))
    else {
        issues.push("JavaScript checks require 1-100 argsCases".into());
        return issues;
    };
    for (index, case) in cases.iter().enumerate() {
        if !case["args"].is_array() || case.get("expected").is_none() {
            issues.push(format!(
                "JavaScript case {} requires an args array and an expected value",
                index + 1
            ));
        }
    }
    if let Some(indices) = spec.get("immutableArgs").filter(|value| !value.is_null()) {
        match indices.as_array() {
            Some(indices) => {
                for index in indices {
                    if index
                        .as_f64()
                        .filter(|index| *index >= 0.0 && index.fract() == 0.0)
                        .is_none_or(|index| {
                            cases.iter().any(|case| {
                                case["args"]
                                    .as_array()
                                    .is_none_or(|args| index >= args.len() as f64)
                            })
                        })
                    {
                        issues.push("immutableArgs must contain nonnegative integer indices present in every case's args".into());
                        break;
                    }
                }
            }
            None => issues.push("immutableArgs must be an array of argument indices".into()),
        }
    }
    issues
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn javascript_authoring_checks_reject_invalid_protected_contracts() {
        let good = json!({"functionName":"copy", "immutableArgs":[0], "argsCases":[{"args":[{"value":1}], "expected":{"value":1}}]});
        let evaluator = |spec: serde_json::Value| Evaluator {
            kind: "javascript".into(),
            expected: spec.to_string(),
            rubric: String::new(),
            revision: "1".into(),
            known_good: "function copy(value) { return {...value}; }".into(),
            known_bad: "function copy(value) { return null; }".into(),
        };
        assert!(validate(&evaluator(good.clone())).is_empty());
        for (key, value) in [
            ("functionName", json!("copy();")),
            ("functionName", json!("1copy")),
            ("argsCases", json!([])),
            (
                "argsCases",
                json!(vec![json!({"args":[],"expected":null}); 101]),
            ),
            ("argsCases", json!([{"args":[1]}])),
            ("argsCases", json!([{"args":null,"expected":null}])),
            ("immutableArgs", json!("0")),
            ("immutableArgs", json!([-1])),
            ("immutableArgs", json!([0.5])),
            ("immutableArgs", json!([1])),
        ] {
            let mut invalid = good.clone();
            invalid[key] = value;
            assert!(!validate(&evaluator(invalid)).is_empty(), "{key}");
        }
        // Optional immutability, null outputs and argument-free functions are valid.
        assert!(validate(&evaluator(
            json!({"functionName":"$nothing", "argsCases":[{"args":[], "expected":null}]})
        ))
        .is_empty());
        assert!(validate(&evaluator(json!({"functionName":"copy", "immutableArgs":[0.0], "argsCases":[{"args":[1], "expected":1}]}))).is_empty());
        for invalid in [json!(null), json!(false), json!([]), json!("checks")] {
            assert!(!validate(&evaluator(invalid)).is_empty());
        }
        // An index must exist in every case, not just in the first one.
        assert!(!validate(&evaluator(json!({"functionName":"copy", "immutableArgs":[0], "argsCases":[{"args":[1],"expected":1},{"args":[],"expected":null}]}))).is_empty());
    }
    #[test]
    fn a_single_fence_around_the_answer_is_not_a_wrong_answer() {
        assert_eq!(
            strip_markdown_fence("```json\n{\"a\":1}\n```"),
            ("{\"a\":1}", true)
        );
        assert_eq!(strip_markdown_fence("  READY "), ("READY", false));
        assert_eq!(
            strip_markdown_fence("```\nunterminated"),
            ("```\nunterminated", false)
        );
        let e = Evaluator {
            kind: "exact".into(),
            expected: "READY".into(),
            rubric: String::new(),
            revision: "1".into(),
            known_good: "READY".into(),
            known_bad: "NOT READY".into(),
        };
        let fenced = evaluate(&e, "```text\nREADY\n```").unwrap();
        assert_eq!(fenced.verdict, "pass");
        assert!(fenced.reason.contains("fence stripped"));
        assert_eq!(
            evaluate(&e, "```\nREADY\n```\nand more").unwrap().verdict,
            "fail"
        );
    }
    #[test]
    fn a_leading_module_export_is_removed_before_the_protected_realm() {
        assert_eq!(
            strip_module_export("export function f() {}"),
            ("function f() {}", true)
        );
        assert_eq!(
            strip_module_export("export default function f() {}"),
            ("function f() {}", true)
        );
        assert_eq!(
            strip_module_export("function exportAll() {}"),
            ("function exportAll() {}", false)
        );
    }
    #[test]
    fn structured_checks_are_semantic_not_just_json() {
        let e = Evaluator {
            kind: "json".into(),
            expected: "{\"value\":2}".into(),
            rubric: String::new(),
            revision: "1".into(),
            known_good: "{\"value\":2}".into(),
            known_bad: "{\"value\":3}".into(),
        };
        assert!(validate(&e).is_empty());
        assert_eq!(evaluate(&e, "{\"value\":3}").unwrap().verdict, "fail");
        assert_eq!(evaluate(&e, "malformed").unwrap().verdict, "fail");
    }
}
