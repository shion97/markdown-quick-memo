use std::path::{Path, PathBuf};
use std::process::Command;
use url::Url;

fn find_chrome(candidates: impl IntoIterator<Item = PathBuf>) -> Result<PathBuf, String> {
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Google Chromeが見つかりません。".to_string())
}

fn chrome_command(chrome: &Path, target: &str) -> Result<Command, String> {
    if target.chars().any(char::is_control) {
        return Err("URLが不正です。".to_string());
    }
    let parsed = Url::parse(target).map_err(|_| "URLが不正です。".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("許可されていないURLスキームです。".to_string());
    }
    let mut command = Command::new(chrome);
    command.arg(parsed.as_str());
    Ok(command)
}

pub fn open_in_chrome(target: &str) -> Result<(), String> {
    let candidates = [
        "LOCALAPPDATA",
        "ProgramW6432",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
    ]
    .into_iter()
    .filter_map(std::env::var_os)
    .map(|root| PathBuf::from(root).join("Google/Chrome/Application/chrome.exe"));
    let chrome = find_chrome(candidates)?;
    chrome_command(&chrome, target)?
        .spawn()
        .map_err(|error| format!("Google ChromeでURLを開けませんでした: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn chrome_receives_url_as_one_argument() {
        let command = chrome_command(
            Path::new("C:/Program Files/Google/Chrome/Application/chrome.exe"),
            "https://example.com/path?q=a&other=b#fragment",
        )
        .expect("valid URL");
        assert_eq!(
            command.get_program(),
            OsStr::new("C:/Program Files/Google/Chrome/Application/chrome.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new("https://example.com/path?q=a&other=b#fragment")]
        );
    }

    #[test]
    fn rejects_non_web_schemes_and_invalid_urls() {
        for target in [
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/html,test",
            "--incognito",
            "https://example.com/\0",
        ] {
            assert!(
                chrome_command(Path::new("chrome.exe"), target).is_err(),
                "{target:?}"
            );
        }
        assert!(chrome_command(Path::new("chrome.exe"), "mailto:user@example.com").is_ok());
    }

    #[test]
    fn finds_existing_chrome_and_reports_missing_installation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let missing = directory.path().join("missing.exe");
        let chrome = directory.path().join("chrome.exe");
        assert!(find_chrome([missing.clone()]).is_err());
        std::fs::write(&chrome, b"").expect("Chrome fixture");
        assert_eq!(
            find_chrome([missing, chrome.clone()]).expect("installed Chrome"),
            chrome
        );
    }
}
