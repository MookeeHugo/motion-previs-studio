// Motion Previs Studio - Library entry
pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::project::get_app_data_dir,
            commands::project::get_projects_dir,
            commands::project::list_projects,
            commands::project::load_project,
            commands::project::save_project,
            commands::project::create_project,
            commands::project::delete_project,
            commands::desktop::save_session,
            commands::desktop::load_session,
            commands::desktop::save_planning_bundle,
            commands::version::get_version,
            commands::mcp::start_mcp_server,
            commands::mcp::stop_mcp_server,
            commands::mcp::get_mcp_status,
        ])
        .setup(|app| {
            println!("Starting Motion Previs Studio v{}", app.package_info().version);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
