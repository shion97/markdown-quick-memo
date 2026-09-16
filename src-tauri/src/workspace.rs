use crate::state::{AppState, OpenDocument, Transfer, WorkspaceState};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
};

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn canonical_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path.canonicalize().map_err(|error| error.to_string());
    }
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    let parent = absolute
        .parent()
        .ok_or("保存先が不正です。")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    Ok(parent.join(absolute.file_name().ok_or("保存先が不正です。")?))
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
}

pub fn document_path(
    state: &AppState,
    window: &WebviewWindow,
    id: &str,
) -> Result<Option<PathBuf>, String> {
    let workspace = state.workspace.lock().map_err(|error| error.to_string())?;
    let document = workspace
        .documents
        .get(id)
        .ok_or("文書が見つかりません。")?;
    if document.window != window.label() {
        return Err("文書は別のウィンドウにあります。".into());
    }
    Ok(document.path.clone())
}

pub fn check_destination(
    state: &AppState,
    window: &WebviewWindow,
    id: &str,
    path: &Path,
) -> Result<(), String> {
    let path = canonical_path(path)?;
    let workspace = state.workspace.lock().map_err(|error| error.to_string())?;
    if workspace
        .documents
        .get(id)
        .is_none_or(|doc| doc.window != window.label())
    {
        return Err("文書が見つかりません。".into());
    }
    if workspace.documents.iter().any(|(key, doc)| {
        key != id
            && doc
                .path
                .as_ref()
                .is_some_and(|existing| same_path(existing, &path))
    }) {
        return Err("このファイルは別のタブで開かれています。".into());
    }
    Ok(())
}

pub fn set_document_path(
    state: &AppState,
    window: &WebviewWindow,
    id: &str,
    path: Option<PathBuf>,
) -> Result<(), String> {
    let path = path.map(|path| canonical_path(&path)).transpose()?;
    if let Some(ref path) = path {
        check_destination(state, window, id, path)?;
    }
    let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
    let document = workspace
        .documents
        .get_mut(id)
        .ok_or("文書が見つかりません。")?;
    if document.window != window.label() {
        return Err("文書は移動済みです。".into());
    }
    document.path = path;
    Ok(())
}

#[tauri::command]
pub fn register_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    document_id: String,
) -> Result<(), String> {
    let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
    if workspace.exit_active {
        return Err("終了確認中です。".into());
    }
    if workspace.documents.contains_key(&document_id) {
        return Err("文書IDが重複しています。".into());
    }
    workspace.documents.insert(
        document_id,
        OpenDocument {
            window: window.label().into(),
            path: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn clear_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    document_id: String,
) -> Result<(), String> {
    set_document_path(&state, &window, &document_id, None)
}

#[tauri::command]
pub fn release_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    document_id: String,
) -> Result<(), String> {
    document_path(&state, &window, &document_id)?;
    state
        .workspace
        .lock()
        .map_err(|error| error.to_string())?
        .documents
        .remove(&document_id);
    Ok(())
}

#[tauri::command]
pub fn focus_existing(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<bool, String> {
    let path = canonical_path(Path::new(&path))?;
    let existing = {
        let workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        workspace
            .documents
            .iter()
            .find(|(_, doc)| {
                doc.path
                    .as_ref()
                    .is_some_and(|existing| same_path(existing, &path))
            })
            .map(|(id, doc)| (id.clone(), doc.window.clone()))
    };
    if let Some((id, label)) = existing {
        let window = app
            .get_webview_window(&label)
            .ok_or("ウィンドウが見つかりません。")?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        window
            .emit_to(window.label(), "select-document", id)
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

fn show_exit_confirmation(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("終了確認先が見つかりません。")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window.emit_to(label, "check-exit", ()).map_err(|error| error.to_string())
}

fn begin_exit(
    workspace: &mut WorkspaceState,
    target: Option<&str>,
) -> Result<Option<String>, String> {
    if workspace.exit_active {
        return Ok(None);
    }
    if workspace.dragging || !workspace.transfers.is_empty() {
        return Err("タブの移動が終わってから終了してください。".into());
    }
    workspace.exit_pending = match target {
        Some(label) if workspace.ready_windows.contains(label) => vec![label.into()],
        Some(_) => return Err("終了するウィンドウが見つかりません。".into()),
        None => {
            let mut labels: Vec<_> = workspace.ready_windows.iter().cloned().collect();
            labels.sort();
            labels
        }
    };
    workspace.exit_target = target.map(str::to_owned);
    workspace.exit_active = true;
    Ok(workspace.exit_pending.first().cloned())
}

fn emit_exit_lock(app: &AppHandle, target: Option<&str>, locked: bool) -> Result<(), String> {
    match target {
        Some(label) => app.emit_to(label, "exit-lock", locked),
        None => app.emit("exit-lock", locked),
    }
    .map_err(|error| error.to_string())
}

pub fn request_exit(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let first = {
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        if workspace.exit_active {
            return Ok(());
        }
        begin_exit(&mut workspace, None)?
    };
    emit_exit_lock(app, None, true)?;
    if let Some(label) = first {
        show_exit_confirmation(app, &label)?;
    }
    Ok(())
}

pub fn request_window_close(window: &Window) -> Result<(), String> {
    let app = window.app_handle();
    let state = window.state::<AppState>();
    let close_application = state
        .workspace
        .lock()
        .map_err(|error| error.to_string())?
        .ready_windows
        .len()
        <= 1;
    if close_application {
        return request_exit(app);
    }

    let label = window.label();
    let first = {
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        if workspace.exit_active {
            return Ok(());
        }
        begin_exit(&mut workspace, Some(label))?
    };
    emit_exit_lock(app, Some(label), true)?;
    if first.is_some() {
        show_exit_confirmation(app, label)?;
    }
    Ok(())
}

#[tauri::command]
pub fn exit_response(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    accepted: bool,
) -> Result<(), String> {
    let (next, target) = {
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        if !workspace.exit_active
            || workspace
                .exit_pending
                .first()
                .is_none_or(|label| label != window.label())
        {
            return Ok(());
        }
        if !accepted {
            let target = workspace.exit_target.take();
            workspace.exit_active = false;
            workspace.exit_pending.clear();
            drop(workspace);
            emit_exit_lock(&app, target.as_deref(), false)?;
            return Ok(());
        }
        workspace.exit_pending.remove(0);
        let next = workspace.exit_pending.first().cloned();
        let target = if next.is_none() {
            workspace.exit_target.take()
        } else {
            None
        };
        (next, target)
    };
    if let Some(label) = next {
        show_exit_confirmation(&app, &label)?;
    } else if let Some(label) = target {
        {
            let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
            workspace
                .documents
                .retain(|_, document| document.window != label);
            workspace.ready_windows.remove(&label);
            workspace.exit_active = false;
            if workspace.last_window == label {
                workspace.last_window = workspace
                    .ready_windows
                    .iter()
                    .next()
                    .cloned()
                    .unwrap_or_default();
            }
        }
        app.get_webview_window(&label)
            .ok_or("終了するウィンドウが見つかりません。")?
            .destroy()
            .map_err(|error| error.to_string())?;
    } else {
        state.allow_close.store(true, Ordering::SeqCst);
        app.exit(0);
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragResult {
    target: Option<String>,
    x: i32,
    y: i32,
    client_y: f64,
    outside: bool,
    cancelled: bool,
}

// Native coordinates remain physical until converted against the destination monitor's scale.
#[tauri::command]
pub async fn drag_tab(app: AppHandle, window: WebviewWindow) -> Result<DragResult, String> {
    {
        let state = app.state::<AppState>();
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        if workspace.dragging || workspace.exit_active || !workspace.transfers.is_empty() {
            return Err("別の操作が進行中です。".into());
        }
        workspace.dragging = true;
    }
    let app_for_drag = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GA_ROOT, GetAncestor, GetCursorPos, GetSystemMetrics, SM_CXDRAG, SM_CYDRAG,
            WindowFromPoint,
        };
        let mut start = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut start) } == 0 {
            return Err("マウス位置を取得できません。".to_string());
        }
        let mut moved = false;
        loop {
            let mut cursor = POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut cursor) } == 0 {
                return Err("マウス位置を取得できません。".to_string());
            }
            moved |= (cursor.x - start.x).abs() >= unsafe { GetSystemMetrics(SM_CXDRAG) }
                || (cursor.y - start.y).abs() >= unsafe { GetSystemMetrics(SM_CYDRAG) };
            let cancelled = unsafe { GetAsyncKeyState(VK_ESCAPE as i32) } < 0;
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0;
            let mut result = DragResult {
                target: None,
                x: cursor.x,
                y: cursor.y,
                client_y: 0.0,
                outside: true,
                cancelled: cancelled || !moved,
            };
            let topmost = unsafe { GetAncestor(WindowFromPoint(cursor), GA_ROOT) };
            for candidate in app_for_drag.webview_windows().values() {
                if !candidate.is_visible().unwrap_or(false)
                    || candidate.is_minimized().unwrap_or(false)
                {
                    continue;
                }
                let position = candidate.outer_position().map_err(|error| error.to_string())?;
                let size = candidate.outer_size().map_err(|error| error.to_string())?;
                let inside = candidate.hwnd().is_ok_and(|handle| handle.0 == topmost)
                    && cursor.x >= position.x
                    && cursor.y >= position.y
                    && cursor.x < position.x + size.width as i32
                    && cursor.y < position.y + size.height as i32;
                let inner = candidate.inner_position().map_err(|error| error.to_string())?;
                let scale = candidate.scale_factor().map_err(|error| error.to_string())?;
                let client_x = f64::from(cursor.x - inner.x) / scale;
                let client_y = f64::from(cursor.y - inner.y) / scale;
                if inside {
                    result.outside = false;
                    if (0.0..240.0).contains(&client_x) && client_y >= 0.0 {
                        result.target = Some(candidate.label().into());
                        result.client_y = client_y;
                    }
                }
                if moved {
                    let _ = candidate.emit_to(
                        candidate.label(),
                        "tab-drag-hover",
                        if inside && (0.0..240.0).contains(&client_x) {
                            Some(client_y)
                        } else {
                            None
                        },
                    );
                }
            }
            if cancelled || !down {
                let _ = app_for_drag.emit("tab-drag-hover", Option::<f64>::None);
                return Ok(result);
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    })
    .await
    .map_err(|error| error.to_string());
    app.state::<AppState>()
        .workspace
        .lock()
        .map_err(|error| error.to_string())?
        .dragging = false;
    let _ = window;
    result?
}

#[tauri::command]
pub async fn transfer_tab(
    app: AppHandle,
    window: WebviewWindow,
    document_id: String,
    snapshot: serde_json::Value,
    target: Option<String>,
    x: i32,
    y: i32,
    index: usize,
) -> Result<Transfer, String> {
    let state = app.state::<AppState>();
    document_path(&state, &window, &document_id)?;
    let serial = NEXT_WINDOW.fetch_add(1, Ordering::SeqCst);
    let new_window = target.is_none();
    let label = target.unwrap_or_else(|| format!("memo-{serial}"));
    let transfer = Transfer {
        id: format!("transfer-{serial}"),
        document_id,
        source: window.label().into(),
        target: label.clone(),
        snapshot,
        index,
    };
    {
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        if workspace.exit_active || !workspace.transfers.is_empty() {
            return Err("別の操作が進行中です。".into());
        }
        if !new_window && (label == window.label() || !workspace.ready_windows.contains(&label)) {
            return Err("移動先ウィンドウを利用できません。".into());
        }
        if new_window
            && workspace
                .documents
                .values()
                .filter(|doc| doc.window == window.label())
                .count()
                <= 1
        {
            return Err("最後のタブは新しいウィンドウへ分離できません。".into());
        }
        workspace
            .transfers
            .insert(transfer.id.clone(), transfer.clone());
    }
    if new_window {
        let created = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title("Markdown Quick Memo")
            .inner_size(960.0, 720.0)
            .min_inner_size(560.0, 420.0)
            .visible(false)
            .build();
        match created {
            Ok(created) => {
                let _ = created.set_position(tauri::PhysicalPosition::new(x, y));
            }
            Err(error) => {
                state
                    .workspace
                    .lock()
                    .map_err(|error| error.to_string())?
                    .transfers
                    .remove(&transfer.id);
                return Err(error.to_string());
            }
        }
    } else {
        if let Err(error) = app.emit_to(&label, "receive-tab", &transfer) {
            state
                .workspace
                .lock()
                .map_err(|error| error.to_string())?
                .transfers
                .remove(&transfer.id);
            return Err(error.to_string());
        }
    }
    Ok(transfer)
}

#[tauri::command]
pub fn pending_transfer(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<Transfer>, String> {
    Ok(state
        .workspace
        .lock()
        .map_err(|error| error.to_string())?
        .transfers
        .values()
        .find(|transfer| transfer.target == window.label())
        .cloned())
}

#[tauri::command]
pub fn transfer_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
    document_id: String,
) -> Result<String, String> {
    let workspace = state.workspace.lock().map_err(|error| error.to_string())?;
    if workspace
        .transfers
        .values()
        .any(|transfer| transfer.document_id == document_id)
    {
        return Ok("pending".into());
    }
    let document = workspace
        .documents
        .get(&document_id)
        .ok_or("文書が見つかりません。")?;
    Ok(if document.window == window.label() {
        "cancelled"
    } else {
        "accepted"
    }
    .into())
}

#[tauri::command]
pub fn cancel_transfer(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    document_id: String,
) -> Result<(), String> {
    let cancelled = {
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        let id = workspace
            .transfers
            .values()
            .find(|transfer| {
                transfer.document_id == document_id && transfer.source == window.label()
            })
            .map(|transfer| transfer.id.clone());
        id.and_then(|id| workspace.transfers.remove(&id))
    };
    if let Some(transfer) = cancelled {
        let _ = app.emit_to(
            &transfer.source,
            "transfer-completed",
            serde_json::json!({ "documentId": document_id, "accepted": false }),
        );
        let empty = !state
            .workspace
            .lock()
            .map_err(|error| error.to_string())?
            .documents
            .values()
            .any(|doc| doc.window == transfer.target);
        if empty {
            if let Some(target) = app.get_webview_window(&transfer.target) {
                let _ = target.destroy();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn accept_transfer(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    transfer_id: String,
    accepted: bool,
) -> Result<(), String> {
    let _io = state.document_io.lock().map_err(|error| error.to_string())?;
    let transfer = complete_transfer(
        &mut *state.workspace.lock().map_err(|error| error.to_string())?,
        window.label(),
        &transfer_id,
        accepted,
    )?;
    let _ = app.emit_to(
        &transfer.source,
        "transfer-completed",
        serde_json::json!({ "documentId": transfer.document_id, "accepted": accepted }),
    );
    if accepted {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if !accepted {
        let empty = !state
            .workspace
            .lock()
            .map_err(|error| error.to_string())?
            .documents
            .values()
            .any(|doc| doc.window == window.label());
        if empty {
            let _ = window.destroy();
        }
    }
    Ok(())
}

fn complete_transfer(
    workspace: &mut WorkspaceState,
    target: &str,
    id: &str,
    accepted: bool,
) -> Result<Transfer, String> {
    let transfer = workspace
        .transfers
        .get(id)
        .ok_or("移動処理が見つかりません。")?
        .clone();
    if transfer.target != target {
        return Err("移動先が異なります。".into());
    }
    let document = workspace
        .documents
        .get_mut(&transfer.document_id)
        .ok_or("文書が見つかりません。")?;
    if document.window != transfer.source {
        return Err("文書の所属先が変わりました。".into());
    }
    if accepted {
        document.window = transfer.target.clone();
    }
    workspace.transfers.remove(id);
    Ok(transfer)
}

#[tauri::command]
pub fn close_empty_window(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut workspace = state.workspace.lock().map_err(|error| error.to_string())?;
        if workspace
            .documents
            .values()
            .any(|doc| doc.window == window.label())
        {
            return Err("文書が残っています。".into());
        }
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
    window.destroy().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> WorkspaceState {
        let mut workspace = WorkspaceState::default();
        workspace.documents.insert(
            "document".into(),
            OpenDocument {
                window: "main".into(),
                path: Some(PathBuf::from("memo.md")),
            },
        );
        workspace.transfers.insert(
            "transfer".into(),
            Transfer {
                id: "transfer".into(),
                document_id: "document".into(),
                source: "main".into(),
                target: "memo-1".into(),
                snapshot: serde_json::json!({ "editor": { "doc": "未保存" }, "revision": [2, 1] }),
                index: 0,
            },
        );
        workspace
    }

    #[test]
    fn ownership_changes_only_after_destination_acknowledges() {
        let mut workspace = pending();
        assert_eq!(workspace.documents["document"].window, "main");
        let transfer = complete_transfer(&mut workspace, "memo-1", "transfer", true).unwrap();
        assert_eq!(workspace.documents["document"].window, "memo-1");
        assert_eq!(transfer.snapshot["editor"]["doc"], "未保存");
        assert!(workspace.transfers.is_empty());
        assert!(complete_transfer(&mut workspace, "memo-1", "transfer", true).is_err());
    }

    #[test]
    fn failed_restore_preserves_source_and_path() {
        let mut workspace = pending();
        complete_transfer(&mut workspace, "memo-1", "transfer", false).unwrap();
        assert_eq!(workspace.documents["document"].window, "main");
        assert_eq!(
            workspace.documents["document"].path,
            Some(PathBuf::from("memo.md"))
        );
    }

    #[test]
    fn other_window_cannot_acknowledge_transfer() {
        let mut workspace = pending();
        assert!(complete_transfer(&mut workspace, "memo-2", "transfer", true).is_err());
        assert_eq!(workspace.documents["document"].window, "main");
        assert!(workspace.transfers.contains_key("transfer"));
    }

    #[test]
    fn canonical_path_resolves_relative_components_and_new_destinations() {
        let directory = tempfile::tempdir().unwrap();
        let existing = directory.path().join("memo.md");
        std::fs::write(&existing, "本文").unwrap();
        assert_eq!(
            canonical_path(&directory.path().join(".").join("memo.md")).unwrap(),
            existing.canonicalize().unwrap()
        );
        let new_path = canonical_path(&directory.path().join("new.md")).unwrap();
        assert_eq!(
            new_path.parent().unwrap(),
            directory.path().canonicalize().unwrap()
        );
        assert!(same_path(
            Path::new("C:\\Memo.md"),
            Path::new("c:\\memo.md")
        ));
    }

    #[test]
    fn window_close_checks_only_the_requested_window() {
        let mut workspace = WorkspaceState::default();
        workspace
            .ready_windows
            .extend(["main".into(), "memo-1".into()]);

        assert_eq!(
            begin_exit(&mut workspace, Some("memo-1")).unwrap(),
            Some("memo-1".into())
        );
        assert_eq!(workspace.exit_pending, ["memo-1"]);
        assert_eq!(workspace.exit_target.as_deref(), Some("memo-1"));
    }

    #[test]
    fn application_exit_checks_every_window() {
        let mut workspace = WorkspaceState::default();
        workspace
            .ready_windows
            .extend(["main".into(), "memo-1".into()]);

        assert_eq!(
            begin_exit(&mut workspace, None).unwrap(),
            Some("main".into())
        );
        assert_eq!(workspace.exit_pending, ["main", "memo-1"]);
        assert_eq!(workspace.exit_target, None);
    }
}
