"""Build the bundled offline neural voice pack from verified upstream assets."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'Receiver/Assets/Voice/Tts'
MODEL_SHA256 = 'bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d'
UPSTREAM = 'a0d5c6a264c0ef92d70d8661d8cc502d79627cd6'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(source, archive):
    TARGET.mkdir(parents=True, exist_ok=True)
    if digest(source / 'model.onnx') != MODEL_SHA256:
        raise ValueError('Melo model differs from the pinned upstream LFS object')
    names = ['model.onnx', 'tokens.txt', 'lexicon.txt', 'date.fst', 'number.fst',
             'phone.fst', 'new_heteronym.fst', 'LICENSE']
    files = []
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for name in sorted(names):
            path = source / name
            output.write(path, name)
            files.append({'name': name, 'size': path.stat().st_size, 'sha256': digest(path)})
    parts = []
    with archive.open('rb') as source:
        for index in range(10):
            chunk = source.read(64 * 1024 * 1024)
            if not chunk:
                break
            path = TARGET / f'voice-{index + 1:02d}.pack'
            path.write_bytes(chunk)
            parts.append({'name': path.name, 'size': len(chunk), 'sha256': digest(path)})
    for stale in TARGET.glob('voice-*.pack'):
        if stale.name not in {part['name'] for part in parts}:
            stale.unlink()
    manifest = {'version': 'melo-zh-en-20261025', 'engine': 'MeloTTS Chinese-English VITS fp32',
                'source': f'https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/tree/{UPSTREAM}',
                'license': 'MIT', 'speaker': 0, 'archiveSha256': digest(archive),
                'parts': parts, 'files': files}
    (TARGET / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    shutil.copyfile(source / 'LICENSE', ROOT / 'docs/licenses/MeloTTS-LICENSE.txt')
    vad = ROOT / 'Receiver/Assets/Voice/Vad'
    vad.mkdir(parents=True, exist_ok=True)
    model = vad / 'silero_vad_v5.onnx'
    if not model.exists():
        urllib.request.urlretrieve('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx', model)
    (vad / 'manifest.json').write_text(json.dumps({'license': 'MIT', 'files': [
        {'name': model.name, 'sha256': digest(model)}]}, indent=2) + '\n', encoding='utf-8')
    vad_license = ROOT / 'docs/licenses/SileroVAD-LICENSE.txt'
    if not vad_license.exists():
        urllib.request.urlretrieve('https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE', vad_license)
    print(json.dumps({'voiceArchiveMiB': round(archive.stat().st_size / 1048576, 2),
                      'voiceFilesMiB': round(sum(f['size'] for f in files) / 1048576, 2),
                      'parts': len(parts), 'vadBytes': model.stat().st_size}))


def main():
    manifest_path = TARGET / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        vad = ROOT / 'Receiver/Assets/Voice/Vad/silero_vad_v5.onnx'
        if (manifest.get('version') == 'melo-zh-en-20261025'
                and manifest.get('parts')
                and all((TARGET / part['name']).is_file()
                        and digest(TARGET / part['name']) == part['sha256']
                        for part in manifest['parts'])
                and vad.is_file()
                and digest(vad) == '6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396'
                and (ROOT / 'docs/licenses/MeloTTS-LICENSE.txt').is_file()
                and (ROOT / 'docs/licenses/SileroVAD-LICENSE.txt').is_file()):
            print(json.dumps({'prepared': True, 'reusedVerifiedPacks': True,
                              'persistentDownloadCache': False}))
            return
    # Raw upstream files and the intermediate archive live only for this run.
    with tempfile.TemporaryDirectory(prefix='iceclass-neural-pack-') as temporary:
        source = Path(temporary)
        for name in ('model.onnx', 'tokens.txt', 'lexicon.txt', 'date.fst',
                     'number.fst', 'phone.fst', 'new_heteronym.fst', 'LICENSE'):
            url = f'https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/resolve/{UPSTREAM}/{name}'
            with urllib.request.urlopen(url, timeout=90) as response, (source / name).open('wb') as target:
                shutil.copyfileobj(response, target, length=1024 * 1024)
        prepare(source, source / 'banban-melo.zip')


if __name__ == '__main__':
    main()
