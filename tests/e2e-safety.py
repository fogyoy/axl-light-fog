"""验证实机测试入口的失败行为，宿主 CLI 在这些故障用例中由边界替身代替。"""
import contextlib
import base64
import io
import json
import pathlib
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).with_name('obsidian-e2e.py')


def cli_response(value):
    return '=> ' + base64.b64encode(json.dumps(value, ensure_ascii=False).encode('utf-8')).decode('ascii')


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fog-e2e-safety-')
        self.root = pathlib.Path(self.temporary.name)
        (self.root / 'tests').mkdir()
        self.script = self.root / 'tests/obsidian-e2e.py'
        shutil.copyfile(SOURCE, self.script)
        self.vault = self.root / 'test-vault'
        (self.vault / '.obsidian/plugins/axl-light-fog').mkdir(parents=True)
        for name in ('main.js', 'manifest.json', 'styles.css', 'LICENSE'):
            content = json.dumps({'id': 'axl-light-fog', 'version': '0.4.0'}) if name == 'manifest.json' else 'synthetic'
            (self.root / name).write_text(content)
            (self.vault / '.obsidian/plugins/axl-light-fog' / name).write_text(content)
        self.receipt = self.root / '.local/evidence/obsidian.json'

    def tearDown(self):
        self.temporary.cleanup()

    def marker(self):
        (self.vault / '.axl-test-vault.json').write_text(json.dumps({'purpose': 'axl-light-fog-e2e'}))

    def execute(self, host):
        with patch.object(sys, 'argv', [str(self.script), '--vault-path', str(self.vault)]), patch('subprocess.check_output', side_effect=host), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(self.script), run_name='__main__')

    def test_unmarked_vault_stops_before_cli(self):
        calls = []
        with self.assertRaises(SystemExit):
            self.execute(lambda *args, **kwargs: calls.append(args))
        self.assertEqual(calls, [])

    def test_wrong_cli_target_stops_before_fixture_writes(self):
        self.marker()
        def host(args, **kwargs):
            self.assertEqual(args[0], 'obsidian')
            self.assertEqual(args[1], 'vault=' + self.vault.name)
            self.assertTrue(args[3].isascii(), 'CLI 代码必须通过 ASCII 传输')
            return cli_response(str(self.root / 'different-vault'))
        with self.assertRaises(SystemExit):
            self.execute(host)
        self.assertEqual(list(self.vault.glob('_AXL*')), [])
        self.assertFalse(self.receipt.exists())

    def test_failed_test_and_failed_diagnostics_never_pass(self):
        self.marker()
        self.receipt.parent.mkdir(parents=True)
        self.receipt.write_text(json.dumps({'status': 'passed'}))
        def host(args, **kwargs):
            if args[0] == 'git':
                return 'f' * 40
            code = next(value[5:] for value in args if value.startswith('code='))
            self.assertTrue(code.isascii(), '长中文代码不能直接通过 CLI 文本分块传输')
            if 'getBasePath' in code:
                return cli_response(str(self.vault))
            if 'const original=' in code:
                return cli_response({})
            if 'p.store.writes' in code:
                return cli_response({'filesRemoved': True})
            return 'Error: synthetic host failure'
        with self.assertRaises(RuntimeError):
            self.execute(host)
        self.assertFalse(self.receipt.exists(), '主测试和诊断失败后不得签发通过凭证')


if __name__ == '__main__':
    unittest.main()
