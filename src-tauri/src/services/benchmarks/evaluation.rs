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
        "javascript" | "browser" => {
            if serde_json::from_str::<serde_json::Value>(&e.expected).is_err() {
                issues.push("Protected evaluator specification must be valid JSON".into());
            }
            if e.known_good.is_empty() || e.known_bad.is_empty() {
                issues.push("Protected evaluator reference outputs are required".into());
            }
        }
        _ => issues.push("Unknown evaluator kind".into()),
    }
    issues
}
#[cfg(test)]
mod tests {
    use super::*;
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
