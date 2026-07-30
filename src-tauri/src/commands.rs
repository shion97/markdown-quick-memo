use crate::document::{ensure_markdown_suffix, read_markdown, write_markdown};
use crate::launcher_protocol;
use crate::lifecycle::show_main_window;
use crate::pdf::{self, PdfTarget};
use crate::state::{AppState, HotkeyStatus};
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};
use url::Url;

const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub background: bool,
    pub document: Option<DocumentPayload>,
    pub hotkey: HotkeyStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub revision: u64,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn set_current_path(state: &AppState, path: PathBuf) -> Result<(), String> {
    *state
        .current_file
        .lock()
        .map_err(|_| "現在のファイル状態を更新できません。".to_string())? = Some(path);
    Ok(())
}

#[tauri::command]
pub fn bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let startup_path = state
        .startup_file
        .lock()
        .map_err(|_| "起動ファイル状態を取得できません。".to_string())?
        .take();
    let document = match startup_path {
        Some(path) => {
            let content = read_markdown(&path).map_err(|error| error.to_string())?;
            set_current_path(&state, path.clone())?;
            Some(DocumentPayload {
                path: path_string(&path),
                content,
            })
        }
        None => None,
    };
    let hotkey = {
        let mut status = state
            .hotkey
            .lock()
            .map_err(|_| "ホットキー状態を取得できません。".to_string())?;
        status.refresh_registration();
        status.clone()
    };
    Ok(BootstrapPayload {
        background: state.background,
        document,
        hotkey,
    })
}

#[tauri::command]
pub fn frontend_ready(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.ready.store(true, Ordering::SeqCst);
    log::info!("CodeMirrorの初期化が完了しました");
    if state.should_show_after_ready() {
        show_main_window(&app)?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_document(path: String, state: State<'_, AppState>) -> Result<DocumentPayload, String> {
    let path = PathBuf::from(path);
    let content = read_markdown(&path).map_err(|error| error.to_string())?;
    set_current_path(&state, path.clone())?;
    Ok(DocumentPayload {
        path: path_string(&path),
        content,
    })
}

#[tauri::command]
pub fn save_document(
    path: Option<String>,
    content: String,
    revision: u64,
    state: State<'_, AppState>,
) -> Result<SaveResult, String> {
    let requested = match path {
        Some(path) => PathBuf::from(path),
        None => state
            .current_file
            .lock()
            .map_err(|_| "現在のファイル状態を取得できません。".to_string())?
            .clone()
            .ok_or_else(|| "保存先が指定されていません。".to_string())?,
    };
    let saved = write_markdown(&requested, &content).map_err(|error| error.to_string())?;
    set_current_path(&state, saved.clone())?;
    Ok(SaveResult {
        path: path_string(&saved),
        revision,
    })
}

#[tauri::command]
pub fn rename_document(
    new_name: String,
    state: State<'_, AppState>,
) -> Result<DocumentPayload, String> {
    if new_name.trim().is_empty()
        || Path::new(&new_name)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("ファイル名だけを入力してください。".to_string());
    }
    let current = state
        .current_file
        .lock()
        .map_err(|_| "現在のファイル状態を取得できません。".to_string())?
        .clone()
        .ok_or_else(|| "名前を変更するファイルがありません。".to_string())?;
    let parent = current
        .parent()
        .ok_or_else(|| "親フォルダを取得できません。".to_string())?;
    let requested = parent.join(new_name);
    let destination = if requested.extension().is_none() {
        let extension = current
            .extension()
            .unwrap_or_else(|| std::ffi::OsStr::new("md"));
        requested.with_extension(extension)
    } else {
        requested
    };
    if destination.exists() {
        return Err("同名のファイルが既に存在します。".to_string());
    }
    fs::rename(&current, &destination).map_err(|error| error.to_string())?;
    let content = read_markdown(&destination).map_err(|error| error.to_string())?;
    set_current_path(&state, destination.clone())?;
    Ok(DocumentPayload {
        path: path_string(&destination),
        content,
    })
}

#[tauri::command]
pub fn reveal_document(state: State<'_, AppState>) -> Result<(), String> {
    let current = state
        .current_file
        .lock()
        .map_err(|_| "現在のファイル状態を取得できません。".to_string())?
        .clone()
        .ok_or_else(|| "保存済みファイルがありません。".to_string())?;
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", current.display()))
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let parent = current.parent().unwrap_or_else(|| Path::new("."));
        Command::new("open")
            .arg(parent)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn local_image_data(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if relative_path.starts_with("http://") || relative_path.starts_with("https://") {
        return Err("外部画像URLは取得しません。".to_string());
    }
    let current = state
        .current_file
        .lock()
        .map_err(|_| "現在のファイル状態を取得できません。".to_string())?
        .clone();
    let base = current
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."));
    let base = fs::canonicalize(base).map_err(|error| error.to_string())?;
    let candidate =
        fs::canonicalize(base.join(relative_path)).map_err(|error| error.to_string())?;
    if !candidate.starts_with(&base) {
        return Err("Markdownファイルのフォルダ外にある画像は表示できません。".to_string());
    }
    let metadata = fs::metadata(&candidate).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("画像が20MBを超えています。".to_string());
    }
    let mime = mime_guess::from_path(&candidate)
        .first_raw()
        .filter(|value| value.starts_with("image/"))
        .ok_or_else(|| "対応していない画像形式です。".to_string())?;
    let bytes = fs::read(candidate).map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "メインウィンドウが見つかりません。".to_string())?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn confirm_exit(app: AppHandle, state: State<'_, AppState>) {
    state.allow_close.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub fn hotkey_status(state: State<'_, AppState>) -> Result<HotkeyStatus, String> {
    let mut status = state
        .hotkey
        .lock()
        .map_err(|_| "ホットキー状態を取得できません。".to_string())?;
    status.refresh_registration();
    Ok(status.clone())
}

#[tauri::command]
pub fn update_hotkey(shortcut: String, state: State<'_, AppState>) -> Result<HotkeyStatus, String> {
    let shortcut = launcher_protocol::replace_running_shortcut(shortcut.trim())?;
    let mut status = state
        .hotkey
        .lock()
        .map_err(|_| "ホットキー状態を更新できません。".to_string())?;
    status.update_shortcut(shortcut);
    Ok(status.clone())
}

#[tauri::command]
pub fn pdf_target(app: AppHandle) -> Result<PdfTarget, String> {
    pdf::target(&app)
}

#[tauri::command]
pub fn export_pdf(app: AppHandle, output_path: String) -> Result<String, String> {
    pdf::start_export(&app, Path::new(&output_path))
}

#[tauri::command]
pub fn open_pdf(app: AppHandle, output_path: String) -> Result<(), String> {
    pdf::open_output(&app, Path::new(&output_path))
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "URLが不正です。".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("許可されていないURLスキームです。".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let url_wide: Vec<u16> = std::ffi::OsStr::new(parsed.as_str())
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                url_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("既定のアプリでURLを開けませんでした。".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_window_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    if !(0.2..=1.0).contains(&opacity) {
        return Err("不透明度は20%から100%の範囲で指定してください。".to_string());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetWindowLongW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongW,
            WS_EX_LAYERED,
        };

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "メインウィンドウが見つかりません。".to_string())?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        let style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
        unsafe {
            SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as i32);
        }
        let alpha = (opacity * 255.0).round() as u8;
        let succeeded = unsafe { SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) };
        if succeeded == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ensure_markdown_path(path: String) -> String {
    path_string(&ensure_markdown_suffix(Path::new(&path)))
}
