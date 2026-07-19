import importlib
import sys
import unittest

import markdown_quick_memo


class PackageTests(unittest.TestCase):
    def test_gui_module_is_loaded_lazily(self) -> None:
        sys.modules.pop("markdown_quick_memo.app", None)

        importlib.reload(markdown_quick_memo)

        self.assertNotIn("markdown_quick_memo.app", sys.modules)


if __name__ == "__main__":
    unittest.main()
