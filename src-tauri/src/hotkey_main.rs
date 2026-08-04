#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(windows)]
#[path = "launcher_protocol.rs"]
mod launcher_protocol;

#[cfg(windows)]
mod windows_launcher {
    use super::launcher_protocol::{
        self, HOTKEY_MESSAGE_ID, LAUNCHER_WINDOW_NAME, QUERY_HOTKEY_MESSAGE, UPDATE_HOTKEY_MESSAGE,
    };
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW, GetMessageW,
        HWND_MESSAGE, MSG, PostQuitMessage, RegisterClassW, TranslateMessage, WM_DESTROY,
        WM_HOTKEY, WNDCLASSW,
    };

    static REGISTERED: AtomicBool = AtomicBool::new(false);
    static MODIFIERS: AtomicU32 = AtomicU32::new(0);
    static VIRTUAL_KEY: AtomicU32 = AtomicU32::new(0);

    pub fn run() -> Result<(), String> {
        let window_name = launcher_protocol::wide_string(LAUNCHER_WINDOW_NAME);
        let existing = unsafe {
            FindWindowExW(
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null(),
                window_name.as_ptr(),
            )
        };
        if !existing.is_null() {
            return Ok(());
        }

        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        if instance.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let window_class = launcher_protocol::wide_string("MarkdownQuickMemoHotkeyClass");
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: window_class.as_ptr(),
            ..unsafe { std::mem::zeroed() }
        };
        if unsafe { RegisterClassW(&class) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }

        let window = unsafe {
            CreateWindowExW(
                0,
                window_class.as_ptr(),
                window_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if window.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }

        let shortcut = launcher_protocol::load_shortcut();
        let parsed = launcher_protocol::parse_shortcut(&shortcut)?;
        MODIFIERS.store(parsed.modifiers, Ordering::SeqCst);
        VIRTUAL_KEY.store(parsed.virtual_key, Ordering::SeqCst);
        if register(window, parsed.modifiers, parsed.virtual_key) {
            REGISTERED.store(true, Ordering::SeqCst);
            log_message(&format!("ホットキーを登録しました: {}", parsed.shortcut));
            start_editor(&["--background"]);
        } else {
            let error = format!(
                "{}を登録できませんでした: {}",
                parsed.shortcut,
                std::io::Error::last_os_error()
            );
            log_message(&error);
            start_editor(&["--hotkey-error", &error]);
        }

        let mut message: MSG = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
            if result <= 0 {
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_HOTKEY if wparam as i32 == HOTKEY_MESSAGE_ID => {
                start_editor(&["--hotkey-triggered"]);
                0
            }
            UPDATE_HOTKEY_MESSAGE => update_hotkey(window, wparam as u32, lparam as u32),
            QUERY_HOTKEY_MESSAGE => i64::from(REGISTERED.load(Ordering::SeqCst)) as LRESULT,
            WM_DESTROY => {
                if REGISTERED.swap(false, Ordering::SeqCst) {
                    unsafe {
                        UnregisterHotKey(window, HOTKEY_MESSAGE_ID);
                    }
                }
                unsafe {
                    PostQuitMessage(0);
                }
                0
            }
            _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
        }
    }

    fn update_hotkey(window: HWND, modifiers: u32, virtual_key: u32) -> LRESULT {
        let was_registered = REGISTERED.swap(false, Ordering::SeqCst);
        let old_modifiers = MODIFIERS.load(Ordering::SeqCst);
        let old_virtual_key = VIRTUAL_KEY.load(Ordering::SeqCst);
        if was_registered {
            unsafe {
                UnregisterHotKey(window, HOTKEY_MESSAGE_ID);
            }
        }

        if register(window, modifiers, virtual_key) {
            MODIFIERS.store(modifiers, Ordering::SeqCst);
            VIRTUAL_KEY.store(virtual_key, Ordering::SeqCst);
            REGISTERED.store(true, Ordering::SeqCst);
            log_message("ホットキー設定を変更しました。");
            return 1;
        }

        if was_registered && register(window, old_modifiers, old_virtual_key) {
            REGISTERED.store(true, Ordering::SeqCst);
            log_message("新しいキーを登録できなかったため、元の設定へ戻しました。");
            return 0;
        }
        log_message("新しいキーと元のキーの両方を登録できませんでした。");
        -1
    }

    fn register(window: HWND, modifiers: u32, virtual_key: u32) -> bool {
        unsafe {
            RegisterHotKey(
                window,
                HOTKEY_MESSAGE_ID,
                modifiers | MOD_NOREPEAT,
                virtual_key,
            ) != 0
        }
    }

    fn start_editor(arguments: &[&str]) {
        let executable = match editor_candidates().into_iter().find(|path| path.is_file()) {
            Some(path) => path,
            _ => {
                log_message("MarkdownQuickMemo.exeが配布フォルダにありません。");
                return;
            }
        };
        if let Err(error) = Command::new(executable).args(arguments).spawn() {
            log_message(&format!(
                "MarkdownQuickMemo.exeを起動できませんでした: {error}"
            ));
        }
    }

    fn editor_candidates() -> Vec<std::path::PathBuf> {
        let Some(parent) = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        else {
            return Vec::new();
        };
        let mut candidates = vec![parent.join("MarkdownQuickMemo.exe")];
        if let Some(distribution_root) = parent.parent() {
            candidates.push(
                distribution_root
                    .join("MarkdownQuickMemo")
                    .join("MarkdownQuickMemo.exe"),
            );
        }
        candidates
    }

    fn log_message(message: &str) {
        let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let directory = std::path::PathBuf::from(local_app_data)
            .join("com.markdownquickmemo.app")
            .join("logs");
        if fs::create_dir_all(&directory).is_err() {
            return;
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("hotkey-launcher.log"))
        {
            let _ = writeln!(file, "{message}");
        }
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_launcher::run() {
        eprintln!("{error}");
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("MarkdownQuickMemoHotkey is only available on Windows.");
}
