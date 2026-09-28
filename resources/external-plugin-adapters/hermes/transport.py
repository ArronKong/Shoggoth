"""Minimal private-socket transport for the Shoggoth Service adapter."""

from __future__ import annotations

import json
import os
import pwd
import re
import socket
import stat
import uuid
from pathlib import Path

VERSION = 11
MAX_FRAME = 64 * 1024
ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class ServiceError(RuntimeError):
    def __init__(self, code: str):
        self.code = code if ERROR_CODE.fullmatch(code) else "SHOGGOTH_SERVICE_ERROR"
        super().__init__("Shoggoth capability unavailable")


def _root() -> Path:
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    return home / "Library" / "Application Support" / "Shoggoth"


def _safe(path: Path, kind: str):
    info = path.lstat()
    if (info.st_mode & 0o077) or info.st_uid != os.getuid() or stat.S_ISLNK(info.st_mode):
        raise RuntimeError("Shoggoth adapter path is unsafe")
    if kind == "socket" and not stat.S_ISSOCK(info.st_mode):
        raise RuntimeError("Shoggoth Service socket is invalid")
    if kind == "file" and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise RuntimeError("Shoggoth adapter credential is invalid")
    return info


def read_credential() -> str:
    path = _root() / "shoggoth-core" / "external-plugin-hermes.auth.json"
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
    target = _root() / "run" / "service.sock"
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
