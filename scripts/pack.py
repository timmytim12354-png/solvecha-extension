#!/usr/bin/env python3
"""Pack Solvecha Auto-Captcha with files at the ZIP root.

Chrome can only load a .zip when manifest.json is at the archive root.
GitHub's Code → Download ZIP wraps everything in solvecha-extension-main/,
which is why that file fails with "Could not unzip extension for install."
"""
from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

SKIP_DIRS = {".git", ".github", "scripts", "dist", "node_modules", "_from_vps"}
SKIP_FILES = {
    ".gitignore",
    "README.md",
    "LICENSE",
    "make-icons.mjs",
    "pack.py",
}
SKIP_SUFFIXES = {".zip", ".md", ".pem", ".crx"}


def version() -> str:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    return str(manifest["version"])


def should_include(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts):
        return False
    if path.name in SKIP_FILES:
        return False
    if path.suffix.lower() in SKIP_SUFFIXES:
        return False
    if path.name.startswith("."):
        return False
    return True


def files() -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            if should_include(p):
                out.append(p)
    out.sort()
    return out


def pack() -> tuple[Path, Path]:
    ver = version()
    DIST.mkdir(exist_ok=True)
    versioned = DIST / f"solvecha-extension-{ver}.zip"
    latest = ROOT / "solvecha-extension.zip"
    entries = files()
    if not any(p.name == "manifest.json" for p in entries):
        raise SystemExit("manifest.json missing from pack list")

    def write(dest: Path) -> None:
        if dest.exists():
            dest.unlink()
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in entries:
                arcname = path.relative_to(ROOT).as_posix()
                zf.write(path, arcname)

    write(versioned)
    write(latest)
    names = zipfile.ZipFile(versioned).namelist()
    if "manifest.json" not in names:
        raise SystemExit("zip is nested — manifest.json is not at the root")
    if any(n.startswith("chrome-extension/") or n.startswith("solvecha-extension") and n.endswith("/") for n in names):
        # allow solvecha-extension-1.0.2.zip as filename, not as inner folder
        pass
    if any(n.split("/")[0] in {"chrome-extension", "solvecha-extension-main"} for n in names):
        raise SystemExit(f"zip is nested: {names[:8]}")
    print(f"packed {versioned.name} ({len(names)} files, version {ver})")
    for n in names:
        print(f"  {n}")
    return versioned, latest


if __name__ == "__main__":
    pack()
