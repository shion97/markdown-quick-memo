use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tempfile::Builder;

pub fn ensure_markdown_suffix(path: &Path) -> PathBuf {
    if path.extension().is_none() {
        path.with_extension("md")
    } else {
        path.to_path_buf()
    }
}

pub fn read_markdown(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    let content = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(bytes.as_slice());
    String::from_utf8(content.to_vec())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn write_markdown(path: &Path, content: &str) -> io::Result<PathBuf> {
    let destination = ensure_markdown_suffix(path);
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let mut temporary = Builder::new()
        .prefix(&format!(
            ".{}.",
            destination
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("markdown")
        ))
        .suffix(".tmp")
        .tempfile_in(parent)?;
    temporary.write_all(content.as_bytes())?;
    temporary.as_file().sync_all()?;
    let temporary_path = temporary.into_temp_path();
    replace_file(&temporary_path, &destination)?;
    sync_parent(parent)?;
    Ok(destination)
}

fn sync_parent(parent: &Path) -> io::Result<()> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .or_else(|error| if cfg!(windows) { Ok(()) } else { Err(error) })
}

#[cfg(windows)]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    let result = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::{ensure_markdown_suffix, read_markdown, write_markdown};
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn suffix_is_added_only_when_missing() {
        assert_eq!(
            ensure_markdown_suffix(Path::new("memo")),
            Path::new("memo.md")
        );
        assert_eq!(
            ensure_markdown_suffix(Path::new("memo.txt")),
            Path::new("memo.txt")
        );
    }

    #[test]
    fn bom_is_accepted_and_save_has_no_bom() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("bom.md");
        fs::write(&source, b"\xEF\xBB\xBFhello").expect("write fixture");
        assert_eq!(read_markdown(&source).expect("read markdown"), "hello");

        let destination = write_markdown(&source, "updated").expect("save markdown");
        assert_eq!(fs::read(destination).expect("read saved bytes"), b"updated");
    }

    #[test]
    fn failed_replacement_keeps_existing_content() {
        let directory = tempdir().expect("temporary directory");
        let destination = directory.path().join("memo.md");
        write_markdown(&destination, "original").expect("initial save");
        let mut permissions = fs::metadata(&destination)
            .expect("saved metadata")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&destination, permissions).expect("make read-only");
        assert!(write_markdown(&destination, "replacement").is_err());
        assert_eq!(
            read_markdown(&destination).expect("read markdown"),
            "original"
        );
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_ATTRIBUTE_NORMAL, SetFileAttributesW,
            };

            let destination_wide: Vec<u16> = destination
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            assert_ne!(
                unsafe { SetFileAttributesW(destination_wide.as_ptr(), FILE_ATTRIBUTE_NORMAL) },
                0,
                "restore permissions"
            );
        }
        #[cfg(not(windows))]
        {
            let mut permissions = fs::metadata(&destination)
                .expect("saved metadata")
                .permissions();
            permissions.set_readonly(false);
            fs::set_permissions(destination, permissions).expect("restore permissions");
        }
    }

    #[test]
    fn existing_markdown_corpus_round_trips_without_serialization() {
        let directory = tempdir().expect("temporary directory");
        let destination = directory.path().join("corpus.md");
        let corpus = include_str!("../../tests/fixtures/pdf_all_features.md");

        write_markdown(&destination, corpus).expect("save corpus");

        assert_eq!(read_markdown(&destination).expect("read corpus"), corpus);
    }
}
