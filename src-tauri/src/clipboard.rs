#[cfg(windows)]
pub fn write_text(text: &str) -> Result<(), String> {
    use windows::ApplicationModel::DataTransfer::{
        Clipboard, ClipboardContentOptions, DataPackage, DataPackageOperation,
    };
    use windows::core::HSTRING;

    let content = DataPackage::new().map_err(clipboard_error)?;
    content
        .SetRequestedOperation(DataPackageOperation::Copy)
        .map_err(clipboard_error)?;
    content
        .SetText(&HSTRING::from(text))
        .map_err(clipboard_error)?;

    let options = ClipboardContentOptions::new().map_err(clipboard_error)?;
    options
        .SetIsAllowedInHistory(true)
        .map_err(clipboard_error)?;
    let copied = Clipboard::SetContentWithOptions(&content, &options).map_err(clipboard_error)?;
    if !copied {
        return Err("Windowsのクリップボードが使用中です。".to_string());
    }
    Clipboard::Flush().map_err(clipboard_error)
}

#[cfg(windows)]
fn clipboard_error(error: windows::core::Error) -> String {
    format!("Windowsのクリップボードへ書き込めませんでした: {error}")
}

#[cfg(not(windows))]
pub fn write_text(_text: &str) -> Result<(), String> {
    Err("このコピー処理はWindowsだけで利用できます。".to_string())
}
