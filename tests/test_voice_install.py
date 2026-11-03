"""Exercise the offline teacher model installer against real files without changing user settings."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class VoiceInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='iceclass-voice-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / 'offline package'
        self.target = self.root / 'installed client'
        self.target.mkdir()
        (self.target / 'config.json').write_text('keep settings')
        self.files = []
        for name, content in [('model.int8.onnx', b'verified offline model'), ('tokens.txt', b'verified tokens')]:
            path = 'VoiceResources/Asr/' + name
            source = self.package / path
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(content)
            self.files.append({'path': path, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()})

    def run_installer(self, files=None, validate=False):
        (self.package / 'voice-resources.json').write_text(json.dumps({'files': self.files if files is None else files}), encoding='utf-8')
        def quote(value):
            return "'" + str(value).replace("'", "''") + "'"
        command = '. ' + quote(ROOT / 'scripts/install-voice-resources.ps1') + '; Install-VoiceResources -PackageDirectory ' + quote(self.package)
        command += ' -InstallDirectory ' + quote(self.target) + (' -ValidateOnly' if validate else '')
        # A Windows PowerShell child must load its own built-in modules, not inherited PowerShell 7 modules.
        environment = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
        return subprocess.run(['powershell.exe', '-NoProfile', '-Command', "$ErrorActionPreference='Stop'; " + command], capture_output=True, env=environment)

    def test_offline_install_copies_verified_models_without_touching_settings(self):
        result = self.run_installer(validate=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.target / self.files[0]['path']).exists())
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        for entry in self.files:
            self.assertEqual((self.target / entry['path']).read_bytes(), (self.package / entry['path']).read_bytes())
        self.assertEqual((self.target / 'config.json').read_text(), 'keep settings')

    def test_corrupt_later_file_prevents_every_model_replacement(self):
        (self.package / self.files[1]['path']).write_bytes(b'wrong')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target / self.files[0]['path']).exists())

    def test_unsafe_and_duplicate_targets_are_rejected(self):
        for name in ['../config.json', 'VoiceResources/Asr/../config.json', 'VoiceResources/Asr/model:stream', 'ICeClass.Desktop.exe']:
            with self.subTest(name=name):
                entries = [dict(self.files[0], path=name), self.files[1]]
                self.assertNotEqual(self.run_installer(entries).returncode, 0)
        self.assertNotEqual(self.run_installer([self.files[0], self.files[0]]).returncode, 0)
        self.assertEqual((self.target / 'config.json').read_text(), 'keep settings')


if __name__ == '__main__':
    unittest.main()
