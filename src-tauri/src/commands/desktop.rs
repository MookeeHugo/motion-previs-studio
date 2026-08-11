//! Desktop persistence/export commands used by the Tauri compatibility bridge.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{command, AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionResult {
    pub saved: bool,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningBundleResult {
    pub output_dir: String,
    pub zip_path: String,
    pub manifest_path: String,
    pub files: BTreeMap<String, Option<String>>,
}

#[command]
pub async fn save_session(app: AppHandle, session: Value) -> Result<SaveSessionResult, String> {
    let dir = app_dir(&app)?.join("sessions");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建会话目录失败: {e}"))?;

    let mut saved = session;
    if let Some(object) = saved.as_object_mut() {
        object.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
        object.insert("savedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
    }

    let path = dir.join("latest-session.json");
    write_json(&path, &saved).await?;
    Ok(SaveSessionResult {
        saved: true,
        path: path.to_string_lossy().to_string(),
    })
}

#[command]
pub async fn load_session(app: AppHandle) -> Result<Option<Value>, String> {
    let path = app_dir(&app)?.join("sessions").join("latest-session.json");
    if !path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("读取会话失败: {e}"))?;
    let mut session: Value = serde_json::from_str(&content).map_err(|e| format!("解析会话失败: {e}"))?;

    let source_exists = session
        .get("sourcePath")
        .and_then(Value::as_str)
        .map(|source| source.starts_with("demo://") || Path::new(source).exists())
        .unwrap_or(false);
    if let Some(object) = session.as_object_mut() {
        object.insert("sourceExists".into(), json!(source_exists));
    }

    Ok(Some(session))
}

#[command]
pub async fn save_planning_bundle(app: AppHandle, payload: Value) -> Result<PlanningBundleResult, String> {
    let title = payload
        .pointer("/blueprint/projectTitle")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/planningData/projectTitle").and_then(Value::as_str))
        .unwrap_or("动作预演包");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let output_dir = app_dir(&app)?
        .join("exports")
        .join(format!("{}-{}", safe_file_name(title), stamp));
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| format!("创建导出目录失败: {e}"))?;

    let mut files: BTreeMap<String, Option<String>> = BTreeMap::new();
    if let Some(value) = payload.get("blueprint") {
        write_named_json(&output_dir, "motion_blueprint.json", value, "motionBlueprint", &mut files).await?;
    }
    if let Some(value) = payload.get("planningData") {
        write_named_json(&output_dir, "shot_bible.json", value, "shotBible", &mut files).await?;
    }
    if let Some(value) = payload.get("poseData") {
        write_named_json(&output_dir, "pose_landmarks.json", value, "poseData", &mut files).await?;
    }
    if let Some(value) = payload.get("cameraMotionData") {
        write_named_json(&output_dir, "camera_motion.json", value, "cameraMotion", &mut files).await?;
    }
    if let Some(value) = payload.get("analysis") {
        write_named_json(&output_dir, "analysis_manifest.json", value, "analysis", &mut files).await?;
    }

    let readme_path = output_dir.join("README_动作预演包.md");
    let readme = format!(
        "# Motion Previs Studio 动作预演包\n\n项目：{title}\n\n本包由本地 Tauri 版生成，包含镜头节奏、动作节点、关键帧、角色位移、摄影机运动和风险备注。创作资料保存在本机应用数据目录，不需要账号或 API 密钥，也不会上传云端。\n\n建议流程：\n1. 在 `motion_blueprint.json` 中复核镜头编号、动作节拍和风险备注。\n2. 在 `shot_bible.json` 中同步导演意图、参考模式和导出预设。\n3. 如需进入 Blockout，请把本包作为动作/镜头节奏参考导入，避免覆盖场面调度项目。\n"
    );
    tokio::fs::write(&readme_path, readme)
        .await
        .map_err(|e| format!("写入说明失败: {e}"))?;
    files.insert("readme".into(), Some(readme_path.to_string_lossy().to_string()));

    files.entry("reference".into()).or_insert(None);
    files.entry("depth".into()).or_insert(None);
    files.entry("poseMp4".into()).or_insert(None);
    files.entry("openPosePose".into()).or_insert(None);
    files.entry("aiDepthMp4".into()).or_insert(None);

    let manifest_path = output_dir.join("bundle_manifest.json");
    let manifest = json!({
        "app": "Motion Previs Studio",
        "schema": 1,
        "createdAt": chrono::Utc::now().to_rfc3339(),
        "localFirst": true,
        "cloudUpload": false,
        "title": title,
        "files": files,
    });
    write_json(&manifest_path, &manifest).await?;
    files.insert("manifest".into(), Some(manifest_path.to_string_lossy().to_string()));

    Ok(PlanningBundleResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        zip_path: readme_path.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        files,
    })
}

async fn write_named_json(
    output_dir: &Path,
    filename: &str,
    value: &Value,
    key: &str,
    files: &mut BTreeMap<String, Option<String>>,
) -> Result<(), String> {
    let path = output_dir.join(filename);
    write_json(&path, value).await?;
    files.insert(key.to_string(), Some(path.to_string_lossy().to_string()));
    Ok(())
}

async fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("序列化 JSON 失败: {e}"))?;
    tokio::fs::write(path, content)
        .await
        .map_err(|e| format!("写入文件失败 {}: {e}", path.display()))
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法取得应用数据目录: {e}"))
}

fn safe_file_name(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().chars().take(72).collect::<String>();
    if trimmed.is_empty() {
        "动作预演包".to_string()
    } else {
        trimmed
    }
}
