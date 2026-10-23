"""Minimal private-socket transport for the Shoggoth Service adapter."""

from __future__ import annotations

import json
import os
import pwd
import re
import socket
import stat
import sys
import uuid
from pathlib import Path

VERSION = 13  # Kept in sync with Service by release-package-checks and registrar.
MAX_FRAME = 64 * 1024
ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class ServiceError(RuntimeError):
    def __init__(self, code: str):
        self.code = code if ERROR_CODE.fullmatch(code) else "SHOGGOTH_SERVICE_ERROR"
        super().__init__("Shoggoth capability unavailable")


# The App-owned foreground host supplies both a protected managed descriptor
# and its actual Service profile root. Capture once before any model runs.
# Standalone legacy hosts keep pwd's fixed App root and ignore root-only ENV.
_MANAGED_ROOT = None
_MANAGED_ROOT_ANCHOR = None


def _freeze_managed_root():
    control_value = os.environ.get("SHOGGOTH_HERMES_MANAGED_CONTROL_FILE")
    if control_value is None:
        return None, None
    root_value = os.environ.get("SHOGGOTH_SERVICE_USER_DATA_ROOT")
    if not control_value or not root_value or len(root_value.encode()) > 4096:
        raise RuntimeError("Managed Shoggoth Service binding is missing")
    control = Path(control_value)
    root = Path(root_value)
    if (not control.is_absolute() or not root.is_absolute()
            or str(control.resolve(strict=True)) != control_value
            or str(root.resolve(strict=True)) != root_value):
        raise RuntimeError("Managed Shoggoth Service binding is not canonical")
    before = _safe(control, "file")
    if before.st_size > 16384:
        raise RuntimeError("Managed Shoggoth descriptor is too large")
    fd = os.open(control, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        if ((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)):
            raise RuntimeError("Managed Shoggoth descriptor changed")
        raw = os.read(fd, 16385)
        if len(raw) != opened.st_size:
            raise RuntimeError("Managed Shoggoth descriptor changed")
        data = json.loads(raw)
        current = os.fstat(fd)
        after = _safe(control, "file")
        if ((current.st_size, current.st_mtime_ns, current.st_ctime_ns)
                != (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                or (after.st_dev, after.st_ino) != (opened.st_dev, opened.st_ino)):
            raise RuntimeError("Managed Shoggoth descriptor changed")
    finally:
        os.close(fd)
    fields = {"version", "backend_id", "runtime_root", "runtime_tree_sha256",
              "data_root", "nonce", "control_token", "required_adapter_id",
              "adapter_tree_sha256"}
    if (not isinstance(data, dict) or set(data) != fields or type(data["version"]) is not int or data["version"] != 1
            or data["backend_id"] != "hermes"
            or data["required_adapter_id"] != "shoggoth_shared_capabilities"
            or any(not isinstance(data[key], str)
                   or not re.fullmatch(r"[a-f0-9]{64}", data[key])
                   for key in ("runtime_tree_sha256", "nonce", "control_token", "adapter_tree_sha256"))):
        raise RuntimeError("Managed Shoggoth descriptor is invalid")
    data_root = Path(data["data_root"])
    runtime = Path(data["runtime_root"])
    if (control != data_root / "managed-control.json"
            or os.environ.get("HERMES_HOME") != str(data_root)
            or not runtime.is_absolute() or runtime.resolve(strict=True) != runtime
            or not Path(sys.executable).resolve(strict=True).is_relative_to(runtime)):
        raise RuntimeError("Managed Shoggoth descriptor owner differs")
    _safe(data_root, "directory")
    anchor = _safe(root, "directory")
    return root, (anchor.st_dev, anchor.st_ino)


def _root() -> Path:
    if _MANAGED_ROOT is None:
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
        return home / "Library" / "Application Support" / "Shoggoth"
    current = _safe(_MANAGED_ROOT, "directory")
    if (current.st_dev, current.st_ino) != _MANAGED_ROOT_ANCHOR:
        raise RuntimeError("Managed Shoggoth Service root changed")
    return _MANAGED_ROOT


def _private_child_root(name: str) -> Path:
    root = _root()
    child = root / name
    if _MANAGED_ROOT is not None:
        _safe(child, "directory")
        if child.resolve(strict=True) != child:
            raise RuntimeError("Managed Shoggoth Service child is not canonical")
    return child


def _safe(path: Path, kind: str):
    info = path.lstat()
    if (info.st_mode & 0o077) or info.st_uid != os.getuid() or stat.S_ISLNK(info.st_mode):
        raise RuntimeError("Shoggoth adapter path is unsafe")
    if kind == "directory" and not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Shoggoth Service directory is invalid")
    if kind == "socket" and not stat.S_ISSOCK(info.st_mode):
        raise RuntimeError("Shoggoth Service socket is invalid")
    if kind == "file" and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise RuntimeError("Shoggoth adapter credential is invalid")
    return info


def read_credential() -> str:
    path = _private_child_root("shoggoth-core") / "external-plugin-hermes.auth.json"
    before = _safe(path, "file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or opened.st_size > 256:
            raise RuntimeError("Shoggoth adapter credential changed")
        record = json.loads(os.read(fd, 256))
        token = record.get("token")
        if record.get("schemaVersion") != 1 or not isinstance(token, str) or len(token) != 43:
            raise RuntimeError("Shoggoth adapter credential invalid")
        return token
    finally:
        os.close(fd)


def request_service(method: str, params: dict, timeout: float = 10.0) -> dict:
    target = _private_child_root("run") / "service.sock"
    before = _safe(target, "socket")
    request_id = str(uuid.uuid4())
    frame = (json.dumps({"id": request_id, "version": VERSION, "method": method,
                         "params": params}, ensure_ascii=False) + "\n").encode("utf-8")
    if len(frame) > MAX_FRAME:
        raise RuntimeError("Shoggoth adapter request is too large")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(target))
        current = _safe(target, "socket")
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError("Shoggoth Service socket changed")
        client.sendall(frame)
        chunks = bytearray()
        while True:
            part = client.recv(8192)
            if not part:
                break
            chunks.extend(part)
            if len(chunks) > MAX_FRAME:
                raise RuntimeError("Shoggoth adapter response is too large")
    if not chunks.endswith(b"\n") or b"\n" in chunks[:-1]:
        raise RuntimeError("Shoggoth adapter response framing invalid")
    response = json.loads(chunks[:-1])
    if response.get("id") != request_id or not isinstance(response.get("ok"), bool):
        raise RuntimeError("Shoggoth adapter response identity invalid")
    if not response["ok"]:
        detail = response.get("error")
        code = detail.get("code") if isinstance(detail, dict) else None
        raise ServiceError(code if isinstance(code, str) else "SHOGGOTH_SERVICE_ERROR")
    return response["result"]


_MANAGED_ROOT, _MANAGED_ROOT_ANCHOR = _freeze_managed_root()
