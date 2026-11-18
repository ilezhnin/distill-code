use super::*;

/// A lease reaches the sandbox on standard input alone: the helper's
/// arguments name the attempt and the provider, never a credential.
#[test]
fn a_lease_is_staged_on_standard_input_alone() {
    let lease = crate::services::credential_lease::claude(
        br#"{"claudeAiOauth":{"accessToken":"invented-access-token","expiresAt":1800000000000}}"#,
        None,
    )
    .unwrap();
    let args = stage_arguments("text-invented", lease.provider().key());
    assert_eq!(args, ["stage", "text-invented", "claude"]);
    let input: serde_json::Value = serde_json::from_slice(&lease.stage_input()).unwrap();
    let encoded = input["files"][".credentials.json"].as_str().unwrap();
    assert!(!args
        .iter()
        .any(|arg| arg.contains("invented") && *arg != "text-invented"));
    assert!(!args.contains(&encoded));
}

fn status() -> String {
    let mut lines: Vec<String> = FILES
        .iter()
        .map(|(name, bytes)| format!("file {name} {}", resource_hash(bytes)))
        .collect();
    let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
        "../../../resources/benchmark-sandbox/runtime-pins.json"
    ))
    .unwrap();
    lines.extend(pins.iter().map(|(key, value)| format!("{key} {value}")));
    lines.push("netns up".into());
    lines.extend(budget("off"));
    lines.join("\n")
}

fn without(text: &str, prefix: &str) -> String {
    text.lines()
        .filter(|line| !line.starts_with(prefix))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_current_sandbox_has_no_drift_and_parses() {
    let text = status();
    assert_eq!(drift(&text), Drift::Current);
    assert!(parse_status(&text).is_ok());
}

#[test]
fn changed_helpers_need_only_the_network_free_update() {
    let (_, run) = FILES.iter().find(|(name, _)| *name == "bench-run").unwrap();
    let text = status().replace(
        &format!("file bench-run {}", resource_hash(run)),
        "file bench-run 00",
    );
    assert_eq!(drift(&text), Drift::Helpers(vec!["file bench-run".into()]));
    let down = status().replace("netns up", "netns down");
    assert_eq!(drift(&down), Drift::Helpers(vec!["netns up".into()]));
    let uncapped = without(&status(), "budget heavy-cap");
    assert_eq!(
        drift(&uncapped),
        Drift::Helpers(vec!["budget heavy-cap".into()])
    );
}

#[test]
fn a_changed_runtime_or_boot_configuration_needs_provisioning() {
    let Drift::Runtime(missing) = drift(&without(&status(), "binary /usr/bin/git")) else {
        panic!("git is part of the runtime");
    };
    assert_eq!(missing, ["binary /usr/bin/git"]);
    let Drift::Runtime(missing) = drift(&without(&status(), "file wsl.conf")) else {
        panic!("the boot configuration applies only after a restart");
    };
    assert_eq!(missing, ["file wsl.conf"]);
    // A runtime change lists what the helpers lack as well, never digests.
    let Drift::Runtime(missing) = drift(&without(&without(&status(), "node "), "netns")) else {
        panic!("node is part of the runtime");
    };
    assert_eq!(missing, ["node", "netns up"]);
    let Drift::Runtime(missing) = drift("") else {
        panic!("an empty report is an unprovisioned sandbox");
    };
    let digest = |word: &str| word.len() == 64 && word.bytes().all(|b| b.is_ascii_hexdigit());
    assert!(missing.len() > FILES.len());
    assert!(missing.iter().all(|key| !key.split(' ').any(digest)));
}

#[test]
fn the_pinned_runtime_names_the_builds_provisioning_installs() {
    let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
        "../../../resources/benchmark-sandbox/runtime-pins.json"
    ))
    .unwrap();
    let sources: serde_json::Value = serde_json::from_str(include_str!(
        "../../../resources/benchmark-sandbox/runtime-sources.json"
    ))
    .unwrap();
    assert_eq!(sources["node"]["version"], pins["node"].as_str());
    assert!(sources["node"]["url"]
        .as_str()
        .unwrap()
        .ends_with(&format!("/node-{}-linux-x64.tar.xz", pins["node"])));
    // Ubuntu's version names the upstream release `git --version` prints.
    let git = sources["git"]["version"].as_str().unwrap();
    assert!(git.starts_with(&format!("1:{}-", pins["git"])));
    for package in sources["git"]["packages"].as_array().unwrap() {
        let url = package["url"].as_str().unwrap();
        assert!(url.starts_with("https://"));
        assert!(url.contains(&git[2..]), "{url} is the pinned build");
        let sum = package["sha256"].as_str().unwrap();
        assert!(sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    let tools = sources["tools"].as_object().unwrap();
    for (id, spec) in tools {
        let version = pins
            .get(&format!("tool {id} version"))
            .unwrap_or_else(|| panic!("tool {id} is pinned"));
        assert_eq!(spec.as_str(), Some(version.as_str()));
    }
}

#[test]
fn a_session_verdict_names_its_own_job_and_the_candidate_s_command() {
    let id = "attempt-invented";
    assert_eq!(
        parse_session_verdict(
            id,
            br#"{"id": "attempt-invented", "candidateLimit": "memory", "victim": "python3", "at": 1.0}"#
        )
        .unwrap(),
        Some(SessionVerdict {
            candidate_limit: "memory".into(),
            victim: Some("python3".into()),
        })
    );
    // No verdict, a name the kernel never had, another job's verdict.
    assert_eq!(parse_session_verdict(id, b"{}").unwrap(), None);
    let named = parse_session_verdict(
        id,
        br#"{"id": "attempt-invented", "candidateLimit": "memory", "victim": "a\nb"}"#,
    )
    .unwrap()
    .unwrap();
    assert_eq!(named.victim.as_deref(), Some("ab"));
    assert!(parse_session_verdict(
        id,
        br#"{"id": "attempt-other", "candidateLimit": "memory", "victim": null}"#
    )
    .is_err());
    assert!(parse_session_verdict(id, b"not json").is_err());
}

#[test]
fn a_leased_run_s_outcome_comes_from_its_framed_last_stderr_line() {
    let nonce = "b".repeat(32);
    let token = "a".repeat(32);
    let mut stderr = format!(
        "resource_admitted: prep\ncopied invented\n{nonce} outcome {{\"token\": \"{token}\", \"infrastructureError\": null}}\n"
    )
    .into_bytes();
    let value = take_outcome_trailer(&mut stderr, &nonce).unwrap();
    assert_eq!(value["token"], token);
    assert!(value["infrastructureError"].is_null());
    assert_eq!(stderr, b"resource_admitted: prep\ncopied invented\n");
    // A tail that starts mid-character, or holds other bytes, before it.
    let mut cut = "\u{2713} checked\n".as_bytes()[1..].to_vec();
    cut.extend_from_slice(&[0xff, b'\n']);
    cut.extend_from_slice(
        format!("{nonce} outcome {{\"token\": \"{token}\", \"infrastructureError\": null}}\r\n")
            .as_bytes(),
    );
    assert!(take_outcome_trailer(&mut cut, &nonce).is_some());
    assert_eq!(
        cut,
        [&"\u{2713} checked\n".as_bytes()[1..], &[0xff, b'\n'][..]].concat()
    );
    // A line with another nonce, or not the last one, is not the receipt:
    // the separate outcome call decides then.
    let forged = "c".repeat(32);
    for text in [
        format!("{forged} outcome {{\"token\": \"{token}\", \"infrastructureError\": \"x\"}}\n"),
        format!(
            "{nonce} outcome {{\"token\": \"{token}\", \"infrastructureError\": null}}\nlater\n"
        ),
        "no receipt at all\n".to_owned(),
    ] {
        let mut stderr = text.clone().into_bytes();
        assert!(
            take_outcome_trailer(&mut stderr, &nonce).is_none(),
            "{text}"
        );
        assert_eq!(stderr, text.into_bytes());
    }
}

#[test]
fn an_artifact_the_helper_refuses_for_size_is_the_answer_past_its_cap() {
    // A candidate's canonical patch past the published cap,
    // after the admitting supervisor's own line.
    let refusal = artifact_over_budget(
        Some(2),
        "resource_admitted: prep\nArtifact Git output exceeds its byte limit\n",
    )
    .unwrap();
    assert_eq!(refusal.kind(), io::ErrorKind::FileTooLarge);
    assert_eq!(
        refusal.to_string(),
        "Artifact Git output exceeds its byte limit"
    );
    for reason in ARTIFACT_OVER_BUDGET {
        assert!(artifact_over_budget(Some(2), reason).is_some(), "{reason}");
    }
    // Other refusals, a size line that is not the last, other exit codes
    // and the published snapshot's own limit stay the sandbox's.
    for (code, reason) in [
        (Some(2), "Artifact Git operation refused: fatal: bad object"),
        (Some(2), "Snapshot contents exceed their byte limit"),
        (Some(2), "Invalid or over-budget artifact step patch"),
        (
            Some(2),
            "Artifact Git output exceeds its byte limit\nlater failure",
        ),
        (Some(2), "\n \n"),
        (Some(1), "Artifact Git output exceeds its byte limit"),
        (None, "Artifact Git output exceeds its byte limit"),
    ] {
        assert!(
            artifact_over_budget(code, reason).is_none(),
            "{code:?} {reason}"
        );
    }
}

#[test]
fn a_size_refusal_after_the_brokers_infrastructure_verdict_is_the_sandboxs() {
    let answer = |infrastructure: Option<&str>| Output {
        code: Some(2),
        stdout: Vec::new(),
        stderr: b"Artifact Git output exceeds its byte limit\n".to_vec(),
        truncated: false,
        infrastructure: infrastructure.map(str::to_owned),
        candidate_limit: None,
    };
    assert_eq!(
        artifact_size_refusal(&answer(None)).unwrap().kind(),
        io::ErrorKind::FileTooLarge
    );
    assert!(artifact_size_refusal(&answer(Some(
        "infrastructure_error: benchmark process tree did not stop"
    )))
    .is_none());
}

#[test]
fn an_artifact_timeout_after_the_supervisors_lines_is_the_roots_time() {
    let answer = |code, stderr: &str, infrastructure: Option<&str>| Output {
        code: Some(code),
        stdout: Vec::new(),
        stderr: stderr.as_bytes().to_vec(),
        truncated: false,
        infrastructure: infrastructure.map(str::to_owned),
        candidate_limit: None,
    };
    // The live shape: the admitting supervisor's line comes first.
    let timeout = artifact_timed_out(&answer(
        2,
        "resource_admitted: prep\nArtifact transition exceeded its time limit\n",
        None,
    ))
    .unwrap();
    assert_eq!(timeout.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        timeout.to_string(),
        "Artifact transition exceeded its time limit"
    );
    for reason in ARTIFACT_TIMED_OUT {
        assert!(
            artifact_timed_out(&answer(2, reason, None)).is_some(),
            "{reason}"
        );
    }
    // Not the last line, another exit, or the broker's own failure verdict.
    for (code, reason, infrastructure) in [
        (
            2,
            "Artifact transition exceeded its time limit\nlater failure",
            None,
        ),
        (1, "Artifact transition exceeded its time limit", None),
        (
            2,
            "Artifact transition exceeded its time limit",
            Some("infrastructure_error: benchmark process tree did not stop"),
        ),
    ] {
        assert!(
            artifact_timed_out(&answer(code, reason, infrastructure)).is_none(),
            "{code} {reason}"
        );
    }
}

#[test]
fn an_unanswered_broker_ask_is_a_refusal_only_inside_its_deadline() {
    let later = now_ms().unwrap() + 60_000;
    let timed_out = || io::Error::new(io::ErrorKind::TimedOut, "wsl.exe took too long");
    let refused = unanswered(timed_out(), later, RESERVATION_UNANSWERED);
    assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
    assert_eq!(refused.to_string(), RESERVATION_UNANSWERED);
    assert!(!reserved_nothing(&refused));
    let refused = unanswered(timed_out(), later, ADMISSION_UNANSWERED);
    assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
    // Past its deadline, or any other error, it stays what it was.
    assert_eq!(
        unanswered(timed_out(), 1, RESERVATION_UNANSWERED).kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        unanswered(io::Error::other("broken"), later, RESERVATION_UNANSWERED).kind(),
        io::ErrorKind::Other
    );
}

#[test]
fn a_control_group_at_its_limit_is_busy_for_a_moment() {
    for reason in [
        "OSError: [Errno 16] Device or resource busy",
        "FileExistsError: [Errno 17] File exists",
        "BlockingIOError: [Errno 11] Resource temporarily unavailable",
        "OSError: [Errno 12] Cannot allocate memory",
        "Traceback (most recent call last):\nMemoryError",
    ] {
        assert!(group_busy(reason), "{reason}");
    }
    for reason in [
        "OSError: [Errno 28] No space left on device",
        "OSError: [Errno 121] Remote I/O error",
        "capability_missing: scratch is not mounted",
    ] {
        assert!(!group_busy(reason), "{reason}");
    }
}

#[tokio::test]
async fn a_timed_out_control_call_is_asked_once_more() {
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let answer = |kinds: &'static [io::ErrorKind]| {
        calls.store(0, std::sync::atomic::Ordering::SeqCst);
        let calls = &calls;
        once_more_if_timed_out(move || async move {
            let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match kinds.get(call) {
                Some(kind) => Err(io::Error::new(*kind, "slow")),
                None => Ok(call),
            }
        })
    };
    assert_eq!(answer(&[io::ErrorKind::TimedOut]).await.unwrap(), 1);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    // Twice in a row, or another error, is the answer.
    assert_eq!(
        answer(&[io::ErrorKind::TimedOut, io::ErrorKind::TimedOut])
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        answer(&[io::ErrorKind::Other]).await.unwrap_err().kind(),
        io::ErrorKind::Other
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_failed_status_is_asked_again_before_it_is_the_answer() {
    let calls = std::sync::atomic::AtomicUsize::new(0);
    // Exit codes of the calls in order; past the list the call cannot
    // be read at all.
    let answer = |codes: &'static [i32]| {
        calls.store(0, std::sync::atomic::Ordering::SeqCst);
        let calls = &calls;
        again_while_failed(
            "status",
            &[Duration::ZERO, Duration::ZERO],
            move || async move {
                let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                match codes.get(call) {
                    Some(code) => Ok(Output {
                        code: Some(*code),
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        truncated: false,
                        infrastructure: None,
                        candidate_limit: None,
                    }),
                    None => Err(io::Error::new(io::ErrorKind::TimedOut, "slow")),
                }
            },
        )
    };
    let asked = || calls.load(std::sync::atomic::Ordering::SeqCst);
    // A working helper is asked once.
    assert!(answer(&[0]).await.unwrap().success());
    assert_eq!(asked(), 1);
    // One failure, or two, is a busy moment.
    assert!(answer(&[1, 0]).await.unwrap().success());
    assert_eq!(asked(), 2);
    assert!(answer(&[1, 137, 0]).await.unwrap().success());
    assert_eq!(asked(), 3);
    // A helper that fails every time is the answer, after the pauses.
    assert_eq!(answer(&[1, 1, 1, 0]).await.unwrap().code, Some(1));
    assert_eq!(asked(), 3);
    // A call that cannot be read is not asked again.
    assert_eq!(
        answer(&[1]).await.unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(asked(), 2);
}

#[test]
fn one_host_measurement_answers_admission_for_a_second() {
    let recent = RecentHeadroom::default();
    let at = Instant::now();
    assert!(recent.reuse(at).is_none());
    recent.keep(
        at,
        HostHeadroom {
            available_ram: 20 * GIB,
            available_commit: 30 * GIB,
            sandbox_volume_free: 100 * GIB,
        },
    );
    let reused = recent.reuse(at + Duration::from_millis(900)).unwrap();
    assert_eq!(reused.available_ram, 20 * GIB);
    assert!(check_headroom(&reused, 0).is_ok());
    // A second later the host is measured again.
    assert!(recent.reuse(at + HEADROOM_REUSE).is_none());
}

fn budget(cap: &str) -> Vec<String> {
    let mut lines = vec![format!("budget heavy-cap {cap}")];
    lines.extend(FIXED_BUDGET.map(str::to_owned));
    lines
}

#[test]
fn readiness_pins_the_dynamic_policy_but_not_the_operators_cap() {
    let base = status();
    let revision = parse_status(&base).unwrap().revision;
    for cap in ["off", "1", "2", "8"] {
        let changed = base.replace(&budget("off").join("\n"), &budget(cap).join("\n"));
        assert_eq!(parse_status(&changed).unwrap().revision, revision, "{cap}");
    }
    let off = budget("off").join("\n");
    for invalid in [
        off.replace("budget heavy-cap off", "budget heavy-cap 0"),
        off.replace("budget heavy-cap off", "budget heavy-cap 9"),
        off.replace("budget heavy-cap off", "budget heavy-cap two"),
        off.replace(
            "budget heavy-cap off",
            "budget heavy-cap off\nbudget heavy-cap 2",
        ),
        off.replace("budget heavy-cap off\n", ""),
        // The fixed policy's aggregate, or another policy, is not this one.
        off.replace("budget admission measured-load-v1\n", ""),
        off.replace(
            "budget admission measured-load-v1",
            "budget admission dynamic-v2",
        ),
        off.replace("budget memory 25769803776", "budget memory 19327352832"),
        off.replace("budget cpu 1500000/100000", "budget cpu 1450000/100000"),
        off.replace("light 33554432/8388608", "light 134217728/33554432"),
    ] {
        assert!(
            parse_status(&base.replace(&off, &invalid)).is_err(),
            "{invalid}"
        );
    }
    // A status from the fixed heavy lanes is not the dynamic policy.
    let fixed = base.replace(&off, "budget heavy-lanes 2\nbudget memory 19327352832");
    assert!(parse_status(&fixed).is_err());
}

#[test]
fn a_dynamic_admission_record_keeps_what_admission_measured() {
    // The shape bench-budget prints beside a dynamic reservation token.
    let printed = serde_json::json!({
        "policy": "measured-load-v1", "heavyCap": null, "lane": "light",
        "competing": {"repository": 2}, "competingHeavy": 2,
        "reservedMemory": 5 * GIB, "reservedCpu": 4, "memoryCurrent": 3 * GIB,
        "guestLoad": [0.8, 0.9, 0.7], "guestCpus": 16,
        "hostAvailableRam": 28 * GIB, "hostAvailableCommit": 20 * GIB,
        "guestMemAvailable": 25 * GIB, "hostCpuBusy": 0.18,
        "expectedMemory": 655360000, "cpuLine": 6, "sandboxCpu": 1.25,
        "cpuPressure": 0.02, "checkStall": null, "cpuCapacity": 11,
        "sessionBurst": 0.5, "repositorySessions": 2, "admittedBy": null,
    });
    let admission: Admission = serde_json::from_value(printed).unwrap();
    assert_eq!(admission.policy.as_deref(), Some("measured-load-v1"));
    assert_eq!(
        (
            admission.cpu_capacity,
            admission.session_burst,
            admission.repository_sessions
        ),
        (Some(11), Some(0.5), Some(2))
    );
    // A light job is admitted by neither CPU-heavy rule.
    assert_eq!(admission.admitted_by, None);
    assert_eq!(admission.heavy_lanes, None);
    assert_eq!(admission.cpu_line, Some(6));
    assert_eq!(admission.sandbox_cpu, Some(1.25));
    assert_eq!(admission.host_cpu_busy, Some(0.18));
    // Absent measurements stay absent in the sealed record.
    let sealed = serde_json::to_value(&admission).unwrap();
    assert!(sealed.get("checkStall").is_none() && sealed.get("heavyLanes").is_none());
}

#[test]
fn the_host_cpu_mean_averages_the_known_seconds() {
    // Unknown seconds (u32::MAX) are left out; no known second is no mean.
    assert_eq!(mean_share([200, 400, u32::MAX].into_iter()), Some(0.3));
    assert_eq!(mean_share([u32::MAX].into_iter()), None);
    assert_eq!(mean_share(std::iter::empty()), None);
    let mut admission: Admission = serde_json::from_value(serde_json::json!({
        "lane": "heavy", "competing": {}, "competingHeavy": 0,
        "reservedMemory": 0, "reservedCpu": 0, "memoryCurrent": 0,
        "guestLoad": [0.0, 0.0, 0.0], "guestCpus": 16, "guestMemAvailable": 0,
        "hostAvailableRam": 0, "hostAvailableCommit": 0,
    }))
    .unwrap();
    assert_eq!(admission.host_cpu_mean, None);
    admission.host_cpu_mean = Some(0.42);
    assert_eq!(
        serde_json::to_value(&admission).unwrap()["hostCpuMean"],
        0.42
    );
}

#[test]
fn a_session_admission_record_is_parsed_and_handed_out_once() {
    // The shape bench-budget prints beside a reservation token.
    let printed = serde_json::json!({
        "heavyLanes": 2, "lane": "heavy", "competing": {"text": 1, "repository": 1},
        "competingHeavy": 1, "reservedMemory": 8 * GIB, "reservedCpu": 3,
        "memoryCurrent": 3 * GIB, "guestLoad": [1.5, 0.75, 0.25], "guestCpus": 16,
        "hostAvailableRam": 28 * GIB, "hostAvailableCommit": 20 * GIB,
        "guestMemAvailable": 32 * GIB,
    });
    let mut admission: Admission = serde_json::from_value(printed.clone()).unwrap();
    assert_eq!(admission.competing_heavy, 1);
    assert_eq!(serde_json::to_value(&admission).unwrap(), printed);
    assert_eq!(admission.heavy_lanes, Some(2));
    let mut incomplete = printed;
    incomplete.as_object_mut().unwrap().remove("lane");
    assert!(serde_json::from_value::<Admission>(incomplete).is_err());
    admission.host_cpu_busy = Some(0.42);
    record_session_admission("invented-sandbox", admission.clone());
    assert_eq!(take_session_admission("invented-sandbox"), Some(admission));
    assert_eq!(take_session_admission("invented-sandbox"), None);
    assert_eq!(take_session_admission("another-invented-sandbox"), None);
}
#[test]
fn only_an_expired_native_deadline_is_a_budget_timeout() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let stopped = || io::Error::new(io::ErrorKind::TimedOut, "helper limit");
    assert_eq!(
        deadline_outcome(stopped(), now + 3_600_000).kind(),
        io::ErrorKind::Other
    );
    assert_eq!(
        deadline_outcome(stopped(), now.saturating_sub(1)).kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        deadline_outcome(io::Error::other("unrelated"), now + 3_600_000).kind(),
        io::ErrorKind::Other
    );
}

#[test]
fn only_the_helpers_own_answer_for_the_asked_tree_is_a_cache_miss() {
    let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let answer = |code, stdout: &str, infrastructure: Option<&str>| Output {
        code: Some(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        truncated: false,
        infrastructure: infrastructure.map(str::to_owned),
        candidate_limit: None,
    };
    assert!(not_cached(
        &answer(3, &format!("not cached {tree}\n"), None),
        tree
    ));
    // Another tree's miss, another exit, or a lease the broker failed
    // are no reason to send the snapshot and try again.
    let other = "0".repeat(40);
    assert!(!not_cached(
        &answer(3, &format!("not cached {other}\n"), None),
        tree
    ));
    assert!(!not_cached(
        &answer(70, &format!("not cached {tree}\n"), None),
        tree
    ));
    assert!(!not_cached(&answer(3, "", None), tree));
    // Only the helper's whole line: not one cut short or followed by more.
    assert!(!not_cached(
        &answer(3, &format!("not cached {tree}"), None),
        tree
    ));
    assert!(!not_cached(
        &answer(3, &format!("not cached {tree}\n\n"), None),
        tree
    ));
    assert!(!not_cached(
        &answer(
            3,
            &format!("not cached {tree}\n"),
            Some("infrastructure_error: x")
        ),
        tree
    ));
}

#[test]
fn a_failed_copy_reads_the_same_whatever_the_cache_did() {
    // Invented trees of this test alone: the record is process-wide.
    let tree = format!("{}3", "c".repeat(39));
    let answer = |code, stdout: &str, stderr: &str| Output {
        code: Some(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
        truncated: false,
        infrastructure: None,
        candidate_limit: None,
    };
    let failed = settle_copy(
        answer(70, &format!("cached {tree}\n"), "bench-copy: disk full"),
        &tree,
        true,
    )
    .unwrap_err()
    .to_string();
    assert!(!failed.contains("cached"), "{failed}");
    assert!(failed.contains("disk full"), "{failed}");
    assert!(!snapshot_cached(&tree));
    assert!(settle_copy(answer(0, &format!("cached {tree}\n"), ""), &tree, true).unwrap());
    assert!(snapshot_cached(&tree));
    let miss = answer(
        3,
        &format!("not cached {tree}\n"),
        "unsafe cache; copying without the cache\n",
    );
    assert_eq!(
        cache_miss_warning(&miss).as_deref(),
        Some("unsafe cache; copying without the cache")
    );
    assert!(!settle_copy(miss, &tree, false).unwrap());
    assert!(!snapshot_cached(&tree));
    assert_eq!(cache_miss_warning(&answer(3, "", " \n")), None);
}

#[test]
fn a_check_answer_that_does_not_apply_still_teaches_the_cache() {
    let tree = format!("{}4", "c".repeat(39));
    let answer = |code, stdout: &str| Output {
        code: Some(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        truncated: false,
        infrastructure: None,
        candidate_limit: None,
    };
    // Asked from the cache, a placed snapshot is held whatever the answer.
    assert_eq!(check_cache_held(&answer(2, ""), &tree, false), Some(true));
    assert_eq!(check_cache_held(&answer(0, ""), &tree, false), Some(true));
    // Sent, it is held only when the helper said it kept it.
    assert_eq!(check_cache_held(&answer(2, ""), &tree, true), Some(false));
    assert_eq!(
        check_cache_held(&answer(0, &format!("cached {tree}\n")), &tree, true),
        Some(true)
    );
    // A failed preparation says nothing about the cache.
    assert_eq!(check_cache_held(&answer(70, ""), &tree, false), None);
}

#[test]
fn the_cache_is_asked_only_for_trees_the_sandbox_said_it_kept() {
    // Invented trees of this test alone: the record is process-wide.
    let tree = format!("{}1", "c".repeat(39));
    let other = format!("{}2", "c".repeat(39));
    let answer = |stdout: &str| Output {
        code: Some(0),
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        truncated: false,
        infrastructure: None,
        candidate_limit: None,
    };
    assert!(!snapshot_cached(&tree));
    // A sent archive counts only when bench-unpack says it kept it.
    let stored = answer(&format!("cached {tree}\ncopied attempt\n"));
    assert!(kept(&stored, &tree));
    assert!(!kept(&stored, &other));
    assert!(!kept(&answer("copied attempt\n"), &tree));
    assert!(!kept(&answer(&format!("cached {tree}x\n")), &tree));
    learn_cache(&tree, kept(&stored, &tree));
    assert!(snapshot_cached(&tree) && !snapshot_cached(&other));
    // A miss forgets it again, so the next use sends the archive.
    learn_cache(&tree, false);
    assert!(!snapshot_cached(&tree));
}

#[test]
fn a_reason_reads_the_same_whether_the_snapshot_was_sent_or_cached() {
    let tree = "d".repeat(40);
    let answer = |stdout: Vec<u8>| Output {
        code: Some(2),
        stdout,
        stderr: b"the answer does not apply to the snapshot\n".to_vec(),
        truncated: false,
        infrastructure: None,
        candidate_limit: None,
    };
    let sent = answer(without_cache_line(
        format!("cached {tree}\n").as_bytes(),
        &tree,
    ));
    let cached = answer(without_cache_line(b"", &tree));
    assert_eq!(sent.reason(), cached.reason());
    // Only that exact line goes; every other byte stays.
    assert_eq!(
        without_cache_line(
            format!("one\ncached {tree}\ncached {tree}x\nprepared id\n").as_bytes(),
            &tree
        ),
        format!("one\ncached {tree}x\nprepared id\n").into_bytes()
    );
    assert_eq!(
        without_cache_line(format!("cached {tree}").as_bytes(), &tree),
        format!("cached {tree}").into_bytes()
    );
}

#[test]
fn a_snapshot_tree_is_a_full_lowercase_git_object_id() {
    assert!(valid_tree(&"a".repeat(40)).is_ok());
    assert!(valid_tree(&"0123456789abcdef".repeat(4)).is_ok());
    for tree in [
        "A".repeat(40),
        "a".repeat(39),
        "g".repeat(40),
        "a".repeat(41),
        String::new(),
    ] {
        assert!(valid_tree(&tree).is_err(), "{tree}");
    }
    assert!(valid_tree(&format!("-{}", "a".repeat(39))).is_err());
}

#[test]
fn linux_source_identity_canonicalizes_windows_line_endings() {
    assert_eq!(
        resource_hash(b"first\nsecond\n"),
        resource_hash(b"first\r\nsecond\r\n")
    );
    assert_ne!(
        resource_hash(b"first\rsecond\n"),
        resource_hash(b"first\nsecond\n")
    );
}

#[test]
fn metadata_and_transport_do_not_charge_a_linux_class_ceiling() {
    let headroom = HostHeadroom {
        available_ram: 3 * GIB,
        available_commit: 3 * GIB,
        sandbox_volume_free: 40 * GIB,
    };
    assert!(check_headroom(&headroom, 0).is_ok());
    assert!(check_headroom(&headroom, 512 * 1024 * 1024).is_ok());
    assert!(check_headroom(&headroom, 2 * GIB).is_err());
    assert!(check_headroom(
        &HostHeadroom {
            available_ram: GIB,
            ..headroom
        },
        0
    )
    .is_err());
}

#[test]
fn admission_keeps_desktop_ram_commit_and_actual_sandbox_volume_floors() {
    let healthy = HostHeadroom {
        available_ram: 28 * GIB,
        available_commit: 20 * GIB,
        sandbox_volume_free: 57 * GIB,
    };
    assert!(check_headroom(&healthy, 8 * GIB).is_ok());
    assert!(check_headroom(
        &HostHeadroom {
            available_ram: 3 * GIB,
            ..healthy
        },
        2 * GIB
    )
    .is_err());
    assert!(check_headroom(
        &HostHeadroom {
            available_commit: 3 * GIB,
            ..healthy
        },
        2 * GIB
    )
    .is_err());
    assert!(check_headroom(
        &HostHeadroom {
            sandbox_volume_free: 29 * GIB,
            ..healthy
        },
        2 * GIB
    )
    .is_err());
}

#[test]
fn admission_diagnostics_keep_the_measurement_and_required_floor() {
    let healthy = HostHeadroom {
        available_ram: 28 * GIB,
        available_commit: 20 * GIB,
        sandbox_volume_free: 57 * GIB,
    };
    for (headroom, field, value, floor) in [
        (
            HostHeadroom {
                available_ram: 3 * GIB,
                ..healthy
            },
            "available_ram_bytes",
            3 * GIB,
            HOST_MEMORY_FLOOR,
        ),
        (
            HostHeadroom {
                available_commit: 3 * GIB,
                ..healthy
            },
            "available_commit_bytes",
            3 * GIB,
            HOST_MEMORY_FLOOR,
        ),
        (
            HostHeadroom {
                sandbox_volume_free: 29 * GIB,
                ..healthy
            },
            "volume_free_bytes",
            29 * GIB,
            30 * GIB,
        ),
    ] {
        let error = check_headroom(&headroom, 2 * GIB).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        let reason = error.to_string();
        assert!(reason.contains(&format!("{field}={value}")), "{reason}");
        assert!(reason.contains(&format!("floor_bytes={floor}")), "{reason}");
        if field != "volume_free_bytes" {
            assert!(
                reason.contains(&format!("reservation_bytes={}", 2 * GIB)),
                "{reason}"
            );
        }
        let expired = host_queue_expired(&reason).to_string();
        assert!(
            expired.ends_with(&reason),
            "Queue expiry must keep its actual admission refusal"
        );
    }
}

#[test]
fn readiness_pins_resources_and_runtime_and_never_infers_a_sign_in() {
    let base = status();
    let ready = parse_status(&base).unwrap();
    assert!(ready.require_account("claude", "account-1").is_err());
    let signed = parse_status(&format!("{base}\naccount claude account-1 yes")).unwrap();
    assert!(signed.require_account("claude", "account-1").is_ok());
    assert_eq!(ready.revision, signed.revision);
    assert!(parse_status(&base.replace("file bench-run", "file other")).is_err());
    assert!(
        parse_status(&base.replace("tool codex-acp file codex", "tool changed file codex"))
            .is_err()
    );
    assert!(parse_status(&base.replace("netns up", "netns down")).is_err());
    for id in ["", "../other", "/tmp/file", "a;b"] {
        assert!(valid_id(id).is_err());
    }
}

#[test]
fn oauth_health_must_cover_the_whole_attempt_and_cleanup() {
    let base = format!("{}\naccount claude account-1 yes", status());
    let now = 1_800_000_000_000;
    let deadline = now + 600_000 + 300_000;
    let check = |health: &str| {
        parse_status(&format!("{base}\naccount-health claude account-1 {health}"))
            .unwrap()
            .require_account_window("claude", "account-1", now, 600)
    };
    assert!(check(&format!("oauth current {}", deadline + 1)).is_ok());
    for health in [
        format!("oauth current {deadline}"),
        format!("oauth current {}", now + 1),
        format!("oauth expired {}", deadline + 1),
        "oauth current -".into(),
        "oauth unknown -".into(),
        "unknown unknown -".into(),
        "oauth missing -".into(),
        "oauth invalid -".into(),
    ] {
        assert!(check(&health).is_err(), "{health}");
    }
    assert!(parse_status(&base)
        .unwrap()
        .require_account_window("claude", "account-1", now, 600)
        .is_err());
    let ready = parse_status(&format!(
        "{base}\naccount-health claude account-1 oauth current {}",
        deadline + 1
    ))
    .unwrap();
    assert!(ready
        .require_account_window("claude", "account-2", now, 600)
        .is_err());
    assert!(ready
        .require_account_window("claude", "account-1", -1, 600)
        .is_err());
    assert!(ready
        .require_account_window("claude", "account-1", now, 0)
        .is_err());
    assert!(ready
        .require_account_window("claude", "account-1", i64::MAX, 600)
        .is_err());
}

/// The admission window: the attempt's time limit and the cleanup margin.
#[test]
fn the_admission_deadline_adds_the_cleanup_margin() {
    assert_eq!(
        admission_deadline(1_800_000_000_000, 600).unwrap(),
        1_800_000_000_000 + 600_000 + 300_000
    );
    assert!(admission_deadline(i64::MAX, 600).is_err());
}

#[test]
fn credential_health_is_volatile_evidence_not_runtime_identity() {
    let base = status();
    let original = parse_status(&base).unwrap();
    for health in [
        "oauth expired 100",
        "oauth current 1800001000000",
        "unbounded unknown -",
    ] {
        let signed = parse_status(&format!(
            "{base}\naccount grok account-1 yes\naccount-health grok account-1 {health}"
        ))
        .unwrap();
        assert_eq!(signed.revision, original.revision);
    }
    let unbounded = parse_status(&format!(
        "{base}\naccount grok account-1 yes\naccount-health grok account-1 unbounded unknown -"
    ))
    .unwrap();
    assert!(unbounded
        .require_account_window("grok", "account-1", 1_800_000_000_000, 3600)
        .is_ok());
}

#[test]
fn a_refreshed_shared_grant_cannot_extend_an_earlier_session_snapshot() {
    let start = 1_800_000_000_000;
    let prefix = format!(
        "{}\naccount claude account-1 yes\naccount-health claude account-1 oauth current",
        status()
    );
    let original = parse_status(&format!("{prefix} {}", start + 1_000_000)).unwrap();
    assert!(original
        .require_account_window("claude", "account-1", start, 600)
        .is_ok());
    let after_setup = start + 200_000;
    let refreshed = parse_status(&format!("{prefix} {}", start + 2_000_000)).unwrap();
    assert!(refreshed
        .require_account_window("claude", "account-1", after_setup, 600)
        .is_ok());
    assert!(original
        .require_account_window("claude", "account-1", after_setup, 600)
        .is_err());
}

#[test]
fn providers_without_an_expiry_adapter_keep_existing_account_checks() {
    for provider in ["codex", "kimi"] {
        let base = status();
        let signed = parse_status(&format!(
            "{base}\naccount {provider} account-1 yes\naccount-health {provider} account-1 unknown unknown -"
        ))
        .unwrap();
        assert!(signed
            .require_account_window(provider, "account-1", 1_800_000_000_000, 3600)
            .is_ok());
        assert!(signed
            .require_account_window(provider, "account-2", 1_800_000_000_000, 3600)
            .is_err());
    }
}

/// A Z.ai key is an API key: signed in while bench-login stored one, with
/// no expiry claim, and part of no runtime identity.
#[test]
fn a_zai_key_is_an_unbounded_sign_in_outside_runtime_identity() {
    let base = status();
    let signed = parse_status(&format!(
        "{base}\naccount zai account-1 yes\naccount-health zai account-1 unbounded unknown -"
    ))
    .unwrap();
    assert_eq!(signed.revision, parse_status(&base).unwrap().revision);
    assert!(signed
        .require_account_window("zai", "account-1", 1_800_000_000_000, 3600)
        .is_ok());
    let missing = parse_status(&format!(
        "{base}\naccount zai account-1 no\naccount-health zai account-1 unknown missing -"
    ))
    .unwrap();
    assert!(missing.require_account("zai", "account-1").is_err());
    // The pinned OpenCode and its ripgrep are part of the runtime.
    for pin in [
        "binary /opt/distill-tools/bin/opencode",
        "binary /opt/distill-tools/zai/bin/rg",
        "tool zai file opencode",
    ] {
        let line = base.lines().find(|line| line.starts_with(pin)).unwrap();
        assert!(parse_status(&base.replace(line, &format!("{pin} changed"))).is_err());
    }
}

#[test]
fn malformed_or_duplicate_credential_health_is_rejected_without_echoing_input() {
    let base = status();
    for health in [
        "claude account-1 oauth current",
        "claude account-1 invented current -",
        "claude account-1 oauth invented -",
        "claude account-1 oauth current secret-value",
        "claude account-1 oauth current -1",
        "claude account-1 oauth current 0",
        "claude ../account oauth current 1000",
        "claude account-1 oauth current 1000\naccount-health claude account-1 oauth current 2000",
    ] {
        let error = parse_status(&format!("{base}\naccount-health {health}"))
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-value"));
    }
}

/// A refresh bench-auth could not settle is reported per account, apart
/// from runtime identity; the account stays admissible on its stored
/// grant, and a malformed report refuses the status like bad health.
#[test]
fn credential_conflicts_are_reported_per_account_outside_runtime_identity() {
    let base = format!(
        "{}\naccount grok account-1 yes\naccount-health grok account-1 oauth current 1800009000000",
        status()
    );
    let clean = parse_status(&base).unwrap();
    assert!(clean.conflicts.is_empty());
    let conflicted = parse_status(&format!("{base}\naccount-conflict grok account-1 2")).unwrap();
    assert_eq!(conflicted.revision, clean.revision);
    assert_eq!(
        conflicted
            .conflicts
            .get(&("grok".to_owned(), "account-1".to_owned())),
        Some(&2)
    );
    assert!(conflicted
        .require_account_window("grok", "account-1", 1_800_000_000_000, 600)
        .is_ok());
    report_conflicts(&conflicted);
    // Copies kept aside after a failed save are counted, never refused.
    assert_eq!(clean.unsaved, 0);
    let unsaved = parse_status(&format!("{base}\nauth-unsaved 2")).unwrap();
    assert_eq!(
        (unsaved.unsaved, unsaved.revision.as_str()),
        (2, clean.revision.as_str())
    );
    assert_eq!(
        parse_status(&format!("{base}\nauth-unsaved two"))
            .unwrap()
            .unsaved,
        0
    );
    report_conflicts(&unsaved);
    for line in [
        "account-conflict grok account-1",
        "account-conflict grok account-1 0",
        "account-conflict grok account-1 two",
        "account-conflict grok ../account 1",
        "account-conflict grok account-1 1\naccount-conflict grok account-1 2",
    ] {
        assert!(parse_status(&format!("{base}\n{line}")).is_err(), "{line}");
    }
}
#[test]
fn a_continuing_owner_is_marked_only_while_its_guard_lives() {
    let owner = "invented-step:1".to_owned();
    assert!(!continues(&owner));
    let guard = Continuing::new(owner.clone());
    assert!(continues(&owner));
    assert!(!continues("invented-step:2"));
    drop(guard);
    assert!(!continues(&owner));
}

/// Readiness checks within the reuse window share one observation, and
/// checks that arrive while it runs wait for it; a receipt's fresh check,
/// an expired window or a failure observes again.
#[tokio::test]
async fn recent_observations_are_shared_within_their_window_and_never_failures() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let recent: Arc<Recent<(), usize>> = Arc::new(Recent::new(Duration::from_millis(200)));
    let observed = Arc::new(AtomicUsize::new(0));
    let observe = |observed: Arc<AtomicUsize>| {
        move || async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok::<_, io::Error>(observed.fetch_add(1, Ordering::SeqCst) + 1)
        }
    };
    let concurrent: Vec<_> = (0..4)
        .map(|_| {
            let (recent, observed) = (recent.clone(), observed.clone());
            tokio::spawn(async move { recent.get((), false, observe(observed)).await })
        })
        .collect();
    for check in concurrent {
        assert_eq!(check.await.unwrap().unwrap(), 1);
    }
    assert_eq!(observed.load(Ordering::SeqCst), 1);
    assert_eq!(
        recent
            .get((), false, observe(observed.clone()))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        recent
            .get((), true, observe(observed.clone()))
            .await
            .unwrap(),
        2
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        recent
            .get((), false, observe(observed.clone()))
            .await
            .unwrap(),
        3
    );
    let failed: Recent<(), usize> = Recent::new(Duration::from_secs(60));
    assert!(failed
        .get((), false, || async {
            Err::<usize, _>(io::Error::other("refused"))
        })
        .await
        .is_err());
    assert_eq!(
        failed
            .get((), false, || async { Ok::<_, io::Error>(7) })
            .await
            .unwrap(),
        7
    );
    // Fresh checks that ask together share one observation once the
    // one already running (which started before they asked) is done.
    let together: Arc<Recent<(), usize>> = Arc::new(Recent::new(Duration::from_secs(60)));
    let count = Arc::new(AtomicUsize::new(0));
    let asked: Vec<_> = (0..6)
        .map(|_| {
            let (together, count) = (together.clone(), count.clone());
            tokio::spawn(async move { together.get((), true, observe(count)).await })
        })
        .collect();
    for check in asked {
        assert!(check.await.unwrap().unwrap() >= 1);
    }
    assert!(count.load(Ordering::SeqCst) <= 2, "{count:?}");
    // A forgotten observation is observed again.
    failed.forget();
    assert_eq!(
        failed
            .get((), false, || async { Ok::<_, io::Error>(8) })
            .await
            .unwrap(),
        8
    );
    // Each key is its own observation.
    let keyed: Recent<&str, &str> = Recent::new(Duration::from_secs(60));
    assert_eq!(
        keyed
            .get("a", false, || async { Ok::<_, io::Error>("a") })
            .await
            .unwrap(),
        "a"
    );
    assert_eq!(
        keyed
            .get("b", false, || async { Ok::<_, io::Error>("b") })
            .await
            .unwrap(),
        "b"
    );
    assert_eq!(
        keyed
            .get("a", false, || async { Ok::<_, io::Error>("x") })
            .await
            .unwrap(),
        "a"
    );
}

#[tokio::test]
async fn output_is_drained_and_only_a_bounded_tail_is_kept() {
    let bytes = vec![b'x'; 100_000];
    let (tail, truncated) = read_tail(bytes.as_slice(), 100).await.unwrap();
    assert_eq!(tail, vec![b'x'; 100]);
    assert!(truncated);
}

/// Host preparations share the measured Windows headroom by reserving
/// their buffers' memory, with no count of their own: a second that the
/// first's reservation leaves short waits for it and starts once it ends,
/// and a wait past its deadline is the queue's refusal, as a
/// qualification control met on 2026-10-17; one the host is short for
/// even alone is refused at once; a deadline already gone is the
/// caller's own.
#[tokio::test]
async fn host_preparations_share_the_measured_headroom_by_reservation() {
    let reservations: &'static HostReservations = Box::leak(Box::default());
    let measure = |ram: u64| {
        move || {
            tokio::task::spawn_blocking(move || {
                Ok::<_, io::Error>(HostHeadroom {
                    available_ram: ram,
                    available_commit: 40 * GIB,
                    sandbox_volume_free: 100 * GIB,
                })
            })
        }
    };
    let now = || now_ms().unwrap();
    // 7 GiB free: one preparation's 3.5 GiB fits above the 2 GiB floor,
    // a second beside it does not.
    let first = reserve_host_preparation(
        reservations,
        HOST_PREPARATION_BYTES,
        now() + 60_000,
        measure(7 * GIB),
    )
    .await
    .unwrap();
    let refused = reserve_host_preparation(
        reservations,
        HOST_PREPARATION_BYTES,
        now() + 50,
        measure(7 * GIB),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
    let refusal = refused.to_string();
    assert!(refusal.starts_with(
        "resource_busy: benchmark host preparation queue expired before worker startup; last refusal:"
    ));
    assert!(refusal.contains("Windows available RAM"));
    assert!(refusal.contains(&format!("reserved_bytes={HOST_PREPARATION_BYTES}")));
    let next = tokio::spawn(reserve_host_preparation(
        reservations,
        HOST_PREPARATION_BYTES,
        now() + 60_000,
        measure(7 * GIB),
    ));
    tokio::task::yield_now().await;
    drop(first);
    let second = next.await.unwrap().unwrap();
    drop(second);
    // Short even alone: refused at once, naming the floor.
    let short = reserve_host_preparation(
        reservations,
        HOST_PREPARATION_BYTES,
        now() + 60_000,
        measure(3 * GIB),
    )
    .await
    .unwrap_err();
    assert_eq!(short.kind(), io::ErrorKind::WouldBlock);
    assert!(short.to_string().contains("2 GiB"), "{short}");
    // A deadline already gone before the queue is the caller's own.
    let late = reserve_host_preparation(
        reservations,
        HOST_PREPARATION_BYTES,
        now() - 1,
        measure(60 * GIB),
    )
    .await
    .unwrap_err();
    assert_eq!(late.kind(), io::ErrorKind::TimedOut);
}

/// Output before the broker's refusal never hides it: the runner and the
/// host read an unstarted refusal from the message's start.
#[test]
fn a_refusal_names_its_line_whatever_was_printed_before_it() {
    let refused = admission_refusal(
        "warning: fictional noise\nresource_busy: sandbox process budget leaves no room for this job; no provider process started".into(),
    );
    assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
    assert_eq!(
        refused.to_string(),
        "resource_busy: sandbox process budget leaves no room for this job; no provider process started"
    );
}

/// A refused retry skips the setup's second clean only when the refusal
/// came before the broker made anything of the session.
#[test]
fn only_a_refusal_before_any_group_reserved_nothing() {
    let queued = io::Error::new(
        io::ErrorKind::WouldBlock,
        "resource_busy: benchmark resource capacity is queued; no provider process started",
    );
    assert!(reserved_nothing(&queued));
    assert!(!reserved_nothing(&io::Error::new(
        io::ErrorKind::WouldBlock,
        GROUP_BUSY
    )));
    assert!(!reserved_nothing(&io::Error::new(
        io::ErrorKind::WouldBlock,
        RESERVATION_UNANSWERED
    )));
    assert!(!reserved_nothing(&io::Error::new(
        io::ErrorKind::TimedOut,
        "Sandbox command timed out"
    )));
}

/// A lease that waits in a busy queue until its window closes is refused
/// as busy, never as an expired native deadline, however the closing is
/// seen; a deadline that fires while the window is still open stays one.
#[tokio::test]
async fn a_lease_window_closing_in_the_queue_is_a_busy_refusal() {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    };
    let busy = |reason: &str| io::Error::new(io::ErrorKind::WouldBlock, reason.to_owned());
    let queued =
        "resource_busy: benchmark resource capacity is queued; no provider process started";
    // The broker answers busy until the window closes, and the deadline
    // check before the next ask sees it close, as on 2026-10-16 behind an
    // interactive sign-in that held the light lane.
    let window = now() + 60;
    let refused = admit::<(), _>(window, || async move {
        remaining_ms(window)?;
        Err(busy(queued))
    })
    .await
    .unwrap_err();
    assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
    assert!(refused.to_string().starts_with("resource_busy:"));
    // Each way the closing is seen, deterministically: the deadline check
    // ("Native sandbox deadline expired"), and the broker's busy answer,
    // including the expired Windows headroom evidence of the host gate.
    let closed = now() - 1;
    for reason in [
        remaining_ms(closed).unwrap_err(),
        busy(queued),
        busy("resource_busy: Windows headroom evidence expired before execution; no provider process started"),
    ] {
        let mut reason = Some(reason);
        let refused = admit::<(), _>(closed, || {
            let reason = reason.take().expect("asked once");
            async move { Err(reason) }
        })
        .await
        .unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(
            refused.to_string(),
            "resource_busy: benchmark preparation queue expired before worker startup"
        );
    }
    // A broker too slow to answer inside an open window gave nothing: it
    // is asked again, never reported as the job's own timeout (a check's
    // verdict once read it as the candidate's).
    let mut asks = 0;
    let granted = admit(now() + 60_000, || {
        asks += 1;
        let first = asks == 1;
        async move {
            if first {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Sandbox operation exceeded its time limit",
                ))
            } else {
                Ok(7)
            }
        }
    })
    .await
    .unwrap();
    assert_eq!((granted, asks), (7, 2));
}

/// 10-18: a rescore's 122 renders waiting for room each asked the broker
/// every second, and the processes those asks started exhausted the
/// sandbox's process budget. One asker per class asks at a time now.
#[tokio::test]
async fn askers_of_one_class_ask_the_broker_in_turn_and_never_hold_another_class() {
    let (release, granted) = tokio::sync::oneshot::channel::<()>();
    let release = std::sync::Mutex::new(Some(release));
    let first_asks = std::sync::atomic::AtomicUsize::new(0);
    let second_asks = std::sync::atomic::AtomicUsize::new(0);
    let gate = tokio::sync::Mutex::new(Some(granted));
    let deadline = now_ms().unwrap() + 60_000;
    // The first renders' asker waits for room until the test lets it in.
    // An ask counts once it runs, in its turn, not when it is made.
    let (first_counter, second_counter, gate) = (&first_asks, &second_asks, &gate);
    let first = admit_in_turn(ResourceClass::Browser, deadline, || async move {
        first_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        {
            if let Some(granted) = gate.lock().await.take() {
                let _ = granted.await;
            }
            Ok::<_, io::Error>(1)
        }
    });
    let second = async {
        // Behind it, the next render asks only once the first got room.
        tokio::task::yield_now().await;
        let asked = admit_in_turn(ResourceClass::Browser, deadline, || async move {
            second_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, io::Error>(2)
        });
        let other = async {
            // A preparation is never held by the renders' turn.
            let prepared = admit_in_turn(ResourceClass::Preparation, deadline, || async {
                Ok::<_, io::Error>(3)
            })
            .await
            .unwrap();
            assert_eq!(prepared, 3);
            assert_eq!(second_asks.load(std::sync::atomic::Ordering::SeqCst), 0);
            if let Some(release) = release.lock().unwrap().take() {
                let _ = release.send(());
            }
        };
        let (asked, ()) = tokio::join!(asked, other);
        asked
    };
    let (first, second) = tokio::join!(first, second);
    assert_eq!((first.unwrap(), second.unwrap()), (1, 2));
    assert_eq!(first_asks.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(second_asks.load(std::sync::atomic::Ordering::SeqCst), 1);
    // A window that closes while waiting for the turn is the queue's
    // refusal, unscored.
    let _held = ADMISSION_TURNS[ResourceClass::Check as usize].lock().await;
    let expired = admit_in_turn(ResourceClass::Check, now_ms().unwrap() + 50, || async {
        Ok::<_, io::Error>(4)
    })
    .await
    .unwrap_err();
    assert_eq!(expired.kind(), io::ErrorKind::WouldBlock);
}

/// A collection, check or later step that waits for room keeps its whole
/// run time once admitted; only its native deadline cuts it, and a
/// deadline that passes in the queue is the queue's refusal (unscored),
/// as a Grok step met on 2026-10-17 when a host build took the commit
/// headroom between its two steps.
#[tokio::test]
async fn waiting_for_room_never_shortens_a_helpers_run_and_never_outlives_its_deadline() {
    let now = now_ms().unwrap();
    assert_eq!(
        run_after_admission(Duration::from_secs(125), None).unwrap(),
        125_000
    );
    let near = run_after_admission(Duration::from_secs(125), Some(now + 60_000)).unwrap();
    assert!((55_000..=60_000).contains(&near), "{near}");
    assert_eq!(
        run_after_admission(Duration::from_secs(125), Some(now - 1))
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(admission_window(now + 1_800_000, None), now + 1_800_000);
    assert_eq!(
        admission_window(now + 1_800_000, Some(now + 60_000)),
        now + 60_000
    );
    // Busy until the window closes: refused as busy, never as a timeout
    // of the candidate's budget.
    let window = admission_window(now + 1_800_000, Some(now + 80));
    let refused = admit::<(), _>(window, || async {
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "resource_busy: Windows commit headroom cannot cover benchmark reservations and its 8 GiB floor; no provider process started",
        ))
    })
    .await
    .unwrap_err();
    assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
    assert!(refused.to_string().starts_with("resource_busy:"));
    // Room that opens inside the window admits the helper.
    let mut asked = 0;
    let admitted = admit(now_ms().unwrap() + 60_000, || {
        asked += 1;
        let busy = asked < 3;
        async move {
            if busy {
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "resource_busy: queued",
                ))
            } else {
                Ok("lease")
            }
        }
    })
    .await
    .unwrap();
    assert_eq!((admitted, asked), ("lease", 3));
}

#[tokio::test]
async fn expired_native_deadlines_refuse_before_starting_any_wsl_process() {
    assert_eq!(
        copy_until("invented-expired", b"unread input", 0)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        artifact("invented-expired", b"unread input", 0)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        patch_until("invented-expired", 1024, 0)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        ready_until(0).await.unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
}

#[tokio::test]
#[ignore = "requires the provisioned distill-bench WSL distribution"]
async fn copy_and_patch_use_the_pristine_base_and_enforce_the_byte_cap() {
    ready().await.unwrap();
    let mut archive = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(4);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, "file.txt", "one\n".as_bytes())
        .unwrap();
    let id = format!("copy-test-{}", uuid::Uuid::new_v4());
    let mut cleanup = Cleanup(Some(id.clone()));
    copy(&id, &archive.into_inner().unwrap()).await.unwrap();
    assert!(patch(&id, 1024).await.unwrap().is_empty());
    let edited = invoke(
        "/usr/local/sbin/bench-run",
        &[
            "session",
            &id,
            "--",
            "bash",
            "-c",
            "printf 'two\\n' >file.txt; printf 'new\\n' >added.txt; rm -rf /workspace/.git",
        ],
        None,
        TAIL_BYTES,
        CONTROL_TIMEOUT,
    )
    .await
    .unwrap();
    assert!(edited.success(), "{}", edited.reason());
    kill("session", &id).await.unwrap();
    let answer = patch(&id, 4096).await.unwrap();
    let text = String::from_utf8(answer.clone()).unwrap();
    assert!(text.contains("added.txt") && text.contains("+two"));
    assert_eq!(patch(&id, 4096).await.unwrap(), answer);
    assert_eq!(
        patch(&id, 8).await.unwrap_err().kind(),
        io::ErrorKind::FileTooLarge
    );
    clean(&id).await.unwrap();
    cleanup.0 = None;
}
