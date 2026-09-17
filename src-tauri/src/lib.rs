mod clipboard;
mod commands;
mod document;
mod launcher_protocol;
mod lifecycle;
mod pdf;
mod state;
mod workspace;

use crate::lifecycle::request_show;
use crate::state::{AppState, LaunchOptions};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let options = LaunchOptions::from_env();
    let state = AppState::new(options);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _cwd| {
                log::info!("既存プロセスへ起動要求を転送しました: {arguments:?}");
                if let Some(path) = LaunchOptions::startup_file_from_secondary_arguments(&arguments)
                {
                    let state = app.state::<AppState>();
                    if state.ready.load(Ordering::SeqCst) {
                        if let Err(error) = app.emit_to(
                            state
                                .workspace
                                .lock()
                                .map(|workspace| workspace.last_window.clone())
                                .unwrap_or_else(|_| "main".into()),
                            "open-file-requested",
                            path.to_string_lossy().into_owned(),
                        ) {
                            log::error!("ファイル起動要求を送信できませんでした: {error}");
                        }
                    } else if let Ok(mut startup_file) = state.startup_file.lock() {
                        *startup_file = Some(path);
                    }
                }
                if LaunchOptions::secondary_hotkey_triggered(&arguments) {
                    let state = app.state::<AppState>();
                    if let Ok(mut status) = state.hotkey.lock() {
                        status.mark_triggered();
                    }
                    if let Err(error) = app.emit("hotkey-triggered", ()) {
                        log::error!("ホットキー診断イベントを送信できませんでした: {error}");
                    }
                }
                if let Some(error) = LaunchOptions::secondary_hotkey_error(&arguments) {
                    let state = app.state::<AppState>();
                    if let Ok(mut status) = state.hotkey.lock() {
                        status.set_error(error);
                    }
                }
                request_show(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            workspace::register_document,
            workspace::clear_document,
            workspace::release_document,
            workspace::focus_existing,
            workspace::exit_response,
            workspace::drag_tab,
            workspace::transfer_tab,
            workspace::pending_transfer,
            workspace::transfer_status,
            workspace::cancel_transfer,
            workspace::accept_transfer,
            workspace::close_empty_window,
            commands::bootstrap,
            commands::frontend_ready,
            commands::open_document,
            commands::save_document,
            commands::rename_document,
            commands::reveal_document,
            commands::local_image_data,
            commands::hide_window,
            commands::confirm_exit,
            commands::hotkey_status,
            commands::update_hotkey,
            commands::pdf_target,
            commands::export_pdf,
            commands::open_pdf,
            commands::open_external_url,
            commands::set_window_opacity,
            commands::copy_text,
            commands::ensure_markdown_path,
        ])
        .setup(|_app| {
            if launcher_protocol::launcher_registered() {
                log::info!("Rustホットキーランチャーへの接続を確認しました");
            } else {
                log::warn!("Rustホットキーランチャーが起動していません");
            }
            log::info!("Tauriバックエンドを初期化しました");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Ok(mut workspace) = window.state::<AppState>().workspace.lock() {
                    workspace.ready_windows.remove(window.label());
                    if workspace.last_window == window.label() {
                        workspace.last_window = workspace
                            .ready_windows
                            .iter()
                            .next()
                            .cloned()
                            .unwrap_or_default();
                    }
                }
            }
            if let WindowEvent::Focused(true) = event {
                if let Ok(mut workspace) = window.state::<AppState>().workspace.lock() {
                    workspace.last_window = window.label().into();
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.allow_close.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Err(error) = workspace::request_window_close(window) {
                        log::error!("終了確認イベントを送信できませんでした: {error}");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauriアプリケーションの実行に失敗しました");
}
