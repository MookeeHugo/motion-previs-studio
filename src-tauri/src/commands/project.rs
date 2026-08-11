//! Project management commands for Motion Previs Studio

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{command, AppHandle, Manager};
use uuid::Uuid;

const MAX_PROJECT_ID_LEN: usize = 128;
const MAX_PROJECT_JSON_BYTES: u64 = 20 * 1024 * 1024;

pub(crate) fn validate_project_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_PROJECT_ID_LEN {
        return Err("Project id length is invalid".to_string());
    }
    if id == "." || id == ".." || id.contains("..") {
        return Err("Project id cannot contain path traversal".to_string());
    }
    if !id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')) {
        return Err("Project id contains unsupported characters".to_string());
    }
    Ok(())
}

fn project_file(projects_dir: &Path, id: &str) -> Result<PathBuf, String> {
    validate_project_id(id)?;
    Ok(projects_dir.join(format!("{}.mprevis", id)))
}

async fn read_project_text(path: &Path) -> Result<String, String> {
    if let Ok(meta) = tokio::fs::metadata(path).await {
        if meta.len() > MAX_PROJECT_JSON_BYTES {
            return Err("Project file is too large to load safely".to_string());
        }
    }
    tokio::fs::read_to_string(path).await.map_err(|e| format!("Read: {}", e))
}

/// Get the app data directory
#[command]
pub fn get_app_data_dir(app: AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
}

/// Pose data from motion capture
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pose {
    pub id: String,
    pub frame_index: i32,
    pub keypoints: Vec<Keypoint>,
    pub confidence: f32,
}

/// Keypoint for pose estimation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keypoint {
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub confidence: f32,
}

/// Camera motion data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraMotion {
    pub frame_index: i32,
    pub position: [f32; 3],
    pub rotation: [f32; 3],
}

/// Frame/segment structure
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub start_frame: i32,
    pub end_frame: i32,
    pub poses: Vec<Pose>,
    pub camera_motion: Option<CameraMotion>,
    pub notes: String,
}

/// Project structure
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub video_path: Option<String>,
    pub segments: Vec<Segment>,
    pub fps: f32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String, pub name: String, pub created_at: String, pub updated_at: String, pub segment_count: i32,
}

#[command]
pub fn get_projects_dir() -> Result<PathBuf, String> {
    dirs::document_dir().map(|d| d.join("MotionPrevis")).ok_or_else(|| "Cannot find documents directory".to_string())
}

#[command]
pub async fn list_projects() -> Result<Vec<ProjectMeta>, String> {
    let dir = dirs::document_dir().map(|d| d.join("MotionPrevis")).ok_or_else(|| "Cannot find documents directory".to_string())?;
    let mut projects = Vec::new();
    if !dir.exists() { return Ok(projects); }
    let mut entries = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if path.extension().map(|e| e == "mprevis").unwrap_or(false) {
            match load_project_from_path(&path).await {
                Ok(p) => projects.push(ProjectMeta { id: p.id, name: p.name, created_at: p.created_at, updated_at: p.updated_at, segment_count: p.segments.len() as i32 }),
                Err(e) => tracing::warn!("Load error: {}", e),
            }
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

async fn load_project_from_path(path: &Path) -> Result<Project, String> {
    let content = read_project_text(path).await?;
    serde_json::from_str(&content).map_err(|e| format!("Parse: {}", e))
}

#[command]
pub async fn load_project(id: String) -> Result<Project, String> {
    let dir = dirs::document_dir().map(|d| d.join("MotionPrevis")).ok_or_else(|| "Cannot find documents directory".to_string())?;
    let path = project_file(&dir, &id)?;
    load_project_from_path(&path).await
}

#[command]
pub async fn save_project(project: Project) -> Result<String, String> {
    let dir = dirs::document_dir().map(|d| d.join("MotionPrevis")).ok_or_else(|| "Cannot find documents directory".to_string())?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = project_file(&dir, &project.id)?;
    let content = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[command]
pub async fn create_project(name: String) -> Result<Project, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let project = Project { id: Uuid::new_v4().to_string(), name, video_path: None, segments: Vec::new(), fps: 30.0, created_at: now.clone(), updated_at: now };
    save_project(project.clone()).await?;
    Ok(project)
}

#[command]
pub async fn delete_project(id: String) -> Result<(), String> {
    let dir = dirs::document_dir().map(|d| d.join("MotionPrevis")).ok_or_else(|| "Cannot find documents directory".to_string())?;
    let path = project_file(&dir, &id)?;
    if !path.exists() { return Err("Not found".to_string()); }
    tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    Ok(())
}
