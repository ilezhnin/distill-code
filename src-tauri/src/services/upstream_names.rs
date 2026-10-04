//! Distill was renamed from its upstream's name, Berd, and builds from before
//! that wrote the old name to disk: into the frontmatter of every agent and
//! skill they installed, into the file that records which agents were seeded,
//! into queued messages, and as the names of the CLIs on the agents' PATH.
//! Nothing in the code reads those spellings any more, so this brings what is
//! on disk along, once, at startup — before the seeders, which would otherwise
//! take their own earlier installs for the user's files and stop updating them.
//! It works on the Distill root only, where the one-time adoption
//! (`root_migration`) copied what older builds kept elsewhere; nothing outside
//! the root is read or written.
//!
//! Every step is idempotent and finds nothing to do on the second start. The
//! transcripts are covered separately, by the agent host's migration
//! `20260921000000_rename_upstream_names.sql`.

use std::fs;
use std::path::Path;

const OLD_SEED_MARKER: &str = ".berd-bundled-agents.json";
const SEED_MARKER: &str = ".distill-bundled-agents.json";
/// `berdBundled` and `berdBundledSource`, which the second key starts with.
const OLD_BUNDLED_KEY: &str = "berdBundled";
const BUNDLED_KEY: &str = "distillBundled";
/// What a queued cross-session message is recognised and labelled by. Quoted,
/// so that only the JSON structure matches and never the message's own text.
const QUEUED_MESSAGE_NAMES: &[(&str, &str)] = &[
    ("\"berdctl_cross_session\"", "\"distillctl_cross_session\""),
    ("\"berdDeliveryId\":", "\"distillDeliveryId\":"),
    ("\"berdSenderLabel\":", "\"distillSenderLabel\":"),
];
/// What an older build left under its own names and the renamed build installs
/// again under new ones, as the root holds it: the CLI shims the adoption
/// copied from the app's old `bin` into `cache/bin`, and the bundled skills'
/// old staging folder.
const RETIRED_ROOT_PATHS: &[&str] = &[
    "cache/bin/berdctl.cmd",
    "cache/bin/berd-monitor.cmd",
    "cache/bin/berdctl",
    "cache/bin/berd-monitor",
    "skills/.berd-skill-transactions",
];
const RETIRED_BUNDLED_SKILLS: &[&str] = &["berd-help", "berd-monitor"];

/// Brings the Distill root's `agents`, `skills`, queued messages
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
    let old_marker = agents_dir.join(OLD_SEED_MARKER);
    let marker = agents_dir.join(SEED_MARKER);
    if old_marker.is_file() {
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
/// the two bundled skills that now ship under another name.
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
        // wrote carries no marker and stays.
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
    if !block.contains(OLD_BUNDLED_KEY) {
        return;
    }
    let rewritten = format!(
        "---{}{}",
        block.replace(OLD_BUNDLED_KEY, BUNDLED_KEY),
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

    const SEEDED: &str = "---\nname: planner\nmetadata:\n  berdBundled: true\n  berdBundledSource: planner\n---\n\nTalks about berdBundled in its body.\n";

    #[test]
    fn the_agents_folder_is_brought_under_the_new_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("planner.md"), SEEDED).unwrap();
        fs::write(
            dir.path().join("mine.md"),
            "---\nname: mine\n---\nberdBundled\n",
        )
        .unwrap();
        fs::write(
            dir.path().join(OLD_SEED_MARKER),
            "{\"seededFiles\":[\"planner.md\"]}",
        )
        .unwrap();

        adopt_agents_dir(dir.path());
        adopt_agents_dir(dir.path());

        assert_eq!(
            fs::read_to_string(dir.path().join("planner.md")).unwrap(),
            "---\nname: planner\nmetadata:\n  distillBundled: true\n  distillBundledSource: planner\n---\n\nTalks about berdBundled in its body.\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("mine.md")).unwrap(),
            "---\nname: mine\n---\nberdBundled\n"
        );
        assert!(!dir.path().join(OLD_SEED_MARKER).exists());
        assert_eq!(
            fs::read_to_string(dir.path().join(SEED_MARKER)).unwrap(),
            "{\"seededFiles\":[\"planner.md\"]}"
        );
    }

    #[test]
    fn a_seed_record_already_under_the_new_name_wins() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(OLD_SEED_MARKER), "old").unwrap();
        fs::write(dir.path().join(SEED_MARKER), "new").unwrap();

        adopt_agents_dir(dir.path());

        assert_eq!(
            fs::read_to_string(dir.path().join(SEED_MARKER)).unwrap(),
            "new"
        );
        assert!(!dir.path().join(OLD_SEED_MARKER).exists());
    }

    const OLD_QUEUE: &str = r#"{"s1":[{"payload":{"origin":"berdctl_cross_session","text":"about berdctl_cross_session"}}]}"#;

    /// What an older build left under the old names, laid out at `dir` with
    /// the root's paths for the skills, the agents, the queue and the shims.
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
        fs::write(dir.join("agents/planner.md"), SEEDED).unwrap();
        fs::create_dir_all(dir.join("cache/bin")).unwrap();
        fs::write(dir.join("cache/bin/berdctl.cmd"), "@echo off").unwrap();
        fs::write(dir.join("cache/bin/distillctl.cmd"), "@echo off").unwrap();
        fs::create_dir_all(dir.join("state")).unwrap();
        fs::write(dir.join("state/message-queues.json"), OLD_QUEUE).unwrap();
    }

    #[test]
    fn the_root_loses_what_the_old_names_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        lay_out_old_names(root);

        adopt(root);

        assert!(fs::read_to_string(root.join("skills/planning/SKILL.md"))
            .unwrap()
            .contains("distillBundled: true"));
        assert!(!root.join("skills/berd-help").exists());
        assert!(root.join("skills/berd-monitor/SKILL.md").is_file());
        assert!(!root.join("skills/.berd-skill-transactions").exists());
        assert!(fs::read_to_string(root.join("agents/planner.md"))
            .unwrap()
            .contains("distillBundled: true"));
        assert!(!root.join("cache/bin/berdctl.cmd").exists());
        assert!(root.join("cache/bin/distillctl.cmd").is_file());
        assert_eq!(
            fs::read_to_string(root.join("state/message-queues.json")).unwrap(),
            r#"{"s1":[{"payload":{"origin":"distillctl_cross_session","text":"about berdctl_cross_session"}}]}"#
        );
    }

    /// Only the root it is given: the app's old data folder (or any folder
    /// beside the root) keeps the old names exactly as they were.
    #[test]
    fn nothing_outside_the_root_is_touched() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".distill");
        let outside = dir.path().join("com.levocat.distill");
        fs::create_dir_all(&root).unwrap();
        lay_out_old_names(&outside);
        fs::create_dir_all(outside.join("bin")).unwrap();
        fs::write(outside.join("bin/berdctl.cmd"), "@echo off").unwrap();
        fs::write(outside.join("message-queues.json"), OLD_QUEUE).unwrap();
        fs::create_dir_all(outside.join("berdctl")).unwrap();

        adopt(&root);

        assert!(fs::read_to_string(outside.join("skills/planning/SKILL.md"))
            .unwrap()
            .contains("berdBundled: true"));
        assert!(outside.join("skills/berd-help/SKILL.md").is_file());
        assert!(outside.join("skills/.berd-skill-transactions").is_dir());
        assert_eq!(
            fs::read_to_string(outside.join("agents/planner.md")).unwrap(),
            SEEDED
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
        // An empty root stays empty: nothing is created to rename.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
}
