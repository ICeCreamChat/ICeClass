"""Release guards must fail before publishing invalid or partial downloads."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import github_release as release


class ReleaseChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="iceclass-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        for folder in ("Receiver", "Desktop", "docs", "scripts", "dist/release"):
            (self.source / folder).mkdir(parents=True, exist_ok=True)
        for name in ("Receiver/Receiver.csproj", "Desktop/ICeClass.Desktop.csproj"):
            (self.source / name).write_text("<Project><PropertyGroup><Version>2.4.0</Version></PropertyGroup></Project>", encoding="utf-8")
        (self.source / "package.json").write_text(json.dumps({"version": "2.4.0"}), encoding="utf-8")
        (self.source / "package-lock.json").write_text(json.dumps({"version": "2.4.0", "packages": {"": {"version": "2.4.0"}}}), encoding="utf-8")
        (self.source / "docs/发布记录-2.4.0.md").write_text("# 2.4.0\nRelease notes.\n", encoding="utf-8")
        (self.source / "scripts/update-ubuntu.sh").write_bytes(b"#!/bin/bash\r\nset -e\r\n")
        for name in release.asset_names("2.4.0")[:4]:
            (self.source / "dist/release" / name).write_bytes(b"test-package-" + name.encode())
        self.directory = self.root / "assets"
        self.commit = "a" * 40
        self.draft = {"id": 123, "tag_name": "v2.4.0", "draft": True, "prerelease": False, "body": release.MARKER}

    def prepare(self):
        with patch.object(release, "source_commit", return_value=self.commit):
            return release.prepare(self.source, "v2.4.0", self.directory)

    def test_stable_tag_format(self):
        self.assertEqual(release.version_from_tag("v2.4.0"), "2.4.0")
        for value in ("main", "2.4.0", "v02.4.0", "v2.4.0-rc1", "v2.4.0\n", "v2.4.0;echo nope"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.version_from_tag(value)

    def test_all_project_versions_must_match(self):
        for name in ("Receiver/Receiver.csproj", "Desktop/ICeClass.Desktop.csproj", "package.json", "package-lock.json"):
            path = self.source / name
            original = path.read_text("utf-8")
            path.write_text(original.replace("2.4.0", "2.3.0"), encoding="utf-8")
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.validate_source(self.source, "v2.4.0")
            path.write_text(original, encoding="utf-8")
        lock = self.source / "package-lock.json"
        lock.write_text(json.dumps({"version": "2.4.0", "packages": {"": {"version": "2.3.0"}}}), encoding="utf-8")
        with self.assertRaises(ValueError):
            release.validate_source(self.source, "v2.4.0")

    def test_release_notes_required(self):
        (self.source / "docs/发布记录-2.4.0.md").unlink()
        with self.assertRaises(ValueError):
            release.validate_source(self.source, "v2.4.0")

    def test_checkout_must_match_tag(self):
        with patch.object(release.subprocess, "check_output", side_effect=["a" * 40, "b" * 40]):
            with self.assertRaises(ValueError):
                release.source_commit(self.source, "v2.4.0")

    def test_missing_package_blocks_staging(self):
        (self.source / "dist/release/ICeClass-2.4.0-server.zip").unlink()
        with patch.object(release, "source_commit", return_value=self.commit), self.assertRaises(ValueError):
            release.prepare(self.source, "v2.4.0", self.directory)
        self.assertFalse(self.directory.exists())

    def test_prepared_assets_and_shell_newlines(self):
        self.prepare()
        metadata = release.verify_assets(self.directory, "v2.4.0")
        self.assertEqual(len(metadata["assets"]), 6)
        self.assertNotIn(b"\r", (self.directory / "update-ubuntu-2.4.0.sh").read_bytes())
        self.assertEqual(len((self.directory / "SHA256SUMS-2.4.0.txt").read_text().splitlines()), 5)

    def test_tampered_asset_blocks_all_github_calls(self):
        self.prepare()
        (self.directory / "ICeClass-2.4.0-server.zip").write_bytes(b"changed")
        with patch.object(release, "gh") as gh, self.assertRaises(ValueError):
            release.publish(self.directory, "v2.4.0", "owner/repo")
        gh.assert_not_called()

    def test_moved_tag_blocks_release_creation(self):
        self.prepare()
        with patch.object(release, "gh_json", return_value={"sha": "b" * 40}), patch.object(release, "gh") as gh:
            with self.assertRaises(ValueError):
                release.publish(self.directory, "v2.4.0", "owner/repo")
        gh.assert_not_called()

    def test_published_release_and_unrelated_draft_are_preserved(self):
        self.prepare()
        for draft, body in ((False, release.MARKER), (True, "My handwritten draft")):
            with self.subTest(draft=draft), patch.object(release, "gh_json", side_effect=[
                {"sha": self.commit}, [[{"tag_name": "v2.4.0", "draft": draft, "body": body}]]
            ]), patch.object(release, "gh") as gh, self.assertRaises(ValueError):
                release.publish(self.directory, "v2.4.0", "owner/repo")
            gh.assert_not_called()

    def test_incomplete_upload_stays_draft(self):
        self.prepare()
        with patch.object(release, "gh_json", side_effect=[
            {"sha": self.commit}, [[]], [[self.draft]], {"draft": True, "assets": []}
        ]), patch.object(release, "gh") as gh, self.assertRaises(ValueError):
            release.publish(self.directory, "v2.4.0", "owner/repo")
        self.assertTrue(any(call.args[:2] == ("release", "create") for call in gh.call_args_list))
        self.assertFalse(any("--draft=false" in call.args for call in gh.call_args_list))

    def test_uploaded_digest_required_before_publishing(self):
        metadata = self.prepare()
        assets = [dict(asset, state="uploaded", digest="sha256:wrong") for asset in metadata["assets"]]
        with patch.object(release, "gh_json", side_effect=[
            {"sha": self.commit}, [[]], [[self.draft]], {"draft": True, "assets": assets}
        ]), patch.object(release, "gh") as gh, self.assertRaises(ValueError):
            release.publish(self.directory, "v2.4.0", "owner/repo")
        self.assertFalse(any("--draft=false" in call.args for call in gh.call_args_list))

    def test_upload_failure_does_not_publish(self):
        self.prepare()
        with patch.object(release, "gh_json", side_effect=[{"sha": self.commit}, [[]], [[self.draft]]]), patch.object(
            release, "gh", side_effect=["draft created", RuntimeError("upload interrupted")]
        ) as gh, self.assertRaises(RuntimeError):
            release.publish(self.directory, "v2.4.0", "owner/repo")
        self.assertFalse(any("--draft=false" in call.args for call in gh.call_args_list))

    def test_own_draft_can_resume_after_failure(self):
        metadata = self.prepare()
        assets = [dict(asset, state="uploaded", digest="sha256:" + asset["sha256"]) for asset in metadata["assets"]]
        with patch.object(release, "gh_json", side_effect=[
            {"sha": self.commit}, [[self.draft]], {"draft": True, "assets": assets},
            {"draft": False, "html_url": "https://github.com/owner/repo/releases/tag/v2.4.0"}
        ]), patch.object(release, "gh") as gh:
            release.publish(self.directory, "v2.4.0", "owner/repo")
        self.assertFalse(any(call.args[:2] == ("release", "create") for call in gh.call_args_list))
        self.assertIn("--draft=false", gh.call_args_list[-1].args)

    def test_complete_upload_publishes_without_downgrading_latest(self):
        metadata = self.prepare()
        assets = [dict(asset, state="uploaded", digest="sha256:" + asset["sha256"]) for asset in metadata["assets"]]
        for newer_exists in (False, True):
            releases = [{"tag_name": "v2.5.0", "draft": False, "prerelease": False}] if newer_exists else []
            with self.subTest(newer_exists=newer_exists), patch.object(release, "gh_json", side_effect=[
                {"sha": self.commit}, [releases], [[self.draft, *releases]], {"draft": True, "assets": assets},
                {"draft": False, "html_url": "https://github.com/owner/repo/releases/tag/v2.4.0"}
            ]) as gh_json, patch.object(release, "gh") as gh:
                release.publish(self.directory, "v2.4.0", "owner/repo")
            self.assertIn("--latest=false" if newer_exists else "--latest", gh.call_args_list[-1].args)
            self.assertEqual(gh_json.call_args_list[-2].args, ("api", "repos/owner/repo/releases/123"))
            self.assertEqual(gh_json.call_args_list[-1].args, ("api", "repos/owner/repo/releases/123"))


if __name__ == "__main__":
    unittest.main()
