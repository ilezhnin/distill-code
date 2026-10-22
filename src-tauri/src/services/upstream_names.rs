//! Flock has had two earlier names — Berd, its upstream's, and Distill — and
//! builds under each wrote that name to disk: into the frontmatter of every
//! agent and skill they installed, into the file that records which agents
//! were seeded, into queued messages, and as the names of the CLIs on the
//! agents' PATH. Nothing in the code reads those spellings any more, so this
//! brings what is on disk along, once, at startup — before the seeders, which
//! would otherwise take their own earlier installs for the user's files and
//! stop updating them. It works on the Flock root only, where the one-time
//! adoption (`root_migration`) copied what older builds kept elsewhere;
//! nothing outside the root is read or written.
//!
//! Every step is idempotent and finds nothing to do on the second start. The
//! transcripts are covered separately, by the agent host's migration
//! `20260921000000_rename_upstream_names.sql`.

use std::fs;
use std::path::Path;

/// The seed records the earlier builds wrote, newest predecessor first: when
/// a root holds more than one, the newest is the one carried over.
const OLD_SEED_MARKERS: &[&str] = &[".distill-bundled-agents.json", ".berd-bundled-agents.json"];
const SEED_MARKER: &str = ".flock-bundled-agents.json";
/// The ownership marker the earlier builds wrote: `distillBundled` and
/// `berdBundled`, and the `...BundledSource` keys, which start with the same
/// text, so one substring rewrite covers both.
pub(crate) const OLD_BUNDLED_KEYS: &[&str] = &["distillBundled", "berdBundled"];
pub(crate) const BUNDLED_KEY: &str = "flockBundled";
/// What a queued cross-session message is recognised and labelled by. Quoted,
/// so that only the JSON structure matches and never the message's own text.
/// The `distill...` spellings are the persisted ones and stay: only Berd's
/// are brought along.
const QUEUED_MESSAGE_NAMES: &[(&str, &str)] = &[
    ("\"berdctl_cross_session\"", "\"distillctl_cross_session\""),
    ("\"berdDeliveryId\":", "\"distillDeliveryId\":"),
    ("\"berdSenderLabel\":", "\"distillSenderLabel\":"),
];
/// What an older build left under its own names and the renamed build installs
/// again under new ones, as the root holds it: the CLI shims the adoption
/// copied from Berd's `bin` into `cache/bin`, and the bundled skills' old
/// staging folders. Distill's CLI shims (`cache/bin/distillctl.cmd`,
/// `cache/bin/distill-monitor.cmd`) are not retired: the agent host keeps
/// writing them, pointed at the new binaries, so installed skills and old
/// transcripts that call them keep working.
const RETIRED_ROOT_PATHS: &[&str] = &[
    "cache/bin/berdctl.cmd",
    "cache/bin/berd-monitor.cmd",
    "cache/bin/berdctl",
    "cache/bin/berd-monitor",
    "skills/.berd-skill-transactions",
    "skills/.distill-skill-transactions",
];
/// The bundled skills that now ship under another name. Removed only when
/// their frontmatter carries the bundled marker: a skill of the same name the
/// user wrote carries none and stays.
const RETIRED_BUNDLED_SKILLS: &[&str] = &[
    "berd-help",
    "berd-monitor",
    "distill-help",
    "distill-monitor",
];

/// Whether a frontmatter `metadata` key is the bundled ownership marker, under
/// the current name or one an earlier build wrote. The `...BundledSource` keys
/// are not: they name the bundled agent a file was made from and carry no
/// ownership claim.
pub(crate) fn is_bundled_marker_key(key: &str) -> bool {
    key == BUNDLED_KEY || OLD_BUNDLED_KEYS.contains(&key)
}

/// Whether a parsed frontmatter `metadata` block claims the file for the
/// app's bundle. A copy this module has not rewritten yet — one in a project's
/// own folder, or on a start where the rewrite failed — still carries an old
/// key, and is still the app's.
pub(crate) fn metadata_marks_bundled(
    metadata: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    metadata
        .iter()
        .any(|(key, value)| is_bundled_marker_key(key) && value.as_bool() == Some(true))
}

/// Brings the Flock root's `agents`, `skills`, queued messages
/// (`state/message-queues.json`) and CLI shims (`cache/bin`) under the new
/// names.
pub fn adopt(root: &Path) {
    adopt_agents_dir(&root.join("agents"));
    adopt_app_skills(&root.join("skills"));
    rewrite_file(
        &root.join("state").join("message-queues.json"),
        QUEUED_MESSAGE_NAMES,
    );
    for retired in RETIRED_ROOT_PATHS {
        remove(&root.join(retired));
    }
}

/// The global agents folder: the seed record under its new name, and the
/// bundled markers in every agent file — the seeded ones and the user's own
/// copies of them, which name the agent they were made from.
fn adopt_agents_dir(agents_dir: &Path) {
    let marker = agents_dir.join(SEED_MARKER);
    // Newest predecessor first: once its record is the new one, every older
    // record is a duplicate.
    for old in OLD_SEED_MARKERS {
        let old_marker = agents_dir.join(old);
        if !old_marker.is_file() {
            continue;
        }
        if marker.exists() {
            remove(&old_marker);
        } else if let Err(error) = fs::rename(&old_marker, &marker) {
            log::warn!(
                "Failed to rename '{}' to '{}': {error}",
                old_marker.display(),
                marker.display()
            );
        }
    }
    let Ok(entries) = fs::read_dir(agents_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
            rewrite_frontmatter_keys(&path);
        }
    }
}

/// The app's own skills folder: the markers of the skills it installed, and
/// the bundled skills that now ship under another name.
fn adopt_app_skills(skills_dir: &Path) {
    let Ok(entries) = fs::read_dir(skills_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_file = entry.path().join("SKILL.md");
        if skill_file.is_file() {
            rewrite_frontmatter_keys(&skill_file);
        }
    }
    for name in RETIRED_BUNDLED_SKILLS {
        let dir = skills_dir.join(name);
        // Only a copy the app installed: a skill of the same name the user
        // wrote carries no marker and stays. The marker was rewritten above,
        // so it is looked for under its current name.
        let is_bundled = fs::read_to_string(dir.join("SKILL.md")).is_ok_and(|contents| {
            frontmatter(&contents).is_some_and(|fm| fm.contains(BUNDLED_KEY))
        });
        if is_bundled {
            remove(&dir);
        }
    }
}

/// The YAML block between the opening `---` and the next one.
fn frontmatter(contents: &str) -> Option<&str> {
    let rest = contents.strip_prefix("---")?;
    rest.find("\n---").map(|end| &rest[..end])
}

/// Rename the bundled markers in a file's frontmatter, and only there: the
/// body is prose, and may well be about the old name.
fn rewrite_frontmatter_keys(path: &Path) {
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    let Some(block) = frontmatter(&contents) else {
        return;
    };
    if !OLD_BUNDLED_KEYS.iter().any(|old| block.contains(old)) {
        return;
    }
    let rewritten_block = OLD_BUNDLED_KEYS
        .iter()
        .fold(block.to_string(), |text, old| {
            text.replace(old, BUNDLED_KEY)
        });
    let rewritten = format!(
        "---{}{}",
        rewritten_block,
        &contents["---".len() + block.len()..]
    );
    if let Err(error) = fs::write(path, rewritten) {
        log::warn!("Failed to rewrite '{}': {error}", path.display());
    }
}

fn rewrite_file(path: &Path, names: &[(&str, &str)]) {
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    let rewritten = names
        .iter()
        .fold(contents.clone(), |text, (old, new)| text.replace(old, new));
    if rewritten == contents {
        return;
    }
    if let Err(error) = fs::write(path, rewritten) {
        log::warn!("Failed to rewrite '{}': {error}", path.display());
    }
}

fn remove(path: &Path) {
    let result = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => return,
    };
    if let Err(error) = result {
        log::warn!("Failed to remove '{}': {error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const DISTILL_SEED_MARKER: &str = OLD_SEED_MARKERS[0];
    const BERD_SEED_MARKER: &str = OLD_SEED_MARKERS[1];
    const DISTILL_KEY: &str = OLD_BUNDLED_KEYS[0];
    const BERD_KEY: &str = OLD_BUNDLED_KEYS[1];

    /// A seeded agent as a build under `key` installed it: the marker, the
    /// source attribution, and a body that mentions the key as prose.
    fn seeded(key: &str) -> String {
        format!("---\nname: planner\nmetadata:\n  {key}: true\n  {key}Source: planner\n---\n\nTalks about {key} in its body.\n")
    }

    const ADOPTED: &str = "---\nname: planner\nmetadata:\n  flockBundled: true\n  flockBundledSource: planner\n---\n\nTalks about berdBundled in its body.\n";

    /// Every file and folder under `dir`, by relative path, with file
    /// contents: what a run leaves behind, comparable between runs.
    fn snapshot(dir: &Path) -> BTreeMap<String, Option<String>> {
        fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Option<String>>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                let relative = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    out.insert(relative, None);
                    walk(base, &path, out);
                } else {
                    out.insert(relative, Some(fs::read_to_string(&path).unwrap()));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, dir, &mut out);
        out
    }

    /// The names this module brings along are not the names it brings them
    /// to: a mechanical rename that touched the old spellings would turn the
    /// adoption into a no-op (or, for the retired skills, into the removal
    /// of the skills that ship today), and this is what catches it.
    #[test]
    fn the_old_names_are_not_the_current_ones() {
        for old in OLD_SEED_MARKERS {
            assert_ne!(*old, SEED_MARKER);
        }
        for old in OLD_BUNDLED_KEYS {
            assert_ne!(*old, BUNDLED_KEY);
            assert!(is_bundled_marker_key(old), "{old}");
        }
        assert!(is_bundled_marker_key(BUNDLED_KEY));
        assert!(!is_bundled_marker_key("flockBundledSource"));
        assert_eq!(OLD_SEED_MARKERS.len(), 2);
        assert_eq!(OLD_BUNDLED_KEYS.len(), 2);
        for shipped in ["flock-help", "flock-monitor"] {
            assert!(
                !RETIRED_BUNDLED_SKILLS.contains(&shipped),
                "{shipped} ships today and must not be retired"
            );
        }
        assert_eq!(RETIRED_BUNDLED_SKILLS.len(), 4);
        for retired in RETIRED_ROOT_PATHS {
            assert!(
                !retired.ends_with(crate::services::bundled_skills::TRANSACTIONS_DIR_NAME),
                "{retired} is the live staging folder"
            );
            assert!(
                !retired.contains("distillctl") && !retired.contains("distill-monitor"),
                "{retired} is a compatibility shim the agent host still writes"
            );
        }
        assert!(RETIRED_ROOT_PATHS.contains(&"skills/.distill-skill-transactions"));
        // The persisted queued-message names stay under their `distill`
        // spelling: only Berd's are rewritten, and to those.
        for (old, new) in QUEUED_MESSAGE_NAMES {
            assert!(old.contains("berd"), "{old}");
            assert!(new.contains("distill"), "{new}");
        }
    }

    fn metadata(key: &str, value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        let mut block = serde_json::Map::new();
        block.insert(key.to_string(), value);
        block
    }

    #[test]
    fn a_metadata_block_marks_bundled_under_any_of_the_keys() {
        for key in [BUNDLED_KEY, DISTILL_KEY, BERD_KEY] {
            assert!(
                metadata_marks_bundled(&metadata(key, serde_json::Value::Bool(true))),
                "{key}"
            );
            assert!(
                !metadata_marks_bundled(&metadata(key, serde_json::Value::Bool(false))),
                "{key}"
            );
            assert!(
                !metadata_marks_bundled(&metadata(key, serde_json::Value::String("true".into()))),
                "{key}"
            );
        }
        assert!(!metadata_marks_bundled(&metadata(
            "flockBundledSource",
            serde_json::Value::String("planner".into())
        )));
        assert!(!metadata_marks_bundled(&serde_json::Map::new()));
    }

    #[test]
    fn the_agents_folder_is_brought_under_the_new_names() {
        for (old_marker, key) in [
            (DISTILL_SEED_MARKER, DISTILL_KEY),
            (BERD_SEED_MARKER, BERD_KEY),
        ] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("planner.md"), seeded(key)).unwrap();
            fs::write(
                dir.path().join("mine.md"),
                format!("---\nname: mine\n---\n{key}\n"),
            )
            .unwrap();
            fs::write(
                dir.path().join(old_marker),
                "{\"seededFiles\":[\"planner.md\"]}",
            )
            .unwrap();

            adopt_agents_dir(dir.path());
            adopt_agents_dir(dir.path());

            assert_eq!(
                fs::read_to_string(dir.path().join("planner.md")).unwrap(),
                format!("---\nname: planner\nmetadata:\n  flockBundled: true\n  flockBundledSource: planner\n---\n\nTalks about {key} in its body.\n"),
                "{key}"
            );
            assert_eq!(
                fs::read_to_string(dir.path().join("mine.md")).unwrap(),
                format!("---\nname: mine\n---\n{key}\n")
            );
            assert!(!dir.path().join(old_marker).exists());
            assert_eq!(
                fs::read_to_string(dir.path().join(SEED_MARKER)).unwrap(),
                "{\"seededFiles\":[\"planner.md\"]}"
            );
        }
    }

    #[test]
    fn a_seed_record_already_under_the_new_name_wins() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DISTILL_SEED_MARKER), "distill").unwrap();
        fs::write(dir.path().join(BERD_SEED_MARKER), "berd").unwrap();
        fs::write(dir.path().join(SEED_MARKER), "new").unwrap();

        adopt_agents_dir(dir.path());

        assert_eq!(
            fs::read_to_string(dir.path().join(SEED_MARKER)).unwrap(),
            "new"
        );
        assert!(!dir.path().join(DISTILL_SEED_MARKER).exists());
        assert!(!dir.path().join(BERD_SEED_MARKER).exists());
    }

    /// A root that went through both renames without ever starting the
    /// in-between build still has Berd's record beside Distill's: the newer
    /// one is the one carried over.
    #[test]
    fn the_newest_predecessors_seed_record_is_the_one_carried_over() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DISTILL_SEED_MARKER), "distill").unwrap();
        fs::write(dir.path().join(BERD_SEED_MARKER), "berd").unwrap();

        adopt_agents_dir(dir.path());

        assert_eq!(
            fs::read_to_string(dir.path().join(SEED_MARKER)).unwrap(),
            "distill"
        );
        assert!(!dir.path().join(DISTILL_SEED_MARKER).exists());
        assert!(!dir.path().join(BERD_SEED_MARKER).exists());
    }

    /// A file that carries both earlier markers (copied by hand from one
    /// install to the next) ends up with the current one, once per key.
    #[test]
    fn every_old_key_in_one_frontmatter_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("planner.md");
        fs::write(
            &file,
            format!("---\nname: planner\nmetadata:\n  {DISTILL_KEY}: true\n  {BERD_KEY}Source: planner\n---\nbody\n"),
        )
        .unwrap();

        rewrite_frontmatter_keys(&file);

        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "---\nname: planner\nmetadata:\n  flockBundled: true\n  flockBundledSource: planner\n---\nbody\n"
        );
    }

    const OLD_QUEUE: &str = r#"{"s1":[{"payload":{"origin":"berdctl_cross_session","text":"about berdctl_cross_session"}}]}"#;
    /// The queue as the Distill build wrote it: the persisted names, which stay.
    const PERSISTED_QUEUE: &str = r#"{"s1":[{"payload":{"origin":"distillctl_cross_session","distillDeliveryId":"d1","distillSenderLabel":"Sent by Flock from another session","text":"about distillctl_cross_session"}}]}"#;

    /// What the Berd build left under its names, laid out at `dir` with the
    /// root's paths for the skills, the agents, the queue and the shims.
    fn lay_out_old_names(dir: &Path) {
        let skill = |name: &str, contents: &str| {
            fs::create_dir_all(dir.join("skills").join(name)).unwrap();
            fs::write(dir.join("skills").join(name).join("SKILL.md"), contents).unwrap();
        };
        skill(
            "planning",
            "---\nname: planning\nmetadata:\n  berdBundled: true\n---\nbody",
        );
        skill(
            "berd-help",
            "---\nname: berd-help\nmetadata:\n  berdBundled: true\n---\nbody",
        );
        skill(
            "berd-monitor",
            "---\nname: berd-monitor\n---\nthe user's own",
        );
        fs::create_dir_all(dir.join("skills/.berd-skill-transactions")).unwrap();
        fs::create_dir_all(dir.join("agents")).unwrap();
        fs::write(dir.join("agents/planner.md"), seeded(BERD_KEY)).unwrap();
        fs::create_dir_all(dir.join("cache/bin")).unwrap();
        fs::write(dir.join("cache/bin/berdctl.cmd"), "@echo off").unwrap();
        fs::write(dir.join("cache/bin/flockctl.cmd"), "@echo off").unwrap();
        fs::create_dir_all(dir.join("state")).unwrap();
        fs::write(dir.join("state/message-queues.json"), OLD_QUEUE).unwrap();
    }

    /// What the Distill build left under its names: the same layout, under
    /// the names it used, plus the CLI shims the renamed build keeps.
    fn lay_out_distill_names(dir: &Path) {
        let skill = |name: &str, contents: &str| {
            fs::create_dir_all(dir.join("skills").join(name)).unwrap();
            fs::write(dir.join("skills").join(name).join("SKILL.md"), contents).unwrap();
        };
        skill(
            "planning",
            &format!("---\nname: planning\nmetadata:\n  {DISTILL_KEY}: true\n---\nbody"),
        );
        skill(
            RETIRED_BUNDLED_SKILLS[2],
            &format!("---\nname: distill-help\nmetadata:\n  {DISTILL_KEY}: true\n---\nbody"),
        );
        skill(
            RETIRED_BUNDLED_SKILLS[3],
            "---\nname: distill-monitor\n---\nthe user's own",
        );
        fs::create_dir_all(dir.join("skills/.distill-skill-transactions/stage-1-2")).unwrap();
        fs::create_dir_all(dir.join("agents")).unwrap();
        fs::write(dir.join("agents/planner.md"), seeded(DISTILL_KEY)).unwrap();
        fs::write(
            dir.join("agents").join(DISTILL_SEED_MARKER),
            "{\"seededFiles\":[\"planner.md\"]}",
        )
        .unwrap();
        fs::create_dir_all(dir.join("cache/bin")).unwrap();
        fs::write(dir.join("cache/bin/distillctl.cmd"), "@echo off").unwrap();
        fs::write(dir.join("cache/bin/distill-monitor.cmd"), "@echo off").unwrap();
        fs::write(dir.join("cache/bin/flockctl.cmd"), "@echo off").unwrap();
        fs::create_dir_all(dir.join("state")).unwrap();
        fs::write(dir.join("state/message-queues.json"), PERSISTED_QUEUE).unwrap();
    }

    #[test]
    fn the_root_loses_what_the_old_names_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        lay_out_old_names(root);

        adopt(root);

        assert!(fs::read_to_string(root.join("skills/planning/SKILL.md"))
            .unwrap()
            .contains("flockBundled: true"));
        assert!(!root.join("skills/berd-help").exists());
        assert!(root.join("skills/berd-monitor/SKILL.md").is_file());
        assert!(!root.join("skills/.berd-skill-transactions").exists());
        assert_eq!(
            fs::read_to_string(root.join("agents/planner.md")).unwrap(),
            ADOPTED
        );
        assert!(!root.join("cache/bin/berdctl.cmd").exists());
        assert!(root.join("cache/bin/flockctl.cmd").is_file());
        assert_eq!(
            fs::read_to_string(root.join("state/message-queues.json")).unwrap(),
            r#"{"s1":[{"payload":{"origin":"distillctl_cross_session","text":"about berdctl_cross_session"}}]}"#
        );
    }

    #[test]
    fn the_root_loses_what_the_distill_build_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        lay_out_distill_names(root);

        adopt(root);

        assert_eq!(
            fs::read_to_string(root.join("skills/planning/SKILL.md")).unwrap(),
            "---\nname: planning\nmetadata:\n  flockBundled: true\n---\nbody"
        );
        assert!(!root.join("skills").join(RETIRED_BUNDLED_SKILLS[2]).exists());
        // The user's own skill under a retired name carries no marker: kept.
        assert_eq!(
            fs::read_to_string(
                root.join("skills")
                    .join(RETIRED_BUNDLED_SKILLS[3])
                    .join("SKILL.md")
            )
            .unwrap(),
            "---\nname: distill-monitor\n---\nthe user's own"
        );
        assert!(!root.join("skills/.distill-skill-transactions").exists());
        assert_eq!(
            fs::read_to_string(root.join("agents/planner.md")).unwrap(),
            "---\nname: planner\nmetadata:\n  flockBundled: true\n  flockBundledSource: planner\n---\n\nTalks about distillBundled in its body.\n"
        );
        assert!(!root.join("agents").join(DISTILL_SEED_MARKER).exists());
        assert_eq!(
            fs::read_to_string(root.join("agents").join(SEED_MARKER)).unwrap(),
            "{\"seededFiles\":[\"planner.md\"]}"
        );
        // The persisted queue names are not an old spelling: untouched.
        assert_eq!(
            fs::read_to_string(root.join("state/message-queues.json")).unwrap(),
            PERSISTED_QUEUE
        );
    }

    /// `distillctl` and `distill-monitor` stay reachable from a session for
    /// one release: the shims the previous build installed are not retired
    /// (the agent host rewrites them to point at the new binaries).
    #[test]
    fn the_compatibility_shims_survive_adoption() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        lay_out_distill_names(root);

        adopt(root);

        for shim in [
            "cache/bin/distillctl.cmd",
            "cache/bin/distill-monitor.cmd",
            "cache/bin/flockctl.cmd",
        ] {
            assert_eq!(
                fs::read_to_string(root.join(shim)).unwrap(),
                "@echo off",
                "{shim}"
            );
        }
    }

    /// The whole adoption, twice: the second run finds nothing to do and
    /// leaves the root byte-for-byte as the first run left it.
    #[test]
    fn a_second_run_finds_nothing_to_do() {
        for lay_out in [
            lay_out_old_names as fn(&Path),
            lay_out_distill_names as fn(&Path),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            lay_out(root);
            let before = snapshot(root);

            adopt(root);
            let after_first = snapshot(root);
            adopt(root);
            let after_second = snapshot(root);

            assert_ne!(before, after_first, "the first run adopts");
            assert_eq!(after_first, after_second, "the second run is a no-op");
        }
    }

    /// A root that saw both earlier builds: Berd's leftovers and Distill's
    /// are brought along in the same run.
    #[test]
    fn both_predecessors_are_adopted_in_one_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        lay_out_old_names(root);
        fs::write(
            root.join("agents").join(DISTILL_SEED_MARKER),
            "{\"seededFiles\":[\"planner.md\",\"scout.md\"]}",
        )
        .unwrap();
        fs::write(
            root.join("agents").join(BERD_SEED_MARKER),
            "{\"seededFiles\":[\"planner.md\"]}",
        )
        .unwrap();
        fs::write(
            root.join("agents/scout.md"),
            seeded(DISTILL_KEY).replace("planner", "scout"),
        )
        .unwrap();
        fs::create_dir_all(root.join("skills").join(RETIRED_BUNDLED_SKILLS[2])).unwrap();
        fs::write(
            root.join("skills")
                .join(RETIRED_BUNDLED_SKILLS[2])
                .join("SKILL.md"),
            format!("---\nname: distill-help\nmetadata:\n  {DISTILL_KEY}: true\n---\nbody"),
        )
        .unwrap();
        fs::create_dir_all(root.join("skills/.distill-skill-transactions")).unwrap();

        adopt(root);

        assert_eq!(
            fs::read_to_string(root.join("agents").join(SEED_MARKER)).unwrap(),
            "{\"seededFiles\":[\"planner.md\",\"scout.md\"]}"
        );
        assert!(!root.join("agents").join(DISTILL_SEED_MARKER).exists());
        assert!(!root.join("agents").join(BERD_SEED_MARKER).exists());
        assert!(fs::read_to_string(root.join("agents/scout.md"))
            .unwrap()
            .contains("flockBundled: true"));
        assert!(!root.join("skills/berd-help").exists());
        assert!(!root.join("skills").join(RETIRED_BUNDLED_SKILLS[2]).exists());
        assert!(!root.join("skills/.berd-skill-transactions").exists());
        assert!(!root.join("skills/.distill-skill-transactions").exists());
    }

    /// Only the root it is given: the app's old data folder (or any folder
    /// beside the root) keeps the old names exactly as they were.
    #[test]
    fn nothing_outside_the_root_is_touched() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".distill");
        let outside = dir.path().join("com.levocat.flock");
        fs::create_dir_all(&root).unwrap();
        lay_out_old_names(&outside);
        fs::create_dir_all(outside.join("bin")).unwrap();
        fs::write(outside.join("bin/berdctl.cmd"), "@echo off").unwrap();
        fs::write(outside.join("message-queues.json"), OLD_QUEUE).unwrap();
        fs::create_dir_all(outside.join("berdctl")).unwrap();
        let beside = dir.path().join("com.levocat.distill");
        lay_out_distill_names(&beside);
        let beside_before = snapshot(&beside);

        adopt(&root);

        assert!(fs::read_to_string(outside.join("skills/planning/SKILL.md"))
            .unwrap()
            .contains("berdBundled: true"));
        assert!(outside.join("skills/berd-help/SKILL.md").is_file());
        assert!(outside.join("skills/.berd-skill-transactions").is_dir());
        assert_eq!(
            fs::read_to_string(outside.join("agents/planner.md")).unwrap(),
            seeded(BERD_KEY)
        );
        assert!(outside.join("cache/bin/berdctl.cmd").is_file());
        assert!(outside.join("bin/berdctl.cmd").is_file());
        assert!(outside.join("berdctl").is_dir());
        assert_eq!(
            fs::read_to_string(outside.join("state/message-queues.json")).unwrap(),
            OLD_QUEUE
        );
        assert_eq!(
            fs::read_to_string(outside.join("message-queues.json")).unwrap(),
            OLD_QUEUE
        );
        assert_eq!(snapshot(&beside), beside_before);
        // An empty root stays empty: nothing is created to rename.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
}
