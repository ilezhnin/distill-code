use super::{store::now, types::*};

pub fn evaluate(evaluator: &Evaluator, output: &str) -> Result<Evaluation> {
    let (verdict, score, reason) = match evaluator.kind.as_str() {
        "exact" => {
            let pass = output.trim() == evaluator.expected.trim();
            (
                if pass { "pass" } else { "fail" },
                Some(if pass { 1.0 } else { 0.0 }),
                "Exact normalized answer comparison",
            )
        }
        "json" => {
            let expected: serde_json::Value = serde_json::from_str(&evaluator.expected)?;
            let actual = serde_json::from_str::<serde_json::Value>(output.trim());
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
        reason: reason.into(),
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
