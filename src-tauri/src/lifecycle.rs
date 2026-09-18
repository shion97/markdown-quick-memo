use crate::state::AppState;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let (label, ready_windows) = {
        let state = app.state::<AppState>();
        let workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        (
            workspace.last_window.clone(),
            workspace.ready_windows.clone(),
        )
    };
    for ready in ready_windows {
        if let Some(window) = app.get_webview_window(&ready) {
            if window.is_minimized().map_err(|error| error.to_string())? {
                window.unminimize().map_err(|error| error.to_string())?;
            }
            window.show().map_err(|error| error.to_string())?;
        }
    }
    let window = app
        .get_webview_window(&label)
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| "メインウィンドウが見つかりません。".to_string())?;
    if window.is_minimized().map_err(|error| error.to_string())? {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .emit_to(window.label(), "focus-editor", ())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn request_show(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.ready.load(Ordering::SeqCst) {
        if let Err(error) = show_main_window(app) {
            log::error!("ウィンドウ表示に失敗しました: {error}");
        }
    } else {
        state.pending_show.store(true, Ordering::SeqCst);
    }
}
