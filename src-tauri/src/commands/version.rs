//! Version info for Motion Previs Studio

use tauri::command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct VersionInfo {
    pub name: String, pub version: String, pub description: String, pub authors: String,
}

#[command]
pub fn get_version() -> VersionInfo {
    VersionInfo {
        name: "Motion Previs Studio".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        description: "Action, depth, pose, and camera motion previsualization".to_string(),
        authors: "BloomReel Team".to_string(),
    }
}
