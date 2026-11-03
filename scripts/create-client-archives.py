"""Create lightweight and fully offline client ZIPs from a verified server release."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def verified(path, metadata):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != metadata['size']:
        raise ValueError(f'Missing or invalid client payload: {path.name}')
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != metadata['sha256']:
            raise ValueError(f'Client payload checksum mismatch: {path.name}')
    return path


def create_archives(root: Path, output: Path):
    receiver, teacher = root / 'receiver_release', root / 'desktop_release'
    plan = json.loads((receiver / 'update-plan.json').read_text('utf-8-sig'))
    entries = {entry['path']: entry for entry in plan['files']}
    core = entries['ICeClass.exe']
    classroom_manifest = json.loads((receiver / 'manifest.json').read_text('utf-8-sig'))
    teacher_manifest = json.loads((teacher / 'manifest.json').read_text('utf-8-sig')) if teacher.exists() else None
    if classroom_manifest['version'] != plan['version'] or (teacher_manifest is not None and teacher_manifest['version'] != plan['version']):
        raise ValueError('Client release versions do not match')
    manifests = [core, classroom_manifest]
    if teacher_manifest is not None:
        manifests.append(teacher_manifest)
    for manifest in manifests:
        if len(manifest['sha256']) != 64 or any(c not in '0123456789abcdef' for c in manifest['sha256']):
            raise ValueError('Invalid client checksum')
    full = verified(receiver / 'ICeClass.exe', classroom_manifest)
    lightweight = verified(receiver / 'payloads' / core['sha256'], core)
    teacher_app = verified(teacher / 'ICeClass.Desktop.exe', teacher_manifest) if teacher_manifest is not None else None
    models = []
    kinds = ['classroom', 'classroom-offline']
    if teacher_app is not None:
        for name in ('model.int8.onnx', 'tokens.txt'):
            item = entries['VoiceResources/Asr/' + name]
            if len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256']):
                raise ValueError('Invalid model checksum')
            models.append((item, verified(receiver / 'payloads' / item['sha256'], item)))
        kinds.extend(('teacher', 'teacher-offline'))
    output.mkdir(parents=True, exist_ok=True)
    for kind in kinds:
        offline = kind.endswith('-offline')
        classroom = kind.startswith('classroom')
        destination = output / f'ICeClass-{kind}.zip'
        temporary = destination.with_suffix('.zip.tmp')
        try:
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                if classroom:
                    prefix = 'ICeClass/教室端/'
                    archive.write(full if offline else lightweight, prefix + 'ICeClass.exe')
                    for name in ('install.ps1', '安装或升级.cmd'):
                        archive.write(receiver / name, prefix + name)
                    archive.writestr(prefix + 'program-manifest.json', json.dumps(classroom_manifest if offline else {
                        'version': plan['version'], 'size': core['size'], 'sha256': core['sha256'],
                    }, ensure_ascii=False))
                else:
                    prefix = 'Windows教师端/'
                    archive.write(teacher_app, prefix + 'ICeClass.Desktop.exe')
                    for name in ('install.ps1', 'install-voice-resources.ps1', '安装到本机.cmd'):
                        archive.write(teacher / name, prefix + name)
                    if offline:
                        for item, source in models:
                            archive.write(source, prefix + item['path'])
                        archive.writestr(prefix + 'voice-resources.json', json.dumps({'files': [
                            {key: item[key] for key in ('path', 'size', 'sha256')} for item, _ in models
                        ]}, ensure_ascii=False))
                preparation = ('已包含本客户端所需的全部离线语音资源。' if offline else
                    '这是轻量安装包。语音资源会在课间空闲时自动下载，也可在程序内点击“下载语音资源”。')
                archive.writestr(prefix + '一步使用说明.txt', '\ufeff' + '\r\n'.join([
                    'ICeClass 班伴 ' + plan['version'], preparation,
                    '完整解压后运行安装脚本；直接运行 EXE 也请保留同目录文件。',
                    '资源未就绪时仍可使用文字和原声录音等功能；语音准备页面显示进度，可暂停、重试和续传。',
                    '已有程序先从托盘退出再安装，绑定、账号资料和设置会保留。',
                    '首次绑定、账号登录和学校同步需要联网；离线资源不代表学校在线服务可离线使用。',
                ]))
            temporary.replace(destination)
        finally:
            if temporary.exists():
                temporary.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    arguments = parser.parse_args()
    create_archives(arguments.root.resolve(), arguments.output.resolve())
