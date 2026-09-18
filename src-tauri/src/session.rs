use crate::document::replace_file;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::Builder;

const SESSION_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub path: String,
    pub preview: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowSession {
    pub tabs: Vec<SessionTab>,
    pub active_tab: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub version: u32,
    pub windows: Vec<WindowSession>,
    pub active_window: usize,
}

impl PersistedSession {
    pub fn from_exit(
        window_order: &[String],
        snapshots: &HashMap<String, WindowSession>,
        active_label: &str,
    ) -> Self {
        let mut windows = Vec::new();
        let mut active_window = 0;
        for label in window_order {
            let Some(snapshot) = snapshots.get(label) else {
                continue;
            };
            if snapshot.tabs.is_empty() {
                continue;
            }
            if label == active_label {
                active_window = windows.len();
            }
            let mut snapshot = snapshot.clone();
            snapshot.active_tab = snapshot.active_tab.min(snapshot.tabs.len() - 1);
            windows.push(snapshot);
        }
        Self {
            version: SESSION_VERSION,
            windows,
            active_window,
        }
    }

    pub fn assigned_windows(&self) -> (HashMap<String, WindowSession>, String) {
        let mut assigned = HashMap::new();
        for (index, window) in self.windows.iter().enumerate() {
            let label = if index == 0 {
                "main".to_string()
            } else {
                format!("restored-{index}")
            };
            assigned.insert(label, window.clone());
        }
        let active_window = if self.windows.is_empty() {
            "main".to_string()
        } else if self.active_window == 0 {
            "main".to_string()
        } else {
            format!(
                "restored-{}",
                self.active_window.min(self.windows.len() - 1)
            )
        };
        (assigned, active_window)
    }
}

pub fn load_session() -> Result<Option<PersistedSession>, String> {
    load_session_from(&session_path())
}

fn load_session_from(path: &Path) -> Result<Option<PersistedSession>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let session: PersistedSession =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if session.version != SESSION_VERSION {
        return Ok(None);
    }
    Ok(Some(session))
}

pub fn save_session(session: &PersistedSession) -> Result<(), String> {
    save_session_to(&session_path(), session)
}

fn save_session_to(path: &Path, session: &PersistedSession) -> Result<(), String> {
    let parent = path.parent().ok_or("セッション保存先が不正です。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary = Builder::new()
        .prefix(".session.")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, session).map_err(|error| error.to_string())?;
    temporary
        .write_all(b"\n")
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let temporary_path = temporary.into_temp_path();
    replace_file(&temporary_path, path).map_err(|error| error.to_string())?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .or_else(|error| if cfg!(windows) { Ok(()) } else { Err(error) })
        .map_err(|error| error.to_string())
}

fn session_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.markdownquickmemo.app")
        .join("session.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(path: &str, active_tab: usize) -> WindowSession {
        WindowSession {
            tabs: vec![SessionTab {
                path: path.into(),
                preview: false,
            }],
            active_tab,
        }
    }

    #[test]
    fn round_trips_a_versioned_session_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        let session = PersistedSession {
            version: SESSION_VERSION,
            windows: vec![window("C:\\memo.md", 9)],
            active_window: 0,
        };

        save_session_to(&path, &session).unwrap();

        assert_eq!(load_session_from(&path).unwrap(), Some(session));
    }

    #[test]
    fn ignores_unknown_versions_and_reports_invalid_json() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        fs::write(&path, r#"{"version":99,"windows":[],"activeWindow":0}"#).unwrap();
        assert_eq!(load_session_from(&path).unwrap(), None);

        fs::write(&path, "not json").unwrap();
        assert!(load_session_from(&path).is_err());
    }

    #[test]
    fn exit_snapshot_omits_empty_windows_and_preserves_the_active_window() {
        let order = vec!["main".into(), "memo-1".into(), "memo-2".into()];
        let snapshots = HashMap::from([
            (
                "main".into(),
                WindowSession {
                    tabs: vec![],
                    active_tab: 0,
                },
            ),
            ("memo-1".into(), window("C:\\one.md", 4)),
            ("memo-2".into(), window("C:\\two.md", 0)),
        ]);

        let session = PersistedSession::from_exit(&order, &snapshots, "memo-2");

        assert_eq!(session.windows.len(), 2);
        assert_eq!(session.windows[0].active_tab, 0);
        assert_eq!(session.active_window, 1);
        let (assigned, active) = session.assigned_windows();
        assert_eq!(assigned["main"].tabs[0].path, "C:\\one.md");
        assert_eq!(assigned["restored-1"].tabs[0].path, "C:\\two.md");
        assert_eq!(active, "restored-1");
    }
}
