"""Tests for check-bus-imports.py. Run: python3 scripts/test_check_bus_imports.py"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check", HERE / "check-bus-imports.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class BusImports(unittest.TestCase):
    def run_on(self, files):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for rel, text in files.items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text)
            return check.run(root)[0]

    def test_every_import_form_is_caught(self):
        problems = self.run_on({
            "miniapps/x/a.ts": 'import {open} from "@eclipse-zenoh/zenoh-ts"\n',
            "miniapps/x/b.ts": 'const z = await import("@eclipse-zenoh/zenoh-ts")\n',
            "mobile/modules/y/C.kt": "import io.zenoh.Session\n",
            "miniapps/x/d.py": "import zenoh\n",
            "mobile/src/e.swift": "import Zenoh\n",
        })
        self.assertEqual(len(problems), 5)

    def test_the_adapter_may_import_it(self):
        self.assertEqual(self.run_on({"miniapps/x/zenoh-adapter.ts": 'import {open} from "@eclipse-zenoh/zenoh-ts"\n',
                                      "mobile/modules/y/ZenohAdapter.kt": "import io.zenoh.Session\n"}), [])

    def test_a_comment_mentioning_zenoh_is_not_an_import(self):
        self.assertEqual(self.run_on({"miniapps/x/ok.ts": " * the only file allowed to\n * import Zenoh (see check)\n"}), [])

    def test_node_modules_are_not_ours(self):
        self.assertEqual(self.run_on({"miniapps/x/node_modules/z/i.js": 'import "zenoh"\n'}), [])


if __name__ == "__main__":
    unittest.main()
