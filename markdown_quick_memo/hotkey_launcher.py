"""WindowsのネイティブAPIを使った軽量ホットキーランチャー。"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
import sys
import time


APP_NAME = "Markdown Quick Memo"
DEFAULT_HOTKEY = "CTRL+ALT+M"
HOTKEY_ID = 1
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
SW_RESTORE = 9
SW_SHOW = 5
ERROR_ALREADY_EXISTS = 183
MUTEX_NAME = r"Local\MarkdownQuickMemoHotkeyLauncher"
LAUNCH_THROTTLE_SECONDS = 0.75
PRELOAD_WINDOW_WAIT_SECONDS = 2.0
PRELOAD_WINDOW_POLL_SECONDS = 0.02


@dataclass(frozen=True)
class Hotkey:
    modifiers: int
    virtual_key: int
    label: str


@dataclass(frozen=True)
class LaunchCommand:
    arguments: tuple[str, ...]
    working_directory: Path


def parse_hotkey(value: str) -> Hotkey:
    """`CTRL+ALT+M`形式をRegisterHotKey用の値へ変換する。"""

    tokens = [token.strip().upper() for token in value.split("+") if token.strip()]
    modifier_values = {
        "ALT": MOD_ALT,
        "CTRL": MOD_CONTROL,
        "CONTROL": MOD_CONTROL,
        "SHIFT": MOD_SHIFT,
        "WIN": MOD_WIN,
        "WINDOWS": MOD_WIN,
    }
    modifier_labels = {
        "CTRL": "CTRL",
        "CONTROL": "CTRL",
        "ALT": "ALT",
        "SHIFT": "SHIFT",
        "WIN": "WIN",
        "WINDOWS": "WIN",
    }

    modifiers = 0
    labels: list[str] = []
    key_tokens: list[str] = []
    for token in tokens:
        if token in modifier_values:
            modifiers |= modifier_values[token]
            label = modifier_labels[token]
            if label not in labels:
                labels.append(label)
        else:
            key_tokens.append(token)

    if modifiers == 0:
        raise ValueError("ホットキーにはCTRL、ALT、SHIFT、WINのいずれかが必要です。")
    if len(key_tokens) != 1:
        raise ValueError("ホットキーの通常キーは1つだけ指定してください。")

    key = key_tokens[0]
    if len(key) == 1 and key.isascii() and key.isalnum():
        virtual_key = ord(key)
    elif key.startswith("F") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        virtual_key = 0x70 + int(key[1:]) - 1
    else:
        raise ValueError("通常キーには英数字またはF1～F24を指定してください。")

    return Hotkey(modifiers, virtual_key, "+".join([*labels, key]))


def is_app_window_title(title: str) -> bool:
    return title == APP_NAME or title.endswith(f"— {APP_NAME}")


def resolve_launch_command(*, background: bool = False) -> LaunchCommand:
    background_arguments = ("--background",) if background else ()
    if getattr(sys, "frozen", False):
        launcher_directory = Path(sys.executable).resolve().parent
        project_root = launcher_directory.parent.parent
        executable = launcher_directory.parent / "MarkdownQuickMemo" / "MarkdownQuickMemo.exe"
        return LaunchCommand((str(executable), *background_arguments), project_root)

    project_root = Path(__file__).resolve().parent.parent
    executable = project_root / "dist" / "MarkdownQuickMemo" / "MarkdownQuickMemo.exe"
    if executable.exists():
        return LaunchCommand((str(executable), *background_arguments), project_root)

    python = Path(sys.executable)
    pythonw = python.with_name("pythonw.exe")
    interpreter = pythonw if pythonw.exists() else python
    return LaunchCommand(
        (str(interpreter), "-m", "markdown_quick_memo", *background_arguments),
        project_root,
    )


class WindowsHotkeyLauncher:
    def __init__(self, hotkey: Hotkey) -> None:
        self.hotkey = hotkey
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._configure_api()
        self._mutex_handle: int | None = None
        self._last_launch_at = 0.0
        self._preloaded_process: subprocess.Popen[bytes] | None = None

    def _configure_api(self) -> None:
        self._enum_windows_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        self.user32.RegisterHotKey.restype = wintypes.BOOL
        self.user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user32.UnregisterHotKey.restype = wintypes.BOOL
        self.user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        self.user32.GetMessageW.restype = wintypes.BOOL
        self.user32.IsWindowVisible.argtypes = [wintypes.HWND]
        self.user32.IsWindowVisible.restype = wintypes.BOOL
        self.user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        self.user32.GetWindowTextLengthW.restype = ctypes.c_int
        self.user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user32.GetWindowTextW.restype = ctypes.c_int
        self.user32.IsIconic.argtypes = [wintypes.HWND]
        self.user32.IsIconic.restype = wintypes.BOOL
        self.user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user32.ShowWindow.restype = wintypes.BOOL
        self.user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        self.user32.SetForegroundWindow.restype = wintypes.BOOL
        self.user32.EnumWindows.argtypes = [self._enum_windows_callback, wintypes.LPARAM]
        self.user32.EnumWindows.restype = wintypes.BOOL
        self.user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
        self.user32.MessageBoxW.restype = ctypes.c_int
        self.kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel32.CreateMutexW.restype = wintypes.HANDLE
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL

    def run(self) -> int:
        ctypes.set_last_error(0)
        self._mutex_handle = self.kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if not self._mutex_handle:
            self._show_error("ホットキーランチャーの多重起動確認に失敗しました。")
            return 1
        if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
            self.kernel32.CloseHandle(self._mutex_handle)
            return 0

        registered = self.user32.RegisterHotKey(
            None,
            HOTKEY_ID,
            self.hotkey.modifiers | MOD_NOREPEAT,
            self.hotkey.virtual_key,
        )
        if not registered:
            self._show_error(
                f"{self.hotkey.label} を登録できませんでした。ほかのアプリとの重複を確認してください。"
            )
            self.kernel32.CloseHandle(self._mutex_handle)
            return 1

        try:
            self._preload_app()
            message = wintypes.MSG()
            while True:
                result = self.user32.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result == -1:
                    return 1
                if result == 0:
                    return 0
                if message.message == WM_HOTKEY and message.wParam == HOTKEY_ID:
                    self._handle_hotkey()
        finally:
            self.user32.UnregisterHotKey(None, HOTKEY_ID)
            if self._mutex_handle:
                self.kernel32.CloseHandle(self._mutex_handle)

    def _handle_hotkey(self) -> None:
        now = time.monotonic()
        if now - self._last_launch_at < LAUNCH_THROTTLE_SECONDS:
            return
        self._last_launch_at = now

        window = self._find_app_window()
        if window:
            self._activate_window(window)
            return

        if self._preloaded_process is not None and self._preloaded_process.poll() is None:
            window = self._wait_for_app_window()
            if window:
                self._activate_window(window)
                return

        self._preloaded_process = self._launch_app()
        if self._preloaded_process is None:
            return
        window = self._wait_for_app_window()
        if window:
            self._activate_window(window)

    def _preload_app(self) -> None:
        if self._find_app_window():
            return
        self._preloaded_process = self._launch_app()

    def _launch_app(self) -> subprocess.Popen[bytes] | None:
        command = resolve_launch_command(background=True)
        executable = Path(command.arguments[0])
        if not executable.exists():
            self._show_error(f"起動先が見つかりません。\n{executable}")
            return None

        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
        try:
            return subprocess.Popen(
                command.arguments,
                cwd=command.working_directory,
                close_fds=True,
                creationflags=creation_flags,
            )
        except OSError as error:
            self._show_error(f"アプリを起動できませんでした。\n{error}")
            return None

    def _wait_for_app_window(self) -> int | None:
        deadline = time.monotonic() + PRELOAD_WINDOW_WAIT_SECONDS
        while time.monotonic() < deadline:
            window = self._find_app_window()
            if window:
                return window
            if self._preloaded_process is not None and self._preloaded_process.poll() is not None:
                return None
            time.sleep(PRELOAD_WINDOW_POLL_SECONDS)
        return None

    def _activate_window(self, window: int) -> None:
        if not self.user32.IsWindowVisible(window):
            self.user32.ShowWindow(window, SW_SHOW)
        elif self.user32.IsIconic(window):
            self.user32.ShowWindow(window, SW_RESTORE)
        self.user32.SetForegroundWindow(window)

    def _find_app_window(self) -> int | None:
        found_window: int | None = None

        def visit_window(window: int, _parameter: int) -> bool:
            nonlocal found_window
            title_length = self.user32.GetWindowTextLengthW(window)
            if title_length == 0:
                return True
            title_buffer = ctypes.create_unicode_buffer(title_length + 1)
            self.user32.GetWindowTextW(window, title_buffer, len(title_buffer))
            if is_app_window_title(title_buffer.value):
                found_window = window
                return False
            return True

        callback = self._enum_windows_callback(visit_window)
        self.user32.EnumWindows(callback, 0)
        return found_window

    def _show_error(self, message: str) -> None:
        self.user32.MessageBoxW(None, message, f"{APP_NAME} Hotkey", 0x10)


def parse_args(arguments: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Markdown Quick Memoのグローバルホットキーランチャー")
    parser.add_argument("--hotkey", default=DEFAULT_HOTKEY, help="例: CTRL+ALT+M")
    return parser.parse_args(arguments)


def main() -> None:
    args = parse_args()
    if os.name != "nt":
        raise SystemExit("このランチャーはWindows専用です。")
    try:
        hotkey = parse_hotkey(args.hotkey)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    raise SystemExit(WindowsHotkeyLauncher(hotkey).run())


if __name__ == "__main__":
    main()
