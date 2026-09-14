//! Names Windows will not store as you asked for them.
//!
//! Two quirks of the Win32 path layer survive into every modern Windows, and
//! both turn a plausible name into something other than a file:
//!
//! - the DOS device names (`CON`, `NUL`, `COM1`, …) resolve to devices rather
//!   than to files in the current directory, with or without an extension —
//!   `docs/runs/CON.md` is the console, not a document;
//! - a trailing dot or space is silently trimmed by the path normaliser, so
//!   `foo ` and `foo` are the same file and a caller that asked for the former
//!   is told it created something it cannot find again.
//!
//! Neither escapes the intended directory, so this is about honest failure
//! rather than containment: refuse the name up front instead of surfacing
//! "The parameter is incorrect" from three layers down, or writing to a device.
//!
//! The checks live here, outside any `#[cfg(windows)]`, because the app is
//! Windows-only in production but its tests run everywhere: the rules are about
//! what the *target* platform does, not about the host compiling them.

/// The reserved DOS device basenames, as Windows compares them: case-insensitive.
const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Whether `name` names a DOS device on Windows.
///
/// The device is matched on the part before the first `.`, because that is what
/// Windows does: `NUL`, `nul.txt` and `Nul.md` all open the null device.
pub(crate) fn is_reserved_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    RESERVED_DEVICE_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Whether Windows would trim characters off the end of `name`.
///
/// A trailing dot or space never survives path normalisation, so a caller that
/// asks for one gets a different file than it named.
pub(crate) fn has_trailing_windows_dot_or_space(name: &str) -> bool {
    name.ends_with('.') || name.ends_with(' ')
}

/// Both checks at once, with the reason, for validators that only need to
/// reject. `label` names the thing being validated, e.g. `"Worktree name"`.
pub(crate) fn reject_unusable_windows_name(name: &str, label: &str) -> Result<(), String> {
    if is_reserved_windows_device_name(name) {
        return Err(format!(
            "{label} cannot be a reserved Windows device name ('{name}')"
        ));
    }
    if has_trailing_windows_dot_or_space(name) {
        return Err(format!("{label} cannot end with a '.' or a space"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reserved_device_name_is_rejected_in_any_case_and_with_any_extension() {
        for name in RESERVED_DEVICE_NAMES {
            for candidate in [
                name.to_string(),
                name.to_lowercase(),
                format!("{name}.md"),
                format!("{}.md", name.to_lowercase()),
                format!("{name}.tar.gz"),
            ] {
                assert!(
                    is_reserved_windows_device_name(&candidate),
                    "expected '{candidate}' to be reserved"
                );
            }
        }
    }

    #[test]
    fn names_that_merely_start_with_a_device_name_are_allowed() {
        for name in [
            "console",
            "contrib",
            "nullable.md",
            "com10",
            "lpt0",
            "auxiliary",
            "my-con",
            "prnt.md",
        ] {
            assert!(
                !is_reserved_windows_device_name(name),
                "expected '{name}' to be usable"
            );
        }
    }

    #[test]
    fn trailing_dots_and_spaces_are_rejected() {
        for name in ["notes.", "notes ", "notes.md.", "notes.md "] {
            assert!(
                has_trailing_windows_dot_or_space(name),
                "expected '{name}' to be rejected"
            );
        }
        for name in ["notes.md", "notes", ".hidden", "my notes.md"] {
            assert!(
                !has_trailing_windows_dot_or_space(name),
                "expected '{name}' to be usable"
            );
        }
    }

    #[test]
    fn the_combined_check_names_the_label_and_the_reason() {
        let device = reject_unusable_windows_name("CON.md", "Closeout name").unwrap_err();
        assert!(device.contains("Closeout name"), "{device}");
        assert!(device.contains("CON.md"), "{device}");

        let trailing = reject_unusable_windows_name("notes.md ", "Worktree name").unwrap_err();
        assert!(trailing.contains("Worktree name"), "{trailing}");

        reject_unusable_windows_name("closeout.md", "Closeout name").unwrap();
    }
}
