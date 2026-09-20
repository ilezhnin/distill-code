//! Distill was renamed from its upstream's name, Berd, and builds from before
//! that wrote the old name to disk: into the frontmatter of every agent and
//! skill they installed, into the file that records which agents were seeded,
//! into queued messages, and as the names of the CLIs on the agents' PATH.
//! Nothing in the code reads those spellings any more, so this brings what is
//! on disk along, once, at startup — before the seeders, which would otherwise
//! take their own earlier installs for the user's files and stop updating them.
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
/// What an older build left in the app's own folders under its own names and
/// the renamed build installs again under new ones.
const RETIRED_APP_PATHS: &[&str] = &[
    "bin/berdctl.cmd",
    "bin/berd-monitor.cmd",
    "bin/berdctl",
    "bin/berd-monitor",
    "berdctl",
    "skills/.berd-skill-transactions",
];
const RETIRED_BUNDLED_SKILLS: &[&str] = &["berd-help", "berd-monitor"];

pub fn adopt(app_data_dir: &Path, agents_dir: Option<&Path>) {
    if let Some(agents_dir) = agents_dir {
        adopt_agents_dir(agents_dir);
    }
    adopt_app_skills(&app_data_dir.join("skills"));
    rewrite_file(
        &app_data_dir.join("message-queues.json"),
        QUEUED_MESSAGE_NAMES,
    );
    for retired in RETIRED_APP_PATHS {
        remove(&app_data_dir.join(retired));
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

    #[test]
    fn the_app_folders_lose_what_the_old_names_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        let skill = |name: &str, contents: &str| {
            fs::create_dir_all(app.join("skills").join(name)).unwrap();
            fs::write(app.join("skills").join(name).join("SKILL.md"), contents).unwrap();
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
        fs::create_dir_all(app.join("bin")).unwrap();
        fs::write(app.join("bin").join("berdctl.cmd"), "@echo off").unwrap();
        fs::write(app.join("bin").join("distillctl.cmd"), "@echo off").unwrap();
        fs::create_dir_all(app.join("berdctl")).unwrap();
        fs::write(
            app.join("message-queues.json"),
            r#"{"s1":[{"payload":{"origin":"berdctl_cross_session","text":"about berdctl_cross_session"}}]}"#,
        )
        .unwrap();

        adopt(app, None);

        assert!(fs::read_to_string(app.join("skills/planning/SKILL.md"))
            .unwrap()
            .contains("distillBundled: true"));
        assert!(!app.join("skills/berd-help").exists());
        assert!(app.join("skills/berd-monitor/SKILL.md").is_file());
        assert!(!app.join("bin/berdctl.cmd").exists());
        assert!(app.join("bin/distillctl.cmd").is_file());
        assert!(!app.join("berdctl").exists());
        assert_eq!(
            fs::read_to_string(app.join("message-queues.json")).unwrap(),
            r#"{"s1":[{"payload":{"origin":"distillctl_cross_session","text":"about berdctl_cross_session"}}]}"#
        );
    }
}
