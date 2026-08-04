use crate::document::replace_file;
use crate::state::AppState;
use serde::Serialize;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tempfile::Builder;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, PCWSTR};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTarget {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportCompleted {
    output_path: String,
    success: bool,
    error: Option<String>,
}

fn current_markdown(app: &AppHandle) -> Result<PathBuf, String> {
    app.state::<AppState>()
        .current_file
        .lock()
        .map_err(|_| "現在のファイル状態を取得できません。".to_string())?
        .clone()
        .ok_or_else(|| "先にMarkdownファイルを保存してください。".to_string())
}

fn validate_output(app: &AppHandle, requested: &Path) -> Result<PathBuf, String> {
    let markdown = current_markdown(app)?;
    let expected = markdown.with_extension("pdf");
    if requested != expected {
        return Err("PDFはMarkdownファイルと同じ場所・同じ名前で出力してください。".to_string());
    }
    Ok(expected)
}

pub fn target(app: &AppHandle) -> Result<PdfTarget, String> {
    let path = current_markdown(app)?.with_extension("pdf");
    Ok(PdfTarget {
        path: path.to_string_lossy().into_owned(),
        exists: path.exists(),
    })
}

pub fn start_export(app: &AppHandle, requested: &Path) -> Result<String, String> {
    let output = validate_output(app, requested)?;
    let parent = output
        .parent()
        .ok_or_else(|| "PDF出力先のフォルダを取得できません。".to_string())?;
    let temporary = Builder::new()
        .prefix(".markdown-quick-memo.")
        .suffix(".pdf.tmp")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    let temporary_path = temporary.path().to_path_buf();
    temporary.close().map_err(|error| error.to_string())?;

    let output_for_callback = output.clone();
    let temporary_for_callback = temporary_path.clone();
    let app_for_callback = app.clone();
    let output_label = output.to_string_lossy().into_owned();
    let output_for_result = output_label.clone();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "メインWebViewが見つかりません。".to_string())?;

    window
        .with_webview(move |webview| {
            let app_on_complete = app_for_callback.clone();
            let result = (|| -> windows::core::Result<()> {
                let core = unsafe { webview.controller().CoreWebView2()? };
                let printable: ICoreWebView2_7 = core.cast()?;
                let path_wide: Vec<u16> = temporary_path
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let callback = PrintToPdfCompletedHandler::create(Box::new(
                    move |operation_result, succeeded| {
                        let completion = match operation_result {
                            Ok(()) if succeeded => {
                                match replace_file(&temporary_for_callback, &output_for_callback) {
                                    Ok(()) => PdfExportCompleted {
                                        output_path: output_label.clone(),
                                        success: true,
                                        error: None,
                                    },
                                    Err(error) => PdfExportCompleted {
                                        output_path: output_label.clone(),
                                        success: false,
                                        error: Some(error.to_string()),
                                    },
                                }
                            }
                            Ok(()) => PdfExportCompleted {
                                output_path: output_label.clone(),
                                success: false,
                                error: Some(
                                    "WebView2がPDF出力を完了できませんでした。".to_string(),
                                ),
                            },
                            Err(error) => PdfExportCompleted {
                                output_path: output_label.clone(),
                                success: false,
                                error: Some(error.to_string()),
                            },
                        };
                        if !completion.success {
                            let _ = fs::remove_file(&temporary_for_callback);
                        }
                        let _ = app_on_complete.emit("pdf-export-completed", completion);
                        Ok(())
                    },
                ));
                unsafe {
                    printable.PrintToPdf(PCWSTR(path_wide.as_ptr()), None, &callback)?;
                }
                Ok(())
            })();

            if let Err(error) = result {
                let _ = fs::remove_file(&temporary_path);
                let _ = app_for_callback.emit(
                    "pdf-export-completed",
                    PdfExportCompleted {
                        output_path: output_for_result,
                        success: false,
                        error: Some(error.to_string()),
                    },
                );
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(output.to_string_lossy().into_owned())
}

pub fn open_output(app: &AppHandle, requested: &Path) -> Result<(), String> {
    let output = validate_output(app, requested)?;
    if !output.exists() {
        return Err("PDFファイルが見つかりません。".to_string());
    }
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let path_wide: Vec<u16> = output
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            path_wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err(format!(
            "PDFを開けませんでした（ShellExecuteW: {result:?}）。"
        ))
    } else {
        Ok(())
    }
}
