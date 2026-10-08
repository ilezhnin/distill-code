//! Versioned native consent and automatic policy discovery. Legacy records keep
//! their original wire shape; this uses their existing binding/session tables.
use super::*;
use crate::services::agent_host::execution::NativeProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleIntent {
    pub source_path: String,
    pub work_class_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRole {
    pub source_id: String,
    pub source_path: String,
    pub source_hash: String,
    pub role_id: String,
    pub role_prompt: String,
    pub work_class_id: String,
    pub prior: Vec<NativePreference>,
    pub prior_reason: String,
    pub unknown_reasons: Vec<String>,
    pub default_effort: Option<String>,
    pub default_fast_mode: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativePreference {
    pub provider_id: Option<String>,
    pub model_id: String,
    pub effort: Option<String>,
    pub fast_mode: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModeRequestV2 {
    pub schema_version: u32,
    pub context_id: String,
    pub surface: String,
    pub execution_profile: String,
    pub repository: Option<repository::Snapshot>,
    pub limits: Limits,
    pub roles: Vec<RoleIntent>,
    pub provider_ids: Vec<String>,
    pub acknowledged_contract_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    pub surface: String,
    pub execution_profile: String,
    pub repository: Option<repository::Snapshot>,
    pub repository_archive_hash: Option<String>,
    pub limits: Limits,
    pub permissions: Permissions,
    pub roles: Vec<NativeRole>,
    pub provider_ids: Vec<String>,
    pub complete: bool,
    pub unknown_reasons: Vec<String>,
    pub artifact_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeV2 {
    pub schema_version: u32,
    pub request: ModeRequestV2,
    pub consent: Consent,
    pub created_at: i64,
    pub artifact_hash: String,
}
/// A short-lived stored-record envelope; its size difference is irrelevant.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModeEnvelope {
    V2(ModeV2),
    V1(Mode),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModeIntent {
    V2(ModeRequestV2),
    V1(ModeRequest),
}
impl ModeIntent {
    pub fn context_id(&self) -> &str {
        match self {
            Self::V1(request) => &request.context_id,
            Self::V2(request) => &request.context_id,
        }
    }
    pub fn is_fresh_chat(&self) -> bool {
        matches!(self, Self::V2(request) if request.surface == "chat")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestV2 {
    pub schema_version: u32,
    pub request_key: String,
    pub surface: String,
    pub context_id: String,
    pub mode: ModeReference,
    pub role_source_id: String,
    pub work_class_id: String,
    pub prompt: String,
    pub hard_candidate_key: Option<String>,
    pub entry: Option<WaveEntry>,
    pub step_budget_seconds: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PrepareIntent {
    V2(RequestV2),
    V1(Request),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextV2 {
    pub schema_version: u32,
    pub intent: RequestV2,
    pub consent_hash: String,
    pub role: NativeRole,
    pub envelope_hash: String,
    pub complete: bool,
    pub unknown_reasons: Vec<String>,
    pub selected_policy_id: Option<String>,
    pub selected_policy_hash: Option<String>,
    pub policy_discovery: String,
    pub prior_reason: String,
    pub inventory_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_before: Option<repository::Artifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_lineage: Vec<repository::Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_access_all: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_budget: Option<super::super::artifact_context::BudgetLease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_snapshot_at_ms: Option<i64>,
}

fn role_source(raw: &str) -> Result<(String, serde_json::Value)> {
    let normalized = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err(invalid("Native role source needs Markdown frontmatter"));
    }
    let mut closed = false;
    let mut frontmatter = Vec::new();
    for line in lines.by_ref() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        frontmatter.push(line);
    }
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_owned();
    if !closed || body.is_empty() || body.len() > 64 * 1024 {
        return Err(invalid(
            "Native role body must be nonempty and at most 64 KiB",
        ));
    }
    let metadata: serde_json::Value = yaml_serde::from_str(&frontmatter.join("\n"))
        .map_err(|error| invalid(format!("Native role frontmatter is invalid: {error}")))?;
    if !metadata.is_object() {
        return Err(invalid("Native role frontmatter must be a map"));
    }
    Ok((body, metadata))
}

fn native_provider(value: &str) -> Option<String> {
    NativeProvider::ALL
        .iter()
        .find(|provider| provider.harness_id() == value || provider.key() == value)
        .map(|provider| provider.harness_id().to_owned())
}
fn preference(
    value: &serde_json::Value,
    model_field: &str,
    provider_field: &str,
    fast_field: &str,
) -> Option<NativePreference> {
    if value
        .get("effort")
        .is_some_and(|field| !field.is_null() && !field.is_string())
        || value
            .get(fast_field)
            .is_some_and(|field| !field.is_null() && !field.is_boolean())
        || value
            .get(provider_field)
            .is_some_and(|field| !field.is_null() && !field.is_string())
    {
        return None;
    }
    let model = value[model_field].as_str()?.trim();
    if model.is_empty() {
        return None;
    }
    let (provider, model) = model
        .split_once(':')
        .map_or((None, model), |(provider, model)| (Some(provider), model));
    let provider = provider.or_else(|| value[provider_field].as_str());
    let provider_id = match provider {
        Some(provider) => Some(native_provider(provider.trim())?),
        None => None,
    };
    let (model_id, folded_effort) = model
        .strip_suffix(']')
        .and_then(|model| model.rsplit_once('['))
        .map_or((model.trim(), None), |(model, effort)| {
            (model.trim(), Some(effort.trim()))
        });
    if model_id.is_empty() {
        return None;
    }
    let effort = value["effort"]
        .as_str()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .or(folded_effort)
        .map(str::to_owned);
    Some(NativePreference {
        provider_id,
        model_id: model_id.to_owned(),
        effort,
        fast_mode: value[fast_field].as_bool(),
    })
}
fn role_prior(metadata: &serde_json::Value) -> (Vec<NativePreference>, String, Vec<String>) {
    let mut unknown = vec![];
    if let Some(ranking) = metadata
        .get("model_ranking")
        .filter(|value| !value.is_null())
    {
        let parsed = ranking
            .as_str()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
        let entries = parsed.as_ref().and_then(|value| {
            value.as_array().or_else(|| {
                (value["version"] == 1)
                    .then(|| value["entries"].as_array())
                    .flatten()
            })
        });
        if let Some(entries) = entries.filter(|entries| !entries.is_empty() && entries.len() <= 12)
        {
            let prior: Vec<_> = entries
                .iter()
                .filter_map(|entry| preference(entry, "modelId", "platform", "fastMode"))
                .collect();
            if prior.len() == entries.len() {
                return (prior, "native_role_ranking".into(), unknown);
            }
        }
        unknown.push(
            "Native role ranking needs an unsupported class/alias or malformed preference mapping"
                .into(),
        );
    }
    if metadata.get("model").is_some_and(|value| !value.is_null()) {
        if let Some(prior) = preference(metadata, "model", "provider", "fast_mode") {
            return (vec![prior], "native_role_model_preference".into(), unknown);
        }
        unknown.push("Native role model/provider preference is unsupported".into());
    }
    (vec![], "explicit_native_default_order".into(), unknown)
}

impl Store {
    pub async fn owned_task_mode_envelope(&self, id: &str) -> Result<Option<ModeEnvelope>> {
        let row = sqlx::query(
            "SELECT mode_json,artifact_hash FROM task_mode_consents WHERE context_id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let value: ModeEnvelope = serde_json::from_str(row.try_get("mode_json")?)?;
        let (context_id, actual_hash, body_hash) = match &value {
            ModeEnvelope::V1(mode) => {
                let mut body = mode.clone();
                body.artifact_hash.clear();
                (&mode.request.context_id, &mode.artifact_hash, hash(&body)?)
            }
            ModeEnvelope::V2(mode) => {
                if mode.schema_version != 2 || mode.request.schema_version != 2 {
                    return Err(invalid("Unsupported native task mode version"));
                }
                let mut body = mode.clone();
                body.artifact_hash.clear();
                (&mode.request.context_id, &mode.artifact_hash, hash(&body)?)
            }
        };
        if context_id != id
            || actual_hash != &body_hash
            || actual_hash != &row.try_get::<String, _>("artifact_hash")?
        {
            return Err(invalid("Native task mode consent integrity failed"));
        }
        Ok(Some(value))
    }
}

impl BenchmarkService {
    fn native_role(&self, intent: &RoleIntent) -> Result<NativeRole> {
        if !routing::WORK_CLASSES.contains(&intent.work_class_id.as_str()) {
            return Err(invalid("The native mode does not support this work class"));
        }
        let source = match &self.app {
            Some(app) => {
                crate::commands::agents::read_native_agent_source(app, &intent.source_path)
                    .map_err(invalid)?
            }
            None => crate::commands::agents::read_native_agent_source_with_roots(
                &intent.source_path,
                &[self.store.root.join("agents")],
            )
            .map_err(invalid)?,
        };
        let source_path = std::fs::canonicalize(&intent.source_path)?
            .to_string_lossy()
            .into_owned();
        let filename = source.file_name.to_lowercase();
        let role_id = filename
            .strip_suffix(".persona.md")
            .or_else(|| filename.strip_suffix(".md"))
            .unwrap_or(&filename)
            .to_owned();
        let (role_prompt, metadata) = role_source(&source.file_contents)?;
        let (prior, prior_reason, mut unknown_reasons) = role_prior(&metadata);
        let default_effort = metadata["effort"]
            .as_str()
            .map(str::trim)
            .filter(|effort| !effort.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                (prior_reason == "native_role_model_preference")
                    .then(|| prior.first().and_then(|entry| entry.effort.clone()))
                    .flatten()
            });
        let default_fast_mode = metadata["fast_mode"].as_bool();
        if metadata
            .get("effort")
            .is_some_and(|field| !field.is_null() && !field.is_string())
            || metadata
                .get("fast_mode")
                .is_some_and(|field| !field.is_null() && !field.is_boolean())
        {
            unknown_reasons.push("Native role global effort/fast controls are malformed".into());
        }
        Ok(NativeRole {
            source_id: hash(&("native-role-source-v1", &source_path))?,
            source_path,
            source_hash: fixtures::hash(source.file_contents.as_bytes()),
            role_id,
            role_prompt,
            work_class_id: intent.work_class_id.clone(),
            prior,
            prior_reason,
            unknown_reasons,
            default_effort,
            default_fast_mode,
        })
    }
    pub async fn inspect_owned_task_mode(&self, request: &ModeRequestV2) -> Result<Consent> {
        if request.schema_version != 2
            || request.context_id.trim().is_empty()
            || !matches!(request.surface.as_str(), "chat" | "wave")
            || request.context_id.len() > 256
            || !(1..=16).contains(&request.roles.len())
            || request.limits.timeout_seconds == 0
            || request.limits.timeout_seconds > super::super::MAX_TIME_LIMIT_SECONDS
            || request.limits.max_turns != 1
            || request.limits.max_artifact_bytes == 0
            || request.limits.max_artifact_bytes > 16 * 1024 * 1024
        {
            return Err(invalid(
                "Native task consent needs bounded context, roles and execution limits",
            ));
        }
        if request.provider_ids.is_empty()
            || request.provider_ids.len() > NativeProvider::ALL.len()
            || request.provider_ids.iter().collect::<BTreeSet<_>>().len()
                != request.provider_ids.len()
            || request
                .provider_ids
                .iter()
                .any(|provider| NativeProvider::for_harness(provider).is_none())
        {
            return Err(invalid(
                "Consent providers must be distinct supported native harnesses",
            ));
        }
        let permissions = match request.execution_profile.as_str() {
            "native_text" if request.repository.is_none() => Permissions {
                tools: vec![],
                network: false,
                context: "clean".into(),
            },
            "protected_repository" if request.repository.is_some() => Permissions {
                tools: vec!["filesystem".into(), "terminal".into()],
                network: true,
                context: "clean".into(),
            },
            _ => {
                return Err(invalid(
                    "Choose an explicit supported owned profile; ordinary interactive scope is not equivalent",
                ));
            }
        };
        let roles = request
            .roles
            .iter()
            .map(|role| self.native_role(role))
            .collect::<Result<Vec<_>>>()?;
        if roles
            .iter()
            .map(|role| (&role.source_id, &role.work_class_id))
            .collect::<BTreeSet<_>>()
            .len()
            != roles.len()
        {
            return Err(invalid(
                "Native consent role/class choices must be distinct",
            ));
        }
        let repository_archive_hash = match &request.repository {
            Some(snapshot) => Some(fixtures::hash(&repository::archive(snapshot).await?)),
            None => None,
        };
        let unknown_reasons: Vec<_> = roles
            .iter()
            .flat_map(|role| role.unknown_reasons.iter().cloned())
            .collect();
        let mut consent = Consent {
            surface: request.surface.clone(),
            execution_profile: request.execution_profile.clone(),
            repository: request.repository.clone(),
            repository_archive_hash,
            limits: request.limits.clone(),
            permissions,
            roles,
            provider_ids: request.provider_ids.clone(),
            complete: unknown_reasons.is_empty(),
            unknown_reasons,
            artifact_hash: String::new(),
        };
        consent.artifact_hash = hash(&consent)?;
        Ok(consent)
    }
    pub async fn set_owned_task_mode_intent(
        &self,
        intent: ModeIntent,
    ) -> Result<Option<ModeEnvelope>> {
        match intent {
            ModeIntent::V1(request) => self
                .store
                .set_owned_task_mode(request)
                .await
                .map(|mode| mode.map(ModeEnvelope::V1)),
            ModeIntent::V2(request) => {
                let _guard = promotion::admission_gate().lock_owned().await;
                if let Some(ModeEnvelope::V2(existing)) = self
                    .store
                    .owned_task_mode_envelope(&request.context_id)
                    .await?
                {
                    if hash(&existing.request)? == hash(&request)? {
                        // A lost Save response recovers the exact immutable
                        // commit even if its source has since become unusable.
                        return Ok(Some(ModeEnvelope::V2(existing)));
                    }
                }
                let consent = self
                    .inspect_owned_task_mode(&request)
                    .await
                    .map_err(|error| {
                        if error.code == "invalid_task_authority" {
                            BenchmarkError::new("owned_task_intent_refused", error.message)
                        } else {
                            error
                        }
                    })?;
                if consent.artifact_hash != request.acknowledged_contract_hash {
                    return Err(BenchmarkError::new(
                        "owned_task_intent_refused",
                        "Acknowledge the exact current native consent before saving; this request was not committed",
                    ));
                }
                if let Some(ModeEnvelope::V2(existing)) = self
                    .store
                    .owned_task_mode_envelope(&request.context_id)
                    .await?
                {
                    if hash(&existing.request)? == hash(&request)?
                        && hash(&existing.consent)? == hash(&consent)?
                    {
                        return Ok(Some(ModeEnvelope::V2(existing)));
                    }
                }
                let mut mode = ModeV2 {
                    schema_version: 2,
                    request,
                    consent,
                    created_at: now(),
                    artifact_hash: String::new(),
                };
                mode.artifact_hash = hash(&mode)?;
                sqlx::query("INSERT INTO task_mode_consents(context_id,mode_json,artifact_hash) VALUES(?,?,?) ON CONFLICT(context_id) DO UPDATE SET mode_json=excluded.mode_json,artifact_hash=excluded.artifact_hash")
                    .bind(&mode.request.context_id).bind(serde_json::to_string(&mode)?).bind(&mode.artifact_hash).execute(&self.store.pool).await?;
                Ok(Some(ModeEnvelope::V2(mode)))
            }
        }
    }

    async fn require_mode_v2(&self, intent: &RequestV2) -> Result<ModeV2> {
        let Some(ModeEnvelope::V2(mode)) = self
            .store
            .owned_task_mode_envelope(&intent.mode.context_id)
            .await?
        else {
            return Err(invalid(
                "This task needs the exact committed native v2 consent",
            ));
        };
        if mode.artifact_hash != intent.mode.artifact_hash
            || mode.request.surface != intent.surface
            || (intent.surface == "chat" && intent.context_id != intent.mode.context_id)
            || (intent.surface == "wave"
                && !intent
                    .context_id
                    .starts_with(&format!("{}:wave:", intent.mode.context_id)))
            || self
                .inspect_owned_task_mode(&mode.request)
                .await?
                .artifact_hash
                != mode.consent.artifact_hash
        {
            return Err(invalid(
                "Native role, repository or operator consent changed",
            ));
        }
        Ok(mode)
    }

    /// Inventory is resolved without opening a fit or selecting a certificate.
    /// The base prior pool uses the host's default controls. The choices expose
    /// only advertised controls; an explicit pin is added to that same pool.
    async fn native_pool_v2(
        &self,
        consent: &Consent,
    ) -> Result<(Vec<RoutingCandidate>, Vec<RoutingCandidate>)> {
        let mut base = BTreeMap::new();
        let mut choices = BTreeMap::new();
        for provider in &consent.provider_ids {
            for account in self.backend.accounts(provider).await? {
                let rows = self
                    .backend
                    .inventory(provider, Some(&account), false)
                    .await?;
                for row in rows {
                    if row.configuration.execution_profile != consent.execution_profile
                        || row.configuration.provider_id != *provider
                        || row.configuration.account_id.as_deref() != Some(account.as_str())
                    {
                        continue;
                    }
                    let busy = self.backend.activity(&row.configuration).await?;
                    let mut configuration = row.configuration.clone();
                    configuration.effort = configuration
                        .effort
                        .or_else(|| row.efforts.first().cloned());
                    configuration.fast_mode = Some(false);
                    let candidate = RoutingCandidate {
                        configuration,
                        available: row.available && busy.active_sessions.is_empty(),
                        reason: if busy.active_sessions.is_empty() {
                            row.reason.clone()
                        } else {
                            Some("Native account is busy".into())
                        },
                    };
                    let key = routing::candidate_key(&candidate.configuration);
                    if base
                        .get(&key)
                        .is_none_or(|old: &RoutingCandidate| !old.available)
                    {
                        base.insert(key, candidate.clone());
                    }
                    let mut efforts = vec![candidate.configuration.effort.clone()];
                    efforts.extend(row.efforts.iter().cloned().map(Some));
                    efforts.sort();
                    efforts.dedup();
                    for effort in efforts {
                        for fast in [false, true] {
                            if fast && !row.supports_fast_mode {
                                continue;
                            }
                            let mut variant = candidate.clone();
                            variant.configuration.effort = effort.clone();
                            variant.configuration.fast_mode = Some(fast);
                            let key = routing::candidate_key(&variant.configuration);
                            if choices
                                .get(&key)
                                .is_none_or(|old: &RoutingCandidate| !old.available)
                            {
                                choices.insert(key, variant);
                            }
                        }
                    }
                }
            }
        }
        for (key, candidate) in &base {
            choices
                .entry(key.clone())
                .or_insert_with(|| candidate.clone());
        }
        if base.len() > 32 || choices.len() > 512 {
            return Err(invalid(
                "The native candidate pool exceeds the supported selection bound; consent to fewer providers",
            ));
        }
        Ok((
            base.into_values().collect(),
            choices.into_values().collect(),
        ))
    }
    pub async fn owned_task_choices_v2(&self, context_id: &str) -> Result<Vec<Choice>> {
        let Some(ModeEnvelope::V2(mode)) = self.store.owned_task_mode_envelope(context_id).await?
        else {
            return Err(invalid("Native v2 consent is missing"));
        };
        if self
            .inspect_owned_task_mode(&mode.request)
            .await?
            .artifact_hash
            != mode.consent.artifact_hash
        {
            return Err(invalid("Native consent changed"));
        }
        let (_, choices) = self.native_pool_v2(&mode.consent).await?;
        Ok(choices
            .into_iter()
            .map(|candidate| Choice {
                candidate_key: routing::candidate_key(&candidate.configuration),
                configuration: candidate.configuration,
                available: candidate.available,
                reason: candidate.reason,
            })
            .collect())
    }

    fn native_prior_v2(
        role: &NativeRole,
        base: &[RoutingCandidate],
        choices: &[RoutingCandidate],
    ) -> (Vec<RoutingCandidate>, Vec<String>) {
        let mut pool = vec![];
        let mut unknown = role.unknown_reasons.clone();
        let mut explicit_models = BTreeSet::new();
        for preference in &role.prior {
            let effort = preference.effort.as_ref().or(role.default_effort.as_ref());
            let fast = preference
                .fast_mode
                .or(role.default_fast_mode)
                .unwrap_or(false);
            let matches: Vec<_> = choices
                .iter()
                .filter(|candidate| {
                    let configuration = &candidate.configuration;
                    configuration.model_id == preference.model_id
                        && preference
                            .provider_id
                            .as_ref()
                            .is_none_or(|provider| *provider == configuration.provider_id)
                        && effort.map_or_else(
                            || {
                                base.iter().any(|default| {
                                    default.configuration.provider_id == configuration.provider_id
                                        && default.configuration.model_id == configuration.model_id
                                        && default.configuration.effort == configuration.effort
                                })
                            },
                            |effort| configuration.effort.as_ref() == Some(effort),
                        )
                        && configuration.fast_mode == Some(fast)
                })
                .collect();
            if matches.len() != 1 {
                unknown.push(format!(
                    "Native role preference {} has no unique advertised settings match",
                    preference.model_id
                ));
                continue;
            }
            let candidate = matches[0];
            explicit_models.insert((
                candidate.configuration.provider_id.clone(),
                candidate.configuration.model_id.clone(),
            ));
            if !pool.iter().any(|old: &RoutingCandidate| {
                routing::candidate_key(&old.configuration)
                    == routing::candidate_key(&candidate.configuration)
            }) {
                pool.push(candidate.clone());
            }
        }
        for candidate in base {
            if !explicit_models.contains(&(
                candidate.configuration.provider_id.clone(),
                candidate.configuration.model_id.clone(),
            )) {
                let with_controls: Vec<_> = choices
                    .iter()
                    .filter(|row| {
                        row.configuration.provider_id == candidate.configuration.provider_id
                            && row.configuration.model_id == candidate.configuration.model_id
                            && row.configuration.account_id == candidate.configuration.account_id
                            && row.configuration.effort
                                == role
                                    .default_effort
                                    .clone()
                                    .or_else(|| candidate.configuration.effort.clone())
                            && row.configuration.fast_mode
                                == role.default_fast_mode.or(candidate.configuration.fast_mode)
                    })
                    .collect();
                if with_controls.len() == 1 {
                    pool.push(with_controls[0].clone());
                } else {
                    unknown.push(format!(
                        "Native role global controls are unavailable for {}",
                        candidate.configuration.model_id
                    ));
                    pool.push(candidate.clone());
                }
            }
        }
        (pool, unknown)
    }

    async fn committed_entry_v2(
        &self,
        intent: &RequestV2,
        mode: &ModeV2,
        budget: &super::super::artifact_context::BudgetLease,
        snapshot_at_ms: Option<i64>,
    ) -> Result<(learned::PublicEntry, i64)> {
        let cap = mode.consent.limits.timeout_seconds;
        let mut elapsed = 0u64;
        let mut reports = vec![];
        if let Some(reference) = &intent.entry {
            if intent.surface != "wave"
                || reference.previous_binding_ids.is_empty()
                || reference.previous_binding_ids.len() > 64
                || reference
                    .previous_binding_ids
                    .iter()
                    .collect::<BTreeSet<_>>()
                    .len()
                    != reference.previous_binding_ids.len()
                || reference.previous_binding_ids.first() != Some(&reference.root_binding_id)
            {
                return Err(invalid(
                    "Wave v2 entry requires distinct ordered native predecessors",
                ));
            }
            for (index, id) in reference.previous_binding_ids.iter().enumerate() {
                let prior = self.store.task_binding(id).await?;
                let context = prior
                    .context_v2
                    .as_ref()
                    .ok_or_else(|| invalid("Legacy and v2 wave lineage cannot be mixed"))?;
                let exact_prefix = if index == 0 {
                    context.intent.entry.is_none()
                } else {
                    context.intent.entry.as_ref().is_some_and(|entry| {
                        entry.root_binding_id == reference.root_binding_id
                            && entry.previous_binding_ids == reference.previous_binding_ids[..index]
                    })
                };
                if context.intent.surface != "wave"
                    || context.intent.context_id != intent.context_id
                    || context.intent.mode.artifact_hash != intent.mode.artifact_hash
                    || !exact_prefix
                {
                    return Err(invalid(
                        "Native wave predecessor belongs to another context or lineage",
                    ));
                }
                let session = self
                    .store
                    .task_session(&prior)
                    .await?
                    .ok_or_else(|| invalid("Native predecessor session is missing"))?;
                let output = self.backend.owned_task_output(&prior, &session).await?;
                elapsed = elapsed.saturating_add(output.elapsed_ms);
                if reference.include_previous_output {
                    reports.push(output.text);
                }
            }
        }
        let _ = (cap, elapsed); // Runtime metrics remain separate from wall accounting.
        let at = snapshot_at_ms.unwrap_or_else(now);
        let remaining = budget.remaining_seconds(at)?;
        Ok((
            learned::PublicEntry {
                conversation_prefix: String::new(),
                previous_reports: reports,
                remaining_budget_seconds: remaining.min(intent.step_budget_seconds),
            },
            at,
        ))
    }

    async fn repository_context_v2(
        &self,
        intent: &RequestV2,
        mode: &ModeV2,
        budget: &super::super::artifact_context::BudgetLease,
    ) -> Result<Option<super::super::artifact_context::Input>> {
        let Some(snapshot) = &mode.consent.repository else {
            return Ok(None);
        };
        let access_all = intent
            .entry
            .as_ref()
            .is_some_and(|entry| entry.include_previous_output);
        let mut lineage = vec![];
        if let Some(entry) = &intent.entry {
            for id in &entry.previous_binding_ids {
                let previous = self.store.task_binding(id).await?;
                let context = previous
                    .context_v2
                    .as_ref()
                    .ok_or_else(|| invalid("Repository lineage requires native v2 bindings"))?;
                let session = self
                    .store
                    .task_session(&previous)
                    .await?
                    .ok_or_else(|| invalid("Repository predecessor has no native session"))?;
                let result = self
                    .backend
                    .owned_task_output(&previous, &session)
                    .await?
                    .repository_result
                    .ok_or_else(|| {
                        invalid("Repository predecessor has no sealed cumulative artifact")
                    })?;
                result.validate(mode.consent.limits.max_artifact_bytes as usize)?;
                if context.artifact_access_all != Some(true) {
                    lineage.clear();
                }
                lineage.push(result.artifact);
            }
        }
        let package = repository::advance_until(
            snapshot,
            &lineage,
            access_all,
            mode.consent.limits.max_artifact_bytes as usize,
            budget.deadline_at_ms()?.try_into().map_err(|_| {
                BenchmarkError::new("budget_clock_conflict", "Native deadline is invalid")
            })?,
        )
        .await?;
        budget.remaining_ms(now())?;
        Ok(Some(super::super::artifact_context::Input {
            before: package.artifact,
            lineage,
            access_all,
        }))
    }

    async fn bind_task_v2(&self, mut intent: RequestV2) -> Result<Binding> {
        if intent.schema_version != 2
            || intent.request_key.trim().is_empty()
            || intent.request_key.len() > 256
            || intent.context_id.trim().is_empty()
            || intent.context_id.len() > 256
            || !matches!(intent.surface.as_str(), "chat" | "wave")
            || intent.prompt.trim().is_empty()
            || intent.prompt.len() > 128 * 1024
            || (intent.surface == "chat" && intent.entry.is_some())
        {
            return Err(invalid(
                "Native v2 task needs bounded frozen identity and prompt",
            ));
        }
        if !intent.request_key.starts_with("owned-task:") {
            intent.request_key = format!(
                "owned-task:{}",
                fixtures::hash(intent.request_key.as_bytes())
            );
        }
        let lock = super::super::evaluation_lock(&format!("bind:{}", intent.request_key));
        let _guard = lock.lock().await;
        if let Some(id) = sqlx::query_scalar::<_, String>(
            "SELECT id FROM task_context_bindings WHERE request_key=?",
        )
        .bind(&intent.request_key)
        .fetch_optional(&self.store.pool)
        .await?
        {
            let saved = self.store.task_binding(&id).await?;
            let context = saved
                .context_v2
                .as_ref()
                .ok_or_else(|| invalid("A legacy request already owns this key"))?;
            if hash(&context.intent)? != hash(&intent)? {
                return Err(invalid(
                    "The frozen v2 request changed; recover its exact original intent",
                ));
            }
            return Ok(saved);
        }
        let frozen_key = intent.request_key.clone();
        let result: Result<Binding> = async {
        let Some(ModeEnvelope::V2(saved_mode)) = self.store.owned_task_mode_envelope(&intent.mode.context_id).await? else {return Err(invalid("Native v2 consent is missing"));};
        if saved_mode.artifact_hash != intent.mode.artifact_hash || saved_mode.request.surface != intent.surface {
            return Err(invalid("Native v2 consent identity changed"));
        }
        if intent.step_budget_seconds == 0 || intent.step_budget_seconds > saved_mode.consent.limits.timeout_seconds {
            return Err(invalid("Step cap exceeds native root consent"));
        }
        let root_budget = if let Some(entry) = &intent.entry {
            let root = self.store.task_binding(&entry.root_binding_id).await?;
            let context = root.context_v2.as_ref().ok_or_else(|| invalid("Native v2 root lineage is absent"))?;
            if context.intent.mode.artifact_hash != saved_mode.artifact_hash || context.intent.mode.context_id != saved_mode.request.context_id {
                return Err(invalid("Native root budget belongs to another consent"));
            }
            Some(context.root_budget.clone().ok_or_else(|| invalid("Legacy root cannot acquire the new wall budget recipe"))?)
        } else {None};
        let id = hash(&intent)?;
        let budget = self.store.reserve_task_budget(&intent.request_key,&id,&saved_mode.consent.artifact_hash,root_budget.as_ref(),
            saved_mode.consent.limits.timeout_seconds,intent.step_budget_seconds,&id).await?;
        let mode = self.require_mode_v2(&intent).await?;
        if intent.step_budget_seconds == 0 || intent.step_budget_seconds > mode.consent.limits.timeout_seconds {
            return Err(invalid("The step allowance must fit the acknowledged native root cap"));
        }
        let role = mode.consent.roles.iter().find(|role| role.source_id == intent.role_source_id
            && role.work_class_id == intent.work_class_id).cloned()
            .ok_or_else(|| invalid("Role and class were not authorized by this native consent"))?;
        let (mut entry,_) = self.committed_entry_v2(&intent, &mode,&budget,None).await?;
        let repository_context = self.repository_context_v2(&intent,&mode,&budget).await?;
        let budget_snapshot_at_ms=now();
        entry.remaining_budget_seconds=budget.remaining_seconds(budget_snapshot_at_ms)?;
        let mut limits = mode.consent.limits.clone(); limits.timeout_seconds = intent.step_budget_seconds;
        let task = learned::PublicTask {work_class_id: role.work_class_id.clone(), prompt: intent.prompt.clone(),
            fixtures: vec![], facets: Default::default(), role_id: Some(role.role_id.clone()),
            role_prompt: role.role_prompt.clone(), permissions: mode.consent.permissions.clone(),
            execution_profile: mode.consent.execution_profile.clone(), limits, entry: Some(entry),
            budget_recipe:Some(super::super::artifact_context::CLOCK_RECIPE.into()),
            repository_recipe:repository_context.as_ref().map(|input|input.before.recipe.clone()),
            repository_artifact:repository_context.as_ref().map(|input|input.before.clone())};
        let (base, choices) = self.native_pool_v2(&mode.consent).await?;
        let (mut candidates, unknown_reasons) = Self::native_prior_v2(&role, &base, &choices);
        if let Some(key) = &intent.hard_candidate_key {
            let pinned = choices.iter().find(|candidate| routing::candidate_key(&candidate.configuration) == *key)
                .ok_or_else(|| invalid("Pin is not an advertised native candidate and control choice"))?;
            if !candidates.iter().any(|candidate| routing::candidate_key(&candidate.configuration) == *key) {
                candidates.push(pinned.clone());
            }
            if candidates.len() > 32 {return Err(invalid("Pinned native pool exceeds selection bounds"));}
        }
        let contract = promotion::Contract::from_task(&task);
        let prior_keys: Vec<_> = candidates.iter().map(|candidate| routing::candidate_key(&candidate.configuration)).collect();
        let discovery = if intent.hard_candidate_key.is_some() {promotion::Discovery::Pinned}
            else if !mode.consent.complete || !unknown_reasons.is_empty() {promotion::Discovery::Refused("incomplete_native_role_preferences")} else {
            self.store.discover_active_policy(&contract, &choices, &prior_keys).await?
        };
        let certificate = match &discovery {promotion::Discovery::Unique(certificate) => Some(certificate), _ => None};
        // Policy candidates are an explicitly certified pool, resolved back to
        // actual inventory. Prior/pin never requires that model to exist.
        let model = match certificate {Some(certificate) => Some(self.store.selector_model(&certificate.model_id).await?), None => None};
        let prediction_candidates = if let Some(model) = &model {
            choices.iter().filter(|candidate| model.candidates.iter().any(|trained|
                trained.candidate_key == routing::candidate_key(&candidate.configuration)
                && trained.configuration.inventory_revision == candidate.configuration.inventory_revision)).cloned().collect()
        } else {candidates.clone()};
        let selection = executor::Request {request_key: intent.request_key.clone(), surface: intent.surface.clone(),
            context_id: intent.context_id.clone(), prediction: learned::PredictionRequest {task: task.clone(),
                target_family: format!("application:{id}"), target_group: format!("application:{id}"),
                candidates: candidates.clone(), hard_candidate_key: intent.hard_candidate_key.clone(), min_quality: 0.0},
            prior_keys, model_id: None};
        let mut decision = self.store.preview_executor_decision(selection).await?;
        decision.learned_status = discovery.reason().into();
        if let (Some(certificate), Some(model)) = (certificate, model.as_ref()) {
            let mut prediction = decision.request.prediction.clone();
            prediction.candidates = prediction_candidates; prediction.min_quality = certificate.min_prediction_quality;
            let result = learned::predict(model, &prediction)?;
            if let Some(chosen) = result.chosen.clone() {
                decision.chosen = Some(chosen); decision.chosen_key = result.chosen_key.clone();
                decision.source = "learned".into(); decision.learned_dispatch_allowed = true;
                decision.reason = "unique_exact_native_promoted_policy".into();
            } else {decision.reason = format!("native_prior_fallback:{}", result.reason);}
            decision.research_prediction = Some(result);
        } else if intent.hard_candidate_key.is_none() {
            decision.reason = format!("native_prior_fallback:{}", discovery.reason());
        }
        decision.policy_version = "executor-selection-v1/native-owned-task-v2".into();
        decision.artifact_hash = executor::artifact_hash(&decision)?;
        let decision = self.store.persist_executor_decision(decision).await?;
        let selected = certificate.map(|certificate| (certificate.id.clone(), certificate.artifact_hash.clone()));
        let context = ContextV2 {schema_version: 2, intent: intent.clone(), consent_hash: mode.consent.artifact_hash.clone(),
            role: role.clone(), envelope_hash: hash(&("owned-public-envelope-v1", super::super::runner::public_task_prompt(&task)?))?,
            complete: mode.consent.complete && unknown_reasons.is_empty(), unknown_reasons,
            prior_reason: role.prior_reason.clone(), inventory_hash: hash(&choices.iter().map(|row| &row.configuration).collect::<Vec<_>>())?,
            selected_policy_id: selected.as_ref().map(|selected| selected.0.clone()),
            selected_policy_hash: selected.as_ref().map(|selected| selected.1.clone()), policy_discovery: discovery.reason().into(),
            artifact_before:repository_context.as_ref().map(|input|input.before.clone()),
            artifact_lineage:repository_context.as_ref().map_or_else(Vec::new,|input|input.lineage.clone()),
            artifact_access_all:repository_context.as_ref().map(|input|input.access_all),
            root_budget:Some(budget),budget_snapshot_at_ms:Some(budget_snapshot_at_ms)};
        let request = Request {request_key: intent.request_key, surface: intent.surface, context_id: intent.context_id,
            promotion_id: selected.as_ref().map_or_else(String::new, |selected| selected.0.clone()),
            acknowledged_certificate_hash: selected.as_ref().map_or_else(String::new, |selected| selected.1.clone()),
            prompt: intent.prompt, hard_candidate_key: intent.hard_candidate_key, repository: mode.consent.repository,
            entry: intent.entry, wave_mode: Some(intent.mode)};
        let mut binding = Binding {id, created_at: now(), request, certificate_hash: selected.map_or_else(String::new, |selected| selected.1),
            task, context_hash: String::new(), decision, artifact_hash: String::new(), context_v2: Some(context)};
        binding.context_hash = binding.effective_context_hash()?; binding.artifact_hash = hash(&binding)?;
        sqlx::query("INSERT OR IGNORE INTO task_context_bindings(id,request_key,request_hash,binding_json,binding_hash) VALUES(?,?,?,?,?)")
            .bind(&binding.id).bind(&binding.request.request_key).bind(hash(&binding.request)?).bind(serde_json::to_string(&binding)?).bind(&binding.artifact_hash).execute(&self.store.pool).await?;
        self.store.task_binding(&binding.id).await
        }.await;
        match result {
            // An authority change or a budget already exhausted before any
            // binding or decision exists is a definite pre-write refusal.
            Err(error)
                if error.code == "invalid_task_authority" || error.code == "budget_timeout" =>
            {
                let bound: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM task_context_bindings WHERE request_key=?)",
                )
                .bind(&frozen_key)
                .fetch_one(&self.store.pool)
                .await?;
                if !bound && self.store.executor_decision(&frozen_key).await?.is_none() {
                    Err(BenchmarkError::new(
                        "owned_task_intent_refused",
                        format!(
                            "{}; native request has no binding or committed decision",
                            error.message
                        ),
                    ))
                } else {
                    Err(error)
                }
            }
            other => other,
        }
    }

    pub async fn prepare_owned_task_intent(&self, intent: PrepareIntent) -> Result<Prepared> {
        match intent {
            PrepareIntent::V1(request) => self.prepare_owned_task(request).await,
            PrepareIntent::V2(request) => {
                let binding = self.bind_task_v2(request).await?;
                self.prepare_bound_task(binding).await
            }
        }
    }

    pub(super) async fn validate_context_v2(&self, binding: &Binding) -> Result<()> {
        let Some(context) = &binding.context_v2 else {
            return self.require_task_mode(&binding.request).await;
        };
        let mode = self.require_mode_v2(&context.intent).await?;
        let mut limits = mode.consent.limits.clone();
        limits.timeout_seconds = context.intent.step_budget_seconds;
        if context.schema_version != 2
            || (binding.decision.learned_dispatch_allowed
                && (!context.complete || !context.unknown_reasons.is_empty()))
            || mode.consent.artifact_hash != context.consent_hash
            || !mode.consent.roles.contains(&context.role)
            || binding.task.work_class_id != context.role.work_class_id
            || binding.task.role_id.as_deref() != Some(context.role.role_id.as_str())
            || binding.task.role_prompt != context.role.role_prompt
            || binding.task.prompt != context.intent.prompt
            || !binding.task.fixtures.is_empty()
            || binding.task.permissions != mode.consent.permissions
            || binding.task.execution_profile != mode.consent.execution_profile
            || binding.task.limits != limits
            || hash(&(
                "owned-public-envelope-v1",
                super::super::runner::public_task_prompt(&binding.task)?,
            ))? != context.envelope_hash
        {
            return Err(invalid(
                "The final native transmitted role/context envelope changed",
            ));
        }
        let budget = context
            .root_budget
            .as_ref()
            .ok_or_else(|| invalid("Native v2 root wall budget authority is missing"))?;
        self.store
            .verify_task_budget(budget, &binding.id, &context.consent_hash)
            .await?;
        if binding.task.budget_recipe.as_deref()
            != Some(super::super::artifact_context::CLOCK_RECIPE)
            || binding.task.repository_artifact != context.artifact_before
            || binding.task.repository_recipe
                != context
                    .artifact_before
                    .as_ref()
                    .map(|artifact| artifact.recipe.clone())
        {
            return Err(invalid(
                "Native public budget/artifact recipe differs from the binding",
            ));
        }
        if self
            .committed_entry_v2(
                &context.intent,
                &mode,
                budget,
                context.budget_snapshot_at_ms,
            )
            .await?
            .0
            != binding
                .task
                .entry
                .clone()
                .ok_or_else(|| invalid("Native v2 entry is missing"))?
        {
            return Err(invalid(
                "Native committed history or remaining budget changed",
            ));
        }
        let (_, choices) = self.native_pool_v2(&mode.consent).await?;
        if hash(
            &choices
                .iter()
                .map(|row| &row.configuration)
                .collect::<Vec<_>>(),
        )? != context.inventory_hash
        {
            return Err(invalid(
                "Native candidate/account/runtime/control pool changed after binding",
            ));
        }
        if self
            .inspect_owned_task_mode(&mode.request)
            .await?
            .artifact_hash
            != context.consent_hash
        {
            return Err(invalid(
                "Native role or artifact context changed during final inventory validation",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
