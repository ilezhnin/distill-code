use crate::services::distro_bundle::{DistroBundleInfo, DistroBundleState};
use tauri::State;

#[tauri::command]
pub fn get_distro_bundle(state: State<'_, DistroBundleState>) -> Result<DistroBundleInfo, String> {
    Ok(state.info())
}
