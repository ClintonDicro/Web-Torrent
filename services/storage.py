"""Filesystem helpers: Downloads folder detection, destination validation,
conflict handling, safe deletion and opening folders.

Everything that touches user paths goes through here so the safety rules live
in one place.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

from config import DOWNLOAD_SUBFOLDER

log = logging.getLogger(__name__)

# Windows FOLDERID_Downloads
_FOLDERID_DOWNLOADS = "{374DE290-123F-4565-9164-39C4925E467B}"


class StorageError(Exception):
    """A user-facing storage problem. `code` is a stable machine-readable id."""

    def __init__(self, message: str, code: str = "storage_error", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


# --------------------------------------------------------------------------- #
# Downloads folder detection
# --------------------------------------------------------------------------- #

def _windows_known_downloads() -> Path | None:
    """Resolve the Downloads known folder via SHGetKnownFolderPath."""
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                        ("Data3", wintypes.WORD), ("Data4", wintypes.BYTE * 8)]

        guid = GUID()
        ctypes.oledll.ole32.CLSIDFromString(_FOLDERID_DOWNLOADS, ctypes.byref(guid))
        path_ptr = ctypes.c_wchar_p()
        ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(path_ptr))
        try:
            value = path_ptr.value
        finally:
            ctypes.windll.ole32.CoTaskMemFree(path_ptr)
        return Path(value) if value else None
    except Exception as exc:  # pragma: no cover - only on broken Windows setups
        log.warning("SHGetKnownFolderPath failed: %s", exc)
        return None


def _windows_registry_downloads() -> Path | None:
    """Fallback: read the User Shell Folders registry value."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
        value, _ = winreg.QueryValueEx(key, _FOLDERID_DOWNLOADS)
        return Path(os.path.expandvars(value))
    except Exception:
        return None


def _xdg_downloads() -> Path | None:
    """Read XDG_DOWNLOAD_DIR from ~/.config/user-dirs.dirs (Linux)."""
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    dirs_file = config_home / "user-dirs.dirs"
    if not dirs_file.is_file():
        return None
    try:
        for line in dirs_file.read_text(encoding="utf-8").splitlines():
            m = re.match(r'\s*XDG_DOWNLOAD_DIR\s*=\s*"(.*)"\s*$', line)
            if m:
                raw = m.group(1).replace("$HOME", str(Path.home()))
                p = Path(os.path.expandvars(raw))
                if p.is_absolute() and p != Path.home():
                    return p
    except OSError:
        return None
    return None


def get_downloads_dir() -> Path:
    """Return the current user's Downloads folder (never hardcoded)."""
    candidate: Path | None = None
    if sys.platform == "win32":
        candidate = _windows_known_downloads() or _windows_registry_downloads()
    elif sys.platform.startswith("linux"):
        candidate = _xdg_downloads()
    return candidate or (Path.home() / "Downloads")


def default_destination(override: str | None = None) -> Path:
    if override:
        return Path(override).expanduser().resolve()
    return (get_downloads_dir() / DOWNLOAD_SUBFOLDER).resolve()


# --------------------------------------------------------------------------- #
# Destination validation
# --------------------------------------------------------------------------- #

def _protected_roots() -> list[Path]:
    roots: list[Path] = []
    if sys.platform == "win32":
        for var in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
            v = os.environ.get(var)
            if v:
                roots.append(Path(v).resolve())
    else:
        for p in ("/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/sbin", "/sys", "/usr", "/var/lib"):
            roots.append(Path(p))
    return roots


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_destination(raw: str | os.PathLike | None, fallback: Path, create: bool = True) -> Path:
    """Validate a user-chosen destination directory and return it resolved.

    Rules: absolute path, not a system directory, not a file, creatable and
    writable.
    """
    if raw is None or str(raw).strip() == "":
        path = Path(fallback)
    else:
        text = str(raw).strip()
        if "\x00" in text:
            raise StorageError("Destination contains invalid characters.", "invalid_destination")
        path = Path(os.path.expandvars(os.path.expanduser(text)))
        if not path.is_absolute():
            raise StorageError("Destination must be an absolute folder path.", "invalid_destination")
    try:
        path = path.resolve()
    except OSError as exc:
        raise StorageError(f"Destination is not a valid path: {exc}", "invalid_destination") from exc

    if path.parent == path:
        raise StorageError("A drive or filesystem root cannot be used as the destination.", "invalid_destination")
    for root in _protected_roots():
        if path == root or _is_within(path, root):
            raise StorageError("System folders cannot be used as a download destination.", "invalid_destination")
    if path.exists() and not path.is_dir():
        raise StorageError("Destination exists and is not a folder.", "invalid_destination")
    if not path.exists():
        if not create:
            raise StorageError("Destination folder does not exist.", "destination_unavailable")
        try:
            path.mkdir(parents=True, exist_ok=True)
        except PermissionError as exc:
            raise StorageError("Permission denied creating the destination folder.", "permission_denied") from exc
        except OSError as exc:
            raise StorageError(f"Destination unavailable: {exc.strerror or exc}", "destination_unavailable") from exc
    check_writable(path)
    return path


def check_writable(path: Path) -> None:
    probe = path / f".ptd-write-test-{uuid.uuid4().hex}"
    try:
        with open(probe, "xb") as fh:
            fh.write(b"ok")
    except PermissionError as exc:
        raise StorageError("Permission denied: the destination folder is not writable.", "permission_denied") from exc
    except OSError as exc:
        raise StorageError(f"Destination unavailable: {exc.strerror or exc}", "destination_unavailable") from exc
    finally:
        try:
            probe.unlink()
        except OSError:
            pass


def free_space(path: Path) -> int:
    import psutil
    p = Path(path)
    while not p.exists() and p.parent != p:
        p = p.parent
    return psutil.disk_usage(str(p)).free


def check_disk_space(path: Path, required_bytes: int, free_bytes: int | None = None) -> int:
    free = free_space(path) if free_bytes is None else free_bytes
    if required_bytes > free:
        raise StorageError(
            f"Not enough disk space: {format_bytes(required_bytes)} needed, {format_bytes(free)} available.",
            "insufficient_space", 507)
    return free


# --------------------------------------------------------------------------- #
# Paths inside a destination
# --------------------------------------------------------------------------- #

def safe_join(base: Path, relative: str) -> Path:
    """Join a torrent-relative path onto base, refusing anything that escapes."""
    rel = Path(relative)
    if rel.is_absolute() or rel.drive or any(part in ("..",) for part in rel.parts):
        raise StorageError("Unsafe path in torrent.", "path_traversal")
    full = (base / rel).resolve()
    if not _is_within(full, base.resolve()):
        raise StorageError("Unsafe path in torrent.", "path_traversal")
    return full


def _numbered(name: str, n: int, is_file: bool) -> str:
    if is_file:
        stem, dot, ext = name.rpartition(".")
        if dot and stem:
            return f"{stem} ({n}).{ext}"
    return f"{name} ({n})"


def plan_conflict_renames(save_path: Path, file_paths: list[str], multi_file: bool) -> tuple[dict[int, str], str | None]:
    """Decide renames so nothing existing is overwritten.

    For a multi-file torrent the top-level folder is renamed (``Name (1)``);
    for a single-file torrent the file itself is. Returns
    ``(renamed_files, new_top_level_name)``. Empty dict means no conflict.
    """
    if not file_paths:
        return {}, None
    top = Path(file_paths[0]).parts[0]
    target = save_path / top
    if not target.exists():
        return {}, None
    n = 1
    while True:
        candidate = _numbered(top, n, is_file=not multi_file)
        if not (save_path / candidate).exists():
            break
        n += 1
    renamed: dict[int, str] = {}
    for idx, rel in enumerate(file_paths):
        parts = Path(rel).parts
        renamed[idx] = str(Path(candidate, *parts[1:])) if multi_file else candidate
    return renamed, candidate


def delete_owned_files(save_path: Path, relative_files: list[str]) -> dict:
    """Delete only the given torrent-owned files under save_path.

    Each path is resolved and verified to stay inside save_path; symlinks are
    never followed. Afterwards, directories that belonged to the torrent are
    removed only if empty. Unrelated files are never touched.
    """
    base = Path(save_path).resolve()
    deleted, missing, refused = [], [], []
    dirs: set[Path] = set()
    for rel in relative_files:
        try:
            full = safe_join(base, rel)
        except StorageError:
            refused.append(rel)
            continue
        p = base / rel
        if p.is_symlink():
            refused.append(rel)
            continue
        if not full.exists():
            missing.append(rel)
        elif full.is_file():
            _unlink_retry(full)
            deleted.append(rel)
        else:
            refused.append(rel)
        parent = full.parent
        while parent != base and _is_within(parent, base):
            dirs.add(parent)
            parent = parent.parent
    for d in sorted(dirs, key=lambda x: len(x.parts), reverse=True):
        try:
            d.rmdir()  # only succeeds when empty
        except OSError:
            pass
    return {"deleted": deleted, "missing": missing, "refused": refused}


def _unlink_retry(path: Path, attempts: int = 20) -> None:
    import time
    for i in range(attempts):
        try:
            path.unlink()
            return
        except PermissionError:
            # Windows: libtorrent may still hold the handle for a moment.
            if i == attempts - 1:
                raise
            time.sleep(0.25)


def open_folder(path: Path) -> None:
    """Open a folder in the OS file manager without using a shell."""
    p = Path(path)
    if not p.is_dir():
        raise StorageError("Folder does not exist.", "destination_unavailable", 404)
    if sys.platform == "win32":
        os.startfile(str(p))  # type: ignore[attr-defined]  # opens folder, no shell parsing
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "--", str(p)])
    else:
        subprocess.Popen(["xdg-open", str(p)])


# --------------------------------------------------------------------------- #
# Formatting / sanitizing
# --------------------------------------------------------------------------- #

_UNSAFE_DISPLAY = re.compile(r"[\x00-\x1f\x7f‪-‮⁦-⁩‎‏]")


def sanitize_display(text: str, limit: int = 1024) -> str:
    """Strip control and bidi-override characters from untrusted names."""
    cleaned = _UNSAFE_DISPLAY.sub("", text or "")
    return cleaned[:limit]


def format_bytes(n: float) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    n = float(n)
    for u in units:
        if abs(n) < 1024 or u == units[-1]:
            return f"{n:.1f} {u}" if u != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"
