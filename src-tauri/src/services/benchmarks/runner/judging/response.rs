//! Reading a judge's reply into a vote.
use super::*;

impl NativeBackend {
    pub(in super::super) async fn judge_response(
        &self,
        store: &Store,
        attempt: Attempt,
        version: &BenchmarkVersion,
        stop: JudgeStop,
        evidence: JudgeEvidence<'_>,
    ) -> Result<Attempt> {
        let identity = diagnostics::identity(&attempt);
        let mut trace = diagnostics::JudgeTrace {
            stage: "judge_panel",
            context: json!({}),
        };
        let result = self
            .judge_response_inner(store, attempt, version, stop, evidence, &mut trace)
            .await;
        match result {
            Err(error) => {
                Err(
                    diagnostics::record(store, &identity, trace.stage, error, None, trace.context)
                        .await,
                )
            }
            Ok(mut attempt) => {
                if let Some(reason) = attempt.reason.as_deref().filter(|r| *r != JUDGING_STOPPED) {
                    let recorded = diagnostics::record(
                        store,
                        &attempt,
                        trace.stage,
                        BenchmarkError::new("judge_panel_wait", reason),
                        None,
                        trace.context,
                    )
                    .await;
                    attempt.reason = Some(recorded.message);
                }
                Ok(attempt)
            }
        }
    }

    async fn judge_response_inner(
        &self,
        store: &Store,
        mut attempt: Attempt,
        version: &BenchmarkVersion,
        stop: JudgeStop,
        mut evidence: JudgeEvidence<'_>,
        trace: &mut diagnostics::JudgeTrace,
    ) -> Result<Attempt> {
        let ordinary = matches!(evidence, JudgeEvidence::OrdinaryAttempt);
        let criteria = rubric_criteria(&version.manifest);
        if criteria.is_empty() {
            return Ok(attempt);
        }
        let output = attempt.output.as_deref().unwrap_or_default();
        // Missing or out-of-contract answers are settled by evaluate().
        let Some(document) = judge_document(&version.manifest, output) else {
            return Ok(attempt);
        };
        let textual = text_judged(&version.manifest);
        trace.stage = "judge_renderer_readiness";
        let mut installed_renderer = if textual || ordinary {
            None
        } else {
            Some(crate::services::benchmarks::worker::ready().await?)
        };
        let (width, height) = judge_viewport(&version.manifest);
        let renderer = judge_renderer(&version.manifest);
        // Nothing is written until the panel can settle the rendering, so a
        // batch that cannot finish never replaces a settled score.
        if stop.halted(store).await? {
            attempt.reason = Some(JUDGING_STOPPED.into());
            return Ok(attempt);
        }
        let prompt = judge_prompt(&version.manifest, &criteria);
        trace.stage = "judge_recovery";
        let rejected = self
            .rejected_judges(&attempt, &version.manifest, &prompt, &renderer, &evidence)
            .await?;
        // A batch its run's stop cut short is finished by the judges it has
        // not asked yet, so the plan's reservation still covers it.
        let open = match stop
            .continues_batches()
            .then(|| {
                if ordinary {
                    ordinary_judging::recoverable(&attempt, &version.manifest, &prompt)
                } else {
                    recoverable_open_batch(&attempt.evaluations, &prompt, &renderer, &rejected)
                }
            })
            .flatten()
        {
            Some(open)
                if !ordinary
                    && !textual
                    && attempt
                        .evaluations
                        .iter()
                        .filter(|evaluation| {
                            evaluation.provenance == "render"
                                && evaluation
                                    .details
                                    .as_ref()
                                    .and_then(|details| details["judgeBatchId"].as_str())
                                    == Some(open.id.as_str())
                        })
                        .any(|evaluation| {
                            evaluation.details.as_ref().and_then(|details| {
                                details
                                    .pointer("/protocol/installedRendererRevision")
                                    .and_then(Value::as_str)
                            }) != installed_renderer.as_deref()
                        }) =>
            {
                return Err(BenchmarkError::new("selection_changed", "The renderer changed during the saved judge batch; requalify before continuing"));
            }
            Some(open) => {
                let bytes =
                    saved_rendering(&open, textual, version.manifest.limits.max_artifact_bytes)
                        .await?;
                Some((open, bytes))
            }
            None => None,
        };
        let (batch, judges, expected, votes, png) = match open {
            Some((mut open, png)) => {
                if ordinary {
                    let mut discovered = self
                        .judge_panel(
                            store,
                            &attempt,
                            &version.manifest,
                            &rejected,
                            false,
                            Some(&open),
                        )
                        .await?;
                    // A judge whose sandbox check went stale can take the
                    // seat once the check is renewed: the saved panel waits
                    // for that renewal, as a new short panel does, and gives
                    // up only when there is none to wait for.
                    if let Some(wait) = discovered.saved_panel_wait(
                        crate::services::benchmark_policy_check::renew_automatically,
                    ) {
                        attempt.reason = Some(wait?);
                        attempt.wait_until = Some(now() + JUDGE_POLICY_RETRY.as_millis() as i64);
                        return Ok(attempt);
                    }
                    discovered.renew_stale_in_background(
                        crate::services::benchmark_policy_check::renew_automatically,
                    );
                    let panel = discovered.seats;
                    if ordinary_judging::needs_reseating(&attempt, &open, &panel) {
                        let contributing = crate::services::benchmarks::workflow::judge_candidates(
                            store, &attempt,
                        )
                        .await?;
                        let candidates: Vec<_> = contributing.iter().collect();
                        open = ordinary_judging::reseat(
                            &mut attempt,
                            &version.manifest,
                            &open,
                            panel,
                            &candidates,
                        )?;
                        evidence.save(store, &attempt).await?;
                    }
                }
                let samples = open.expected / open.panel.len().max(1);
                let judges = seat_samples(&open.panel, samples, &open.asked);
                (open.id, judges, open.expected, open.asked.len(), png)
            }
            None => {
                trace.stage = "judge_panel_selection";
                // A calibration seats its one judge; a panel needs two.
                let discovered = match &evidence {
                    JudgeEvidence::Calibration { judge, .. } => {
                        DiscoveredJudgePanel::fixed(vec![judge.as_ref().clone()])
                    }
                    _ => {
                        self.judge_panel(
                            store,
                            &attempt,
                            &version.manifest,
                            &rejected,
                            !ordinary,
                            None,
                        )
                        .await?
                    }
                };
                let issue = discovered.issue(!rejected.is_empty());
                // Renewed only for a panel that would otherwise stop here.
                let renewing = issue.as_ref().and_then(|_| {
                    discovered.renew_stale_proofs(
                        crate::services::benchmark_policy_check::renew_automatically,
                    )
                });
                // A panel with its judges goes on now; the checks it found
                // stale are renewed beside it, for the panels that follow.
                if issue.is_none() {
                    discovered.renew_stale_in_background(
                        crate::services::benchmark_policy_check::renew_automatically,
                    );
                }
                let panel = discovered.seats;
                // A panel that seats a candidate's lab or own model is marked,
                // a frozen one's seats too, so boards can show or leave out
                // its scores.
                let (same_vendor_panel, own_model_panel) = match &evidence {
                    JudgeEvidence::Calibration { .. } => (false, false),
                    _ => {
                        let contributing = crate::services::benchmarks::workflow::judge_candidates(
                            store, &attempt,
                        )
                        .await?;
                        let candidates: Vec<_> = contributing.iter().collect();
                        (
                            same_vendor(&candidates, &panel),
                            own_model(&candidates, &panel),
                        )
                    }
                };
                if let Some(issue) =
                    issue.filter(|_| !matches!(evidence, JudgeEvidence::Calibration { .. }))
                {
                    if let Some(wait) = renewing {
                        attempt.reason = Some(wait);
                        attempt.wait_until = Some(now() + JUDGE_POLICY_RETRY.as_millis() as i64);
                        return Ok(attempt);
                    }
                    attempt.reason = Some(issue);
                    return Ok(attempt);
                }
                if !textual && installed_renderer.is_none() {
                    installed_renderer = Some(crate::services::benchmarks::worker::ready().await?);
                }
                let png = if textual {
                    document.as_bytes().to_vec()
                } else {
                    trace.stage = "judge_render";
                    match crate::services::benchmarks::worker::render(&document, width, height)
                        .await
                    {
                        // The marker names the renderer this very job ran on,
                        // which must still be the one the batch was opened for.
                        Ok((bytes, rendered)) => {
                            if installed_renderer.as_deref() != Some(rendered.as_str()) {
                                return Err(BenchmarkError::new(
                                    "selection_changed",
                                    "The renderer changed while rendering for the judge panel; requalify before continuing",
                                ));
                            }
                            bytes
                        }
                        // Nothing rendered and no judge was asked: the panel
                        // waits like one whose judges are busy.
                        Err(error) if unstarted_refusal(&error) => {
                            let recorded = diagnostics::record(
                                store,
                                &attempt,
                                "judge_render",
                                error,
                                None,
                                json!({}),
                            )
                            .await;
                            if recorded
                                .details
                                .as_ref()
                                .is_some_and(|d| d["diagnosticPersistenceFailed"] == true)
                            {
                                return Err(recorded);
                            }
                            log::info!(
                                "[benchmarks] judge rendering waits for attempt {}: {}",
                                attempt.id,
                                recorded.message
                            );
                            attempt.reason = Some(RENDERER_BUSY.into());
                            return Ok(attempt);
                        }
                        Err(error) => {
                            let error = diagnostics::record(
                                store,
                                &attempt,
                                "judge_render",
                                error,
                                None,
                                json!({}),
                            )
                            .await;
                            attempt.reason = Some(format!("Rendering failed: {}", error.message));
                            return Ok(attempt);
                        }
                    }
                };
                let directory = evidence.directory(store, &attempt);
                tokio::fs::create_dir_all(&directory).await?;
                let batch = uuid::Uuid::new_v4().to_string();
                // A calibration measures single answers; a panel may ask each
                // seat more than once (see `judge_samples`).
                let samples = match &evidence {
                    JudgeEvidence::Calibration { .. } => 1,
                    _ => judge_samples(&version.manifest),
                };
                let expected = panel.len() * samples;
                let mut protocol = if ordinary {
                    ordinary_judging::protocol(&version.manifest, &panel)
                } else {
                    judge_protocol(&version.manifest, &panel)
                };
                protocol["samplesPerJudge"] = json!(samples);
                protocol["expectedJudges"] = json!(expected);
                if let Some(installed) = &installed_renderer {
                    protocol["installedRendererRevision"] = json!(installed);
                }
                let protocol_hash = sampled_protocol_hash(
                    &panel,
                    &prompt,
                    &renderer,
                    if ordinary {
                        Some(crate::services::benchmarks::judge_pool::PANEL_RECIPE)
                    } else {
                        ordinary_recipe(&version.manifest)
                    },
                    samples,
                );
                let extension = if textual { "txt" } else { "png" };
                let path = directory.join(format!("rendering-{batch}.{extension}"));
                tokio::fs::write(&path, &png).await?;
                let settled = crate::services::benchmarks::analysis::score(&attempt).is_some();
                attempt.evaluations.push(Evaluation {
                    id: uuid::Uuid::new_v4().to_string(),
                    evaluator_revision: version.manifest.evaluator.revision.clone(),
                    verdict: "rendered".into(),
                    score: None,
                    reason: if textual {
                        "Text preserved for the judge panel"
                    } else {
                        "Rendered for the judge panel"
                    }
                    .into(),
                    created_at: now(),
                    provenance: "render".into(),
                    artifacts: vec![Artifact {
                        kind: if textual { "text" } else { "screenshot" }.into(),
                        path: path.to_string_lossy().into_owned(),
                        hash: hex::encode(Sha256::digest(&png)),
                        label: if textual { "Response" } else { "Rendering" }.into(),
                    }],
                    details: Some({
                        let mut details = json!({"judgeBatchId": batch,
                            "expectedJudges": expected, "protocolHash": protocol_hash,
                            "protocol": protocol});
                        if !rejected.is_empty() {
                            details["judgeRecovery"] = json!({
                                "recipe": "reselect-rejected-request-v1",
                                "rejectedJudges": rejected,
                            });
                        }
                        if same_vendor_panel {
                            details["sameVendor"] = json!(true);
                        }
                        if own_model_panel {
                            details["ownModel"] = json!(true);
                        }
                        if !matches!(evidence, JudgeEvidence::Calibration { .. })
                            && author_model_judges(&version.manifest, &panel)
                        {
                            details["authorModel"] = json!(true);
                        }
                        details
                    }),
                    judge: None,
                    usage: None,
                });
                if !settled {
                    attempt.outcome = Some("pending_review".into());
                }
                evidence.save(store, &attempt).await?;
                (batch, seat_samples(&panel, samples, &[]), expected, 0, png)
            }
        };
        let image = (!textual).then(|| OwnedTurnImage {
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png),
            mime_type: "image/png".into(),
        });
        // The response belongs to the evidence, not the scoring protocol:
        // including it in the protocol hash would split every comparison.
        let response =
            if textual {
                Some(String::from_utf8(png).map_err(|_| {
                    BenchmarkError::new("validation", "Saved judge text is not UTF-8")
                })?)
            } else {
                None
            };
        let dispatch_prompt = response.as_deref().map_or_else(
            || prompt.clone(),
            |response| text_judge_prompt(&prompt, response, ordinary_critical(&version.manifest)),
        );
        trace.stage = "judge_panel";
        let (end, votes) = ask_panel(
            &judges,
            expected,
            votes,
            &mut NativePanel {
                backend: self,
                store,
                attempt: &mut attempt,
                version,
                batch: &batch,
                prompt: &dispatch_prompt,
                image: image.as_ref(),
                response: response.as_deref(),
                criteria: &criteria,
                stop: &stop,
                evidence: &mut evidence,
            },
        )
        .await?;
        if votes >= expected {
            attempt.outcome = Some("judged".into());
        }
        attempt.reason = panel_reason(end, votes, expected, stop.cancelled()).map(str::to_owned);
        if attempt.reason.as_deref() == Some(PANEL_INCOMPLETE) {
            attempt.reason = Some(
                if ordinary && ordinary_judging::quota_interrupted(&attempt, &batch) {
                    JUDGE_RESELECTING.into()
                } else if ordinary
                    && stop.continues_batches()
                    && ordinary_judging::judge_interrupted(&attempt, &batch)
                {
                    // Its run asks again at once: the failed judge is left
                    // out (see `rejected_judges`), so each such pass seats
                    // one judge fewer of a pool that has an end.
                    JUDGE_REPLACING.into()
                } else {
                    incomplete_panel_reason(&attempt, &batch)
                },
            );
        }
        Ok(attempt)
    }
}
