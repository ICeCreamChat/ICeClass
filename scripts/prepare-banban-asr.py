"""Prepare the pinned SenseVoiceSmall INT8 assets without a duplicate model cache."""
from pathlib import Path
import hashlib
import json
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'Receiver/Assets/Voice/Asr'
REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07'
REPOSITORY = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
FILES = {
    'model.int8.onnx': 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    'tokens.txt': 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    entries = []
    for name, expected in FILES.items():
        path = TARGET / name
        if not path.exists() or digest(path) != expected:
            temporary = path.with_suffix(path.suffix + '.download')
            url = f'https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}'
            try:
                with urllib.request.urlopen(url, timeout=90) as response, temporary.open('wb') as target:
                    shutil.copyfileobj(response, target, length=1024 * 1024)
                if digest(temporary) != expected:
                    raise ValueError(f'ASR upstream SHA-256 mismatch: {name}')
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        entries.append({'name': name, 'size': path.stat().st_size, 'sha256': expected})
    manifest = {
        'version': 'sensevoice-small-int8-2365baea',
        'engine': 'sherpa-onnx SenseVoiceSmall INT8, utterance recognition',
        'source': f'https://huggingface.co/{REPOSITORY}/tree/{REVISION}',
        'license': 'FunASR Model License',
        'licenseSource': 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
        'originalModel': 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall/tree/3847d57b6bdf2dd8875cb1508d2af43d80a16bf7',
        'files': entries,
    }
    (TARGET / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    # Delete only known superseded ASR files, after both replacement files verify.
    for name in ('encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx',
                 'joiner-epoch-99-avg-1.int8.onnx', 'bpe.vocab', 'bbpe.model', 'applications.txt'):
        (TARGET / name).unlink(missing_ok=True)
    print(json.dumps({'version': manifest['version'], 'modelMiB': round(sum(e['size'] for e in entries) / 1048576, 2), 'files': len(entries)}))


if __name__ == '__main__':
    main()
