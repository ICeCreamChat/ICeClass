"""Validate tagged sources and publish verified packages using GitHub CLI."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET


TAG_PATTERN = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", re.ASCII)
MARKER = "<!-- iceclass-github-actions-release -->"
PACKAGE_KINDS = ("classroom", "desktop-windows-x64", "windows-x64", "server")


def version_from_tag(tag):
    if not TAG_PATTERN.fullmatch(tag):
        raise ValueError("Use a stable version tag such as v2.4.0.")
    return tag[1:]


def asset_names(version):
    return [f"ICeClass-{version}-{kind}.zip" for kind in PACKAGE_KINDS] + [
        f"update-ubuntu-{version}.sh", f"SHA256SUMS-{version}.txt"
    ]


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_source(source, tag):
    version = version_from_tag(tag)
    versions = {}
    for project in ("Receiver/Receiver.csproj", "Desktop/ICeClass.Desktop.csproj"):
        versions[project] = ET.parse(source / project).findtext("./PropertyGroup/Version")
    for filename in ("package.json", "package-lock.json"):
        package = json.loads((source / filename).read_text("utf-8-sig"))
        versions[filename] = package.get("version")
        if filename == "package-lock.json":
            versions["package-lock.json packages['']"] = package.get("packages", {}).get("", {}).get("version")
    for name, actual in versions.items():
        if actual != version:
            raise ValueError(f"{tag} does not match {name}: {actual!r}.")
    notes = source / "docs" / f"发布记录-{version}.md"
    if not notes.is_file() or not notes.read_text("utf-8-sig").strip():
        raise ValueError(f"Missing release notes: {notes}")
    return version


def source_commit(source, tag):
    def resolve(ref):
        return subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "--verify", ref], text=True
        ).strip()
    head = resolve("HEAD")
    if head != resolve(f"refs/tags/{tag}^{{commit}}"):
        raise ValueError(f"The source checkout is not the commit tagged {tag}.")
    return head


def prepare(source, tag, directory):
    version = validate_source(source, tag)
    commit = source_commit(source, tag)
    names = asset_names(version)
    for name in names[:4]:
        if not (source / "dist/release" / name).is_file():
            raise ValueError(f"Missing package: {name}")
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("Use an empty directory for release assets.")
    directory.mkdir(parents=True, exist_ok=True)
    for name in names[:4]:
        shutil.copyfile(source / "dist/release" / name, directory / name)
    # Normalize shell-script newlines when packaging on Windows.
    (directory / names[4]).write_text(
        (source / "scripts/update-ubuntu.sh").read_text("utf-8-sig"), encoding="utf-8", newline="\n"
    )
    (directory / names[5]).write_text(
        "".join(f"{sha256(directory / name)}  {name}\n" for name in names[:5]),
        encoding="utf-8", newline="\n"
    )
    notes = (source / "docs" / f"发布记录-{version}.md").read_text("utf-8-sig")
    introduction = (
        f"{MARKER}\nGitHub Actions 从 `{tag}`（`{commit}`）自动构建并验证。"
        "教室端、Windows 教师端、完整 Windows 包、服务端包和 Ubuntu 更新脚本见下方附件；"
        "`SHA256SUMS` 提供文件校验值。\n\n"
        "> GitHub 发布与学校服务器部署分开进行。本次发布不会升级学校平台或客户端更新源；"
        "教室电脑收到新版前，需要管理员部署配套服务端和更新包。\n\n---\n\n"
    )
    (directory / "release-notes.md").write_text(introduction + notes, encoding="utf-8", newline="\n")
    metadata = {
        "tag": tag, "version": version, "commit": commit,
        "assets": [{"name": name, "size": (directory / name).stat().st_size,
                    "sha256": sha256(directory / name)} for name in names]
    }
    (directory / "release-metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return metadata


def verify_assets(directory, tag):
    version = version_from_tag(tag)
    metadata = json.loads((directory / "release-metadata.json").read_text("utf-8"))
    if metadata.get("tag") != tag or metadata.get("version") != version:
        raise ValueError("Release metadata does not match the requested tag.")
    if not re.fullmatch(r"[0-9a-f]{40}", metadata.get("commit", "")):
        raise ValueError("Missing source commit.")
    names = asset_names(version)
    if [asset["name"] for asset in metadata["assets"]] != names:
        raise ValueError("Unexpected release asset list.")
    for asset in metadata["assets"]:
        path = directory / asset["name"]
        if path.stat().st_size != asset["size"] or sha256(path) != asset["sha256"]:
            raise ValueError(f"Release asset changed after verification: {path.name}")
    checksums = "".join(f"{sha256(directory / name)}  {name}\n" for name in names[:5])
    if (directory / names[5]).read_text("utf-8") != checksums:
        raise ValueError("Checksum list does not match release assets.")
    if not (directory / "release-notes.md").read_text("utf-8").startswith(MARKER):
        raise ValueError("Missing generated release notes.")
    return metadata


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, encoding="utf-8").strip()


def gh_json(*args):
    return json.loads(gh(*args))


def publish(directory, tag, repo):
    metadata = verify_assets(directory, tag)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Use an owner/repository name.")
    commit = gh_json("api", f"repos/{repo}/commits/{tag}")["sha"]
    if commit != metadata["commit"]:
        raise ValueError("The remote tag moved after the build; refusing to publish.")
    pages = gh_json("api", "--paginate", "--slurp", f"repos/{repo}/releases?per_page=100")
    releases = [release for page in pages for release in page]
    existing = [release for release in releases if release["tag_name"] == tag]
    if len(existing) > 1:
        raise ValueError("More than one release uses this tag.")
    if existing and (not existing[0]["draft"] or MARKER not in (existing[0].get("body") or "")):
        raise ValueError("This tag already has a release; published releases and unrelated drafts are never overwritten.")
    title = f"ICeClass 班伴 {metadata['version']}"
    notes = str(directory / "release-notes.md")
    if not existing:
        gh("release", "create", tag, "--repo", repo, "--verify-tag", "--draft", "--title", title, "--notes-file", notes)
    else:
        gh("release", "edit", tag, "--repo", repo, "--draft", "--title", title, "--notes-file", notes)
    gh("release", "upload", tag, "--repo", repo, "--clobber",
       *(str(directory / asset["name"]) for asset in metadata["assets"]))
    uploaded = gh_json("api", f"repos/{repo}/releases/tags/{tag}")
    if not uploaded["draft"]:
        raise ValueError("The release must remain a draft until all assets are verified.")
    remote_assets = {asset["name"]: asset for asset in uploaded["assets"]}
    if set(remote_assets) != {asset["name"] for asset in metadata["assets"]}:
        raise ValueError("Uploaded release assets are incomplete or unexpected; the release remains a draft.")
    for asset in metadata["assets"]:
        remote = remote_assets[asset["name"]]
        if (remote["state"] != "uploaded" or remote["size"] != asset["size"]
                or remote.get("digest") != f"sha256:{asset['sha256']}"):
            raise ValueError(f"Uploaded asset verification failed: {asset['name']}; the release remains a draft.")
    version_parts = lambda value: tuple(map(int, value[1:].split(".")))
    newer_exists = any(
        not release["draft"] and not release["prerelease"]
        and TAG_PATTERN.fullmatch(release["tag_name"])
        and version_parts(release["tag_name"]) > version_parts(tag)
        for release in releases
    )
    gh("release", "edit", tag, "--repo", repo, "--draft=false",
       "--latest=false" if newer_exists else "--latest")
    published = gh_json("api", f"repos/{repo}/releases/tags/{tag}")
    if published["draft"]:
        raise ValueError("GitHub did not publish the release.")
    return published["html_url"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "prepare", "publish"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source", type=Path, default=Path("."))
    parser.add_argument("--directory", type=Path, default=Path("release-assets"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    args = parser.parse_args()
    if args.command == "validate":
        version = validate_source(args.source, args.tag)
        commit = source_commit(args.source, args.tag)
        if args.output:
            with args.output.open("a", encoding="utf-8", newline="\n") as output:
                output.write(f"version={version}\ncommit={commit}\n")
        print(f"Validated {args.tag} at {commit}")
    elif args.command == "prepare":
        metadata = prepare(args.source, args.tag, args.directory)
        print(f"Prepared {len(metadata['assets'])} verified assets for {args.tag}")
    else:
        url = publish(args.directory, args.tag, args.repo)
        print(f"Published {args.tag}: {url}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a", encoding="utf-8") as output:
                output.write(f"Published [{args.tag}]({url}) with six verified assets.\n")


if __name__ == "__main__":
    main()
