use crate::state::AppState;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "メインウィンドウが見つかりません。".to_string())?;
    if window.is_minimized().map_err(|error| error.to_string())? {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .emit("focus-editor", ())
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
