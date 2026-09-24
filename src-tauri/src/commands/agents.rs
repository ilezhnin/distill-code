use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_PERSONA_IMPORT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_AGENT_IMAGE_IMPORT_BYTES: u64 = 10 * 1024 * 1024;
const AGENT_MARKDOWN_SUFFIX: &str = ".md";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileReadResult {
    pub file_contents: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBinaryFileReadResult {
    pub file_bytes: Vec<u8>,
    pub file_name: String,
}

fn validate_agent_import_path(source_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "agent import")?;
    let lower_name = lower_file_name(&path)?;
    if !lower_name.ends_with(".zip")
        && !lower_name.ends_with(".png")
        && !lower_name.ends_with(".md")
        && !lower_name.ends_with(".json")
    {
        return Err(
            "Unsupported file type. Expected an agent ZIP, PNG, Markdown, or JSON file."
                .to_string(),
        );
    }
    if metadata.len() > MAX_AGENT_IMAGE_IMPORT_BYTES {
        return Err("Agent import file must be 10 MB or smaller.".to_string());
    }
    canonicalize_path(&path, "agent import")
}

fn validate_agent_source_path_with_roots(
    source_path: &str,
    trusted_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "agent source")?;
    validate_supported_agent_source_extension(&path)?;
    validate_file_size(metadata.len(), "Agent source file")?;
    let canonical_path = canonicalize_path(&path, "agent source")?;

    let trusted_root = trusted_roots.iter().find_map(|root| {
        let canonical_root = root.canonicalize().ok()?;
        canonical_path
            .starts_with(&canonical_root)
            .then_some(canonical_root)
    });
    if trusted_root.is_none() {
        return Err(format!(
            "Agent source file '{}' is outside the trusted agent source directory",
            path.display()
        ));
    }

    Ok(canonical_path)
}

fn validate_existing_regular_file(
    path: &Path,
    context: &'static str,
) -> Result<std::fs::Metadata, String> {
    if path.as_os_str().is_empty() {
        return Err(format!("Selected {context} file path is empty"));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|err| {
        format!(
            "Failed to access {context} file '{}': {}",
            path.display(),
            err
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Selected {context} path '{}' is a symbolic link. Choose the target file directly.",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Selected {context} path '{}' is not a file",
            path.display()
        ));
    }
    Ok(metadata)
}

fn canonicalize_path(path: &Path, context: &'static str) -> Result<PathBuf, String> {
    path.canonicalize().map_err(|err| {
        format!(
            "Failed to resolve {context} file '{}': {}",
            path.display(),
            err
        )
    })
}

fn lower_file_name(path: &Path) -> Result<String, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?;
    Ok(file_name.to_ascii_lowercase())
}

fn validate_supported_agent_source_extension(path: &Path) -> Result<(), String> {
    let lower_name = lower_file_name(path)?;
    if !lower_name.ends_with(AGENT_MARKDOWN_SUFFIX) {
        return Err("Unsupported agent source file type. Expected a .md file.".to_string());
    }
    Ok(())
}

fn validate_file_size(size: u64, label: &'static str) -> Result<(), String> {
    if size > MAX_PERSONA_IMPORT_BYTES {
        return Err(format!(
            "{label} must be 4 MB or smaller. Selected file is {size} bytes."
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn read_import_agent_file(source_path: String) -> Result<ImportBinaryFileReadResult, String> {
    let path = validate_agent_import_path(&source_path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?
        .to_string();
    let file = std::fs::File::open(&path)
        .map_err(|err| format!("Failed to open agent import '{}': {err}", path.display()))?;
    let mut file_bytes = Vec::new();
    file.take(MAX_AGENT_IMAGE_IMPORT_BYTES + 1)
        .read_to_end(&mut file_bytes)
        .map_err(|err| format!("Failed to read agent import '{}': {err}", path.display()))?;
    if file_bytes.len() as u64 > MAX_AGENT_IMAGE_IMPORT_BYTES {
        return Err("Agent import file must be 10 MB or smaller.".to_string());
    }
    Ok(ImportBinaryFileReadResult {
        file_bytes,
        file_name,
    })
}

#[tauri::command]
pub fn read_agent_source_file(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<ImportFileReadResult, String> {
    let e2e_agents_dir = app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .map(|mode| mode.agents_dir());
    let mut roots = vec![e2e_agents_dir
        .clone()
        .unwrap_or(crate::services::distill_root::app_root(&app)?.join("agents"))];
    if e2e_agents_dir.is_none() {
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join(".agents/agents"));
        }
        if let Some(parent) = Path::new(&source_path).parent().filter(|parent| {
            parent.file_name().and_then(|name| name.to_str()) == Some("agents")
                && parent
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|name| name.to_str())
                    == Some(".distill")
        }) {
            roots.push(parent.to_path_buf());
        }
    }
    let path = validate_agent_source_path_with_roots(&source_path, &roots)?;
    read_persona_file(path, "agent source")
}

fn read_persona_file(path: PathBuf, context: &'static str) -> Result<ImportFileReadResult, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?
        .to_string();
    let file_bytes = std::fs::read(&path).map_err(|err| {
        format!(
            "Failed to read {context} file '{}': {}",
            path.display(),
            err
        )
    })?;
    let file_contents =
        String::from_utf8(file_bytes).map_err(|_| "File is not valid UTF-8 text".to_string())?;

    Ok(ImportFileReadResult {
        file_contents,
        file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_agent_source_path_with_roots;
    use tempfile::{tempdir, Builder};

    #[test]
    fn validate_agent_source_path_rejects_files_outside_trusted_root() {
        let trusted_root = tempdir().unwrap();
        let file = Builder::new()
            .prefix("agent-source-")
            .suffix(".md")
            .tempfile()
            .unwrap();

        let result = validate_agent_source_path_with_roots(
            file.path().to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        );

        assert!(result.unwrap_err().contains("outside the trusted"));
    }

    #[test]
    fn validate_agent_source_path_accepts_plain_markdown_files_inside_trusted_root() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("scout.md");
        std::fs::write(&file_path, b"---\nname: Scout\n---\n\nPrompt").unwrap();

        let validated = validate_agent_source_path_with_roots(
            file_path.to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        )
        .unwrap();

        assert_eq!(validated, file_path.canonicalize().unwrap());
    }

    #[test]
    fn isolated_agent_root_rejects_normal_home_agent_sources() {
        let tmp = tempdir().unwrap();
        let isolated_root = tmp
            .path()
            .join("run")
            .join("isolated")
            .join(".agents")
            .join("agents");
        let normal_root = tmp.path().join("home").join(".agents").join("agents");
        std::fs::create_dir_all(&isolated_root).unwrap();
        std::fs::create_dir_all(&normal_root).unwrap();
        let isolated_agent = isolated_root.join("isolated.md");
        let normal_agent = normal_root.join("normal.md");
        std::fs::write(&isolated_agent, b"---\nname: Isolated\n---\n\nPrompt").unwrap();
        std::fs::write(&normal_agent, b"---\nname: Normal\n---\n\nSecret").unwrap();

        let isolated = validate_agent_source_path_with_roots(
            isolated_agent.to_str().unwrap(),
            std::slice::from_ref(&isolated_root),
        )
        .unwrap();
        assert_eq!(isolated, isolated_agent.canonicalize().unwrap());

        let error =
            validate_agent_source_path_with_roots(normal_agent.to_str().unwrap(), &[isolated_root])
                .unwrap_err();
        assert!(error.contains("outside the trusted"));
        assert_eq!(
            std::fs::read_to_string(normal_agent).unwrap(),
            "---\nname: Normal\n---\n\nSecret"
        );
    }
}
