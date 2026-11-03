import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class ClientArchiveTests(unittest.TestCase):
    def test_lightweight_and_offline_contents_match_their_promises(self):
        spec = importlib.util.spec_from_file_location('client_archives', ROOT / 'scripts/create-client-archives.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receiver = root / 'receiver_release'
            teacher = root / 'desktop_release'
            receiver.mkdir(); teacher.mkdir()
            files = []
            for name, content in [('ICeClass.exe', b'MZ core'), ('VoiceResources/Asr/model.int8.onnx', b'model'), ('VoiceResources/Asr/tokens.txt', b'tokens')]:
                digest = hashlib.sha256(content).hexdigest()
                target = receiver / 'payloads' / digest
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(content)
                files.append({'path': name, 'size': len(content), 'sha256': digest, 'deltas': []})
            (receiver / 'update-plan.json').write_text(json.dumps({'version': '2.5.5', 'files': files}))
            for folder, name, content in [(receiver, 'ICeClass.exe', b'MZ full with voice'), (teacher, 'ICeClass.Desktop.exe', b'MZ teacher')]:
                (folder / name).write_bytes(content)
                (folder / 'manifest.json').write_text(json.dumps({'version': '2.5.5', 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}))
                for script in ['install.ps1', '安装或升级.cmd', '安装到本机.cmd', 'install-voice-resources.ps1']:
                    (folder / script).write_text('fixture installer')
            output = root / 'downloads'
            module.create_archives(root, output)
            with zipfile.ZipFile(output / 'ICeClass-classroom.zip') as archive:
                prefix = 'ICeClass/教室端/'
                self.assertEqual(archive.read(prefix + 'ICeClass.exe'), b'MZ core')
                metadata = json.loads(archive.read(prefix + 'program-manifest.json'))
                self.assertEqual(metadata['sha256'], files[0]['sha256'])
                self.assertNotIn('config.json', archive.namelist())
            with zipfile.ZipFile(output / 'ICeClass-classroom-offline.zip') as archive:
                self.assertEqual(archive.read(prefix + 'ICeClass.exe'), b'MZ full with voice')
            with zipfile.ZipFile(output / 'ICeClass-teacher.zip') as archive:
                self.assertFalse(any('model.int8.onnx' in name for name in archive.namelist()))
                self.assertIn('Windows教师端/install-voice-resources.ps1', archive.namelist())
            with zipfile.ZipFile(output / 'ICeClass-teacher-offline.zip') as archive:
                self.assertEqual(archive.read('Windows教师端/VoiceResources/Asr/model.int8.onnx'), b'model')
                metadata = json.loads(archive.read('Windows教师端/voice-resources.json'))
                self.assertEqual([f['path'] for f in metadata['files']], [f['path'] for f in files[1:]])
            (receiver / 'payloads' / files[1]['sha256']).write_bytes(b'wrong')
            with self.assertRaises(ValueError):
                module.create_archives(root, root / 'invalid-downloads')


if __name__ == '__main__':
    unittest.main()
