use crate::services::diagnostic_log::{self, DiagnosticEventInput};

#[tauri::command]
pub fn write_diagnostic_event(input: DiagnosticEventInput) -> Result<(), String> {
    diagnostic_log::write_event(input)
}
