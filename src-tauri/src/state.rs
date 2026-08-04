use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::launcher_protocol;

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub background: bool,
    pub startup_file: Option<PathBuf>,
    pub hotkey_triggered: bool,
    pub hotkey_error: Option<String>,
}

impl LaunchOptions {
    pub fn from_env() -> Self {
        Self::from_arguments(std::env::args().skip(1))
    }

    fn from_arguments(arguments: impl IntoIterator<Item = String>) -> Self {
        let arguments: Vec<String> = arguments.into_iter().collect();
        let mut background = false;
        let mut startup_file = None;
        let mut hotkey_triggered = false;
        let mut hotkey_error = None;
        let mut index = 0;

        while index < arguments.len() {
            match arguments[index].as_str() {
                "--background" => background = true,
                "--hotkey-triggered" => hotkey_triggered = true,
                "--hotkey-error" => {
                    if let Some(value) = arguments.get(index + 1) {
                        hotkey_error = Some(value.clone());
                        index += 1;
                    }
                }
                value if !value.starts_with('-') && startup_file.is_none() => {
                    startup_file = Some(PathBuf::from(value));
                }
                _ => {}
            }
            index += 1;
        }

        Self {
            background,
            startup_file,
            hotkey_triggered,
            hotkey_error,
        }
    }

    pub fn startup_file_from_secondary_arguments(arguments: &[String]) -> Option<PathBuf> {
        let mut index = 1;
        while index < arguments.len() {
            match arguments[index].as_str() {
                "--hotkey-error" => index += 1,
                value if !value.starts_with('-') => return Some(PathBuf::from(value)),
                _ => {}
            }
            index += 1;
        }
        None
    }

    pub fn secondary_hotkey_triggered(arguments: &[String]) -> bool {
        arguments
            .iter()
            .any(|argument| argument == "--hotkey-triggered")
    }

    pub fn secondary_hotkey_error(arguments: &[String]) -> Option<String> {
        arguments
            .windows(2)
            .find(|pair| pair[0] == "--hotkey-error")
            .map(|pair| pair[1].clone())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub shortcut: String,
    pub registered: bool,
    pub last_triggered_at_ms: Option<u64>,
    pub error: Option<String>,
}

impl HotkeyStatus {
    pub fn initial(triggered: bool, error: Option<String>) -> Self {
        let mut status = Self {
            shortcut: launcher_protocol::load_shortcut(),
            registered: launcher_protocol::launcher_registered(),
            last_triggered_at_ms: None,
            error,
        };
        if triggered {
            status.mark_triggered();
        }
        status
    }

    pub fn refresh_registration(&mut self) {
        self.registered = launcher_protocol::launcher_registered();
        self.shortcut = launcher_protocol::load_shortcut();
        if self.registered {
            self.error = None;
        }
    }

    pub fn set_error(&mut self, error: String) {
        self.registered = false;
        self.error = Some(error);
    }

    pub fn update_shortcut(&mut self, shortcut: String) {
        self.shortcut = shortcut;
        self.registered = true;
        self.error = None;
    }

    pub fn mark_triggered(&mut self) {
        self.last_triggered_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    }
}

pub struct AppState {
    pub background: bool,
    pub startup_file: Mutex<Option<PathBuf>>,
    pub current_file: Mutex<Option<PathBuf>>,
    pub hotkey: Mutex<HotkeyStatus>,
    pub ready: AtomicBool,
    pub pending_show: AtomicBool,
    pub allow_close: AtomicBool,
}

impl AppState {
    pub fn new(options: LaunchOptions) -> Self {
        Self {
            background: options.background,
            startup_file: Mutex::new(options.startup_file),
            current_file: Mutex::new(None),
            hotkey: Mutex::new(HotkeyStatus::initial(
                options.hotkey_triggered,
                options.hotkey_error,
            )),
            ready: AtomicBool::new(false),
            pending_show: AtomicBool::new(false),
            allow_close: AtomicBool::new(false),
        }
    }

    pub fn should_show_after_ready(&self) -> bool {
        !self.background || self.pending_show.swap(false, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::LaunchOptions;
    use crate::launcher_protocol::DEFAULT_HOTKEY;
    use std::path::PathBuf;

    #[test]
    fn launch_arguments_support_background_hotkey_and_file() {
        let options = LaunchOptions::from_arguments(
            [
                "--background",
                "--hotkey-triggered",
                "--hotkey-error",
                "競合",
                "memo.md",
            ]
            .into_iter()
            .map(str::to_string),
        );

        assert!(options.background);
        assert!(options.hotkey_triggered);
        assert_eq!(options.hotkey_error.as_deref(), Some("競合"));
        assert_eq!(options.startup_file, Some(PathBuf::from("memo.md")));
    }

    #[test]
    fn default_launch_is_visible_with_default_hotkey() {
        let options = LaunchOptions::from_arguments(std::iter::empty());

        assert!(!options.background);
        assert!(!options.hotkey_triggered);
        assert_eq!(options.hotkey_error, None);
        assert_eq!(options.startup_file, None);
        assert_eq!(DEFAULT_HOTKEY, "Ctrl+Alt+M");
    }

    #[test]
    fn secondary_instance_extracts_file_without_hotkey_value() {
        let arguments = vec![
            "MarkdownQuickMemo.exe".to_string(),
            "--hotkey-error".to_string(),
            "競合".to_string(),
            "notes\\memo.md".to_string(),
        ];

        assert_eq!(
            LaunchOptions::startup_file_from_secondary_arguments(&arguments),
            Some(PathBuf::from("notes\\memo.md"))
        );
    }

    #[test]
    fn secondary_instance_reports_hotkey_events() {
        let arguments = vec![
            "MarkdownQuickMemo.exe".to_string(),
            "--hotkey-triggered".to_string(),
            "--hotkey-error".to_string(),
            "競合".to_string(),
        ];

        assert!(LaunchOptions::secondary_hotkey_triggered(&arguments));
        assert_eq!(
            LaunchOptions::secondary_hotkey_error(&arguments).as_deref(),
            Some("競合")
        );
    }
}
