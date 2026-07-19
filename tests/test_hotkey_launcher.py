import unittest

from markdown_quick_memo.hotkey_launcher import (
    MOD_ALT,
    MOD_CONTROL,
    MOD_SHIFT,
    is_app_window_title,
    parse_hotkey,
)


class HotkeyLauncherTests(unittest.TestCase):
    def test_parse_default_hotkey(self) -> None:
        hotkey = parse_hotkey("CTRL+ALT+M")

        self.assertEqual(hotkey.modifiers, MOD_CONTROL | MOD_ALT)
        self.assertEqual(hotkey.virtual_key, ord("M"))
        self.assertEqual(hotkey.label, "CTRL+ALT+M")

    def test_parse_function_key_and_aliases(self) -> None:
        hotkey = parse_hotkey("control+shift+f12")

        self.assertEqual(hotkey.modifiers, MOD_CONTROL | MOD_SHIFT)
        self.assertEqual(hotkey.virtual_key, 0x7B)
        self.assertEqual(hotkey.label, "CTRL+SHIFT+F12")

    def test_parse_rejects_invalid_hotkeys(self) -> None:
        for value in ("M", "CTRL+ALT", "CTRL+ALT+M+N", "CTRL+ALT+SPACE"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    parse_hotkey(value)

    def test_app_window_title_detection(self) -> None:
        self.assertTrue(is_app_window_title("Markdown Quick Memo"))
        self.assertTrue(is_app_window_title("無題.md — Markdown Quick Memo"))
        self.assertFalse(is_app_window_title("image.png"))


if __name__ == "__main__":
    unittest.main()
