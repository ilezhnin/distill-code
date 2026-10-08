use super::*;

pub(in crate::services::benchmarks) fn scope_hash(task: &PublicTask) -> Result<String> {
    let mut permissions = task.permissions.clone();
    permissions.tools.sort();
    permissions.tools.dedup();
    hash(&(
        task.role_id.as_ref(),
        &task.role_prompt,
        permissions,
        &task.execution_profile,
        task.entry.is_some(),
    ))
}

/// Fixed signed hashing and L2 normalization. Index zero is an unpenalized bias.
pub(super) fn extract(task: &PublicTask) -> Result<Vec<f64>> {
    if !routing::WORK_CLASSES.contains(&task.work_class_id.as_str())
        || task.prompt.trim().is_empty()
        || serde_json::to_vec(task)?.len() > 2_000_000
    {
        return Err(invalid(
            "Public task needs a known work class, a prompt and at most 2 MB of input",
        ));
    }
    let mut features = vec![0.0; DIMENSIONS];
    let mut add = |field: &str, token: &str, value: f64| {
        let digest = Sha256::digest(format!("{field}:{token}"));
        let slot = 1 + u16::from_le_bytes([digest[0], digest[1]]) as usize % (DIMENSIONS - 1);
        features[slot] += if digest[2] & 1 == 0 { value } else { -value };
    };
    // Sets make repeated boilerplate unable to drown out other public fields.
    let mut words = |field: &str, text: &str| {
        let tokens: BTreeSet<_> = text
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|s| !s.is_empty())
            .take(16_384)
            .map(str::to_lowercase)
            .collect();
        for token in tokens {
            add(field, &token, 1.0);
        }
    };
    words("prompt", &task.prompt);
    words("role", &task.role_prompt);
    for fixture in &task.fixtures {
        words("path", &fixture.path);
        words("fixture", &fixture.content);
    }
    if let Some(entry) = &task.entry {
        words("conversation", &entry.conversation_prefix);
        for report in &entry.previous_reports {
            words("report", report);
        }
    }
    add("class", &task.work_class_id, 1.0);
    add("profile", &task.execution_profile, 1.0);
    for (field, value) in [
        ("language", &task.facets.language),
        ("domain", &task.facets.domain),
        ("difficulty", &task.facets.difficulty),
        ("format", &task.facets.output_format),
        ("role-id", &task.role_id),
    ] {
        if let Some(value) = value {
            add(field, value, 1.0);
        }
    }
    add(
        "numeric",
        "prompt-bytes",
        (task.prompt.len() as f64).ln_1p() / 10.0,
    );
    add(
        "numeric",
        "timeout",
        (task.limits.timeout_seconds as f64).ln_1p() / 10.0,
    );
    add(
        "numeric",
        "turns",
        (task.limits.max_turns as f64).ln_1p() / 10.0,
    );
    add(
        "numeric",
        "artifact-bytes",
        (task.limits.max_artifact_bytes as f64).ln_1p() / 20.0,
    );
    add(
        "numeric",
        "input-bytes",
        (task.facets.input_bytes.unwrap_or(0) as f64).ln_1p() / 20.0,
    );
    if let Some(entry) = &task.entry {
        add(
            "numeric",
            "remaining-budget",
            (entry.remaining_budget_seconds as f64).ln_1p() / 10.0,
        );
    }
    let norm = features.iter().map(|v| v * v).sum::<f64>().sqrt().max(1.0);
    for value in &mut features {
        *value /= norm;
    }
    features[0] = 1.0;
    Ok(features)
}

pub(super) fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
