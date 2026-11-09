"""Settings, system status and logs."""
from __future__ import annotations

from collections import deque

from flask import Blueprint, jsonify, request

from routes import ctx
from services import storage

bp = Blueprint("settings", __name__)


def _settings_payload():
    c = ctx()
    values = c.settings.all()
    return {"settings": values, "effective_download_dir": str(c.manager.default_save_path()),
            "detected_downloads_folder": str(storage.get_downloads_dir())}


@bp.get("/api/settings")
def get_settings():
    return jsonify(_settings_payload())


@bp.put("/api/settings")
def put_settings():
    c = ctx()
    clean = c.settings.validate(request.get_json(silent=True))
    if clean.get("download_dir"):
        # Validate (and create) the folder before saving it.
        clean["download_dir"] = str(storage.validate_destination(
            clean["download_dir"], c.manager.default_save_path(), create=True))
    values = c.settings.update(clean)
    c.manager.apply_settings(values)
    return jsonify(_settings_payload())


@bp.get("/api/system/status")
def system_status():
    return jsonify(ctx().manager.system_status())


@bp.get("/api/system/logs")
def logs():
    c = ctx()
    try:
        n = max(1, min(int(request.args.get("lines", 300)), 2000))
    except ValueError:
        n = 300
    path = c.config.log_dir / "app.log"
    lines = []
    if path.is_file():
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = list(deque(fh, maxlen=n))
    return jsonify({"lines": [storage.sanitize_display(l.rstrip("\n"), 2000) for l in lines]})
