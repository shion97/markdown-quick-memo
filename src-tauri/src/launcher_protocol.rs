use std::fs;
use std::path::PathBuf;

#[cfg(windows)]
use windows_sys::Win32::UI::{
    Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN},
    WindowsAndMessaging::{FindWindowExW, HWND_MESSAGE, SendMessageW, WM_APP},
};

pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+M";
#[allow(dead_code)]
pub const HOTKEY_MESSAGE_ID: i32 = 0x4D51;
pub const UPDATE_HOTKEY_MESSAGE: u32 = WM_APP + 1;
pub const QUERY_HOTKEY_MESSAGE: u32 = WM_APP + 2;
pub const LAUNCHER_WINDOW_NAME: &str = "MarkdownQuickMemoHotkeyLauncher";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHotkey {
    pub shortcut: String,
    pub modifiers: u32,
    pub virtual_key: u32,
}

pub fn parse_shortcut(value: &str) -> Result<ParsedHotkey, String> {
    let mut control = false;
    let mut alt = false;
    let mut shift = false;
    let mut windows = false;
    let mut key = None;

    for part in value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" if !control => control = true,
            "alt" if !alt => alt = true,
            "shift" if !shift => shift = true,
            "win" | "windows" if !windows => windows = true,
            _ if key.is_none() => key = Some(parse_key(part)?),
            _ => return Err("ホットキーの指定が重複しているか、キーが複数あります。".to_string()),
        }
    }

    let (key_name, virtual_key) =
        key.ok_or_else(|| "文字、数字、またはF1～F24を指定してください。".to_string())?;
    if !(control || alt || shift || windows) {
        return Err("Ctrl、Alt、Shift、Winのいずれかを含めてください。".to_string());
    }

    let mut names = Vec::new();
    let mut modifiers = 0;
    if control {
        names.push("Ctrl");
        modifiers |= MOD_CONTROL;
    }
    if alt {
        names.push("Alt");
        modifiers |= MOD_ALT;
    }
    if shift {
        names.push("Shift");
        modifiers |= MOD_SHIFT;
    }
    if windows {
        names.push("Win");
        modifiers |= MOD_WIN;
    }
    names.push(&key_name);

    Ok(ParsedHotkey {
        shortcut: names.join("+"),
        modifiers,
        virtual_key,
    })
}

fn parse_key(value: &str) -> Result<(String, u32), String> {
    let upper = value.to_ascii_uppercase();
    if upper.len() == 1 {
        let byte = upper.as_bytes()[0];
        if byte.is_ascii_uppercase() || byte.is_ascii_digit() {
            return Ok((upper, u32::from(byte)));
        }
    }
    if let Some(number) = upper
        .strip_prefix('F')
        .and_then(|part| part.parse::<u32>().ok())
        && (1..=24).contains(&number)
    {
        return Ok((upper, 0x70 + number - 1));
    }
    Err("キーは英字、数字、またはF1～F24を指定してください。".to_string())
}

pub fn load_shortcut() -> String {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|value| parse_shortcut(value.trim()).ok())
        .map(|parsed| parsed.shortcut)
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

#[allow(dead_code)]
pub fn save_shortcut(shortcut: &str) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, shortcut).map_err(|error| error.to_string())
}

fn config_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.markdownquickmemo.app")
        .join("hotkey.txt")
}

#[cfg(windows)]
#[allow(dead_code)]
pub fn launcher_registered() -> bool {
    let window = find_launcher_window();
    if window.is_null() {
        return false;
    }
    unsafe { SendMessageW(window, QUERY_HOTKEY_MESSAGE, 0, 0) == 1 }
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn launcher_registered() -> bool {
    false
}

#[cfg(windows)]
#[allow(dead_code)]
pub fn replace_running_shortcut(value: &str) -> Result<String, String> {
    let parsed = parse_shortcut(value)?;
    let window = find_launcher_window();
    if window.is_null() {
        return Err("ホットキーランチャーが起動していません。".to_string());
    }
    let result = unsafe {
        SendMessageW(
            window,
            UPDATE_HOTKEY_MESSAGE,
            parsed.modifiers as usize,
            parsed.virtual_key as isize,
        )
    };
    match result {
        1 => {
            save_shortcut(&parsed.shortcut)?;
            Ok(parsed.shortcut)
        }
        0 => Err("指定したキーは他のアプリで使用中です。元の設定へ戻しました。".to_string()),
        _ => Err("指定したキーの登録に失敗し、元の設定も復元できませんでした。".to_string()),
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn replace_running_shortcut(_value: &str) -> Result<String, String> {
    Err("グローバルホットキーはWindows版だけで利用できます。".to_string())
}

#[cfg(windows)]
#[allow(dead_code)]
fn find_launcher_window() -> windows_sys::Win32::Foundation::HWND {
    let name = wide_string(LAUNCHER_WINDOW_NAME);
    unsafe {
        FindWindowExW(
            HWND_MESSAGE,
            std::ptr::null_mut(),
            std::ptr::null(),
            name.as_ptr(),
        )
    }
}

#[cfg(windows)]
pub fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_HOTKEY, parse_shortcut};

    #[test]
    fn parses_and_normalizes_supported_shortcuts() {
        let parsed = parse_shortcut("shift + ctrl + f12").expect("shortcut should parse");
        assert_eq!(parsed.shortcut, "Ctrl+Shift+F12");

        let default = parse_shortcut(DEFAULT_HOTKEY).expect("default should parse");
        assert_eq!(default.shortcut, DEFAULT_HOTKEY);
    }

    #[test]
    fn rejects_missing_modifier_and_multiple_keys() {
        assert!(parse_shortcut("M").is_err());
        assert!(parse_shortcut("Ctrl+M+N").is_err());
    }
}
