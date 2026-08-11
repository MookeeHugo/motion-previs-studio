//! MCP server management for Motion Previs Studio

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::command;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};
use std::process::Stdio;

use super::project::validate_project_id;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatus { pub running: bool, pub project_id: Option<String> }

static MCP_SERVERS: Mutex<Option<HashMap<String, tokio::process::Child>>> = Mutex::new(None);

#[command]
pub async fn start_mcp_server(project_id: String) -> Result<McpStatus, String> {
    validate_project_id(&project_id)?;
    let mut servers_guard = MCP_SERVERS
        .lock()
        .map_err(|_| "MCP server registry is unavailable".to_string())?;
    let servers = servers_guard.get_or_insert_with(HashMap::new);
    if servers.contains_key(&project_id) { return Ok(McpStatus { running: true, project_id: Some(project_id) }); }

    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    let mcp_script = [
        "_up_/mcp/motion-previs-mcp.mjs",
        "resources/mcp/motion-previs-mcp.mjs",
        "resources/motion-previs-mcp.mjs",
        "mcp/motion-previs-mcp.mjs",
    ].iter()
        .map(|p| exe_dir.join(p)).find(|p| p.exists())
        .ok_or_else(|| "未找到随包附带的 MCP 桥接脚本".to_string())?;

    let mut child = Command::new("node").arg(mcp_script).arg("--project-id").arg(project_id.clone())
        .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
        .spawn().map_err(|e| format!("启动 MCP 桥接失败: {}", e))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move { let mut r = BufReader::new(stderr).lines(); while let Ok(Some(l)) = r.next_line().await { tracing::debug!("MCP: {}", l); } });
    }
    servers.insert(project_id.clone(), child);
    Ok(McpStatus { running: true, project_id: Some(project_id) })
}

#[command]
pub async fn stop_mcp_server(project_id: String) -> Result<(), String> {
    validate_project_id(&project_id)?;
    let child = {
        let mut s = MCP_SERVERS
            .lock()
            .map_err(|_| "MCP server registry is unavailable".to_string())?;
        if let Some(ref mut s) = *s { s.remove(&project_id) } else { None }
    };
    if let Some(mut c) = child { c.kill().await.map_err(|e| e.to_string())?; }
    Ok(())
}

#[command]
pub fn get_mcp_status(project_id: Option<String>) -> Result<Vec<McpStatus>, String> {
    let s = MCP_SERVERS
        .lock()
        .map_err(|_| "MCP server registry is unavailable".to_string())?;
    let s = s.as_ref().ok_or("Not initialized")?;
    if let Some(id) = project_id {
        validate_project_id(&id)?;
        return Ok(vec![McpStatus { running: s.contains_key(&id), project_id: Some(id) }]);
    }
    Ok(s.keys().map(|id| McpStatus { running: true, project_id: Some(id.clone()) }).collect())
}
