"""Torrent upload, preview and confirmation."""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from config import MAX_TORRENT_FILE_BYTES
from routes import ctx
from torrent_engine.metadata import TorrentValidationError

bp = Blueprint("upload", __name__)


@bp.post("/api/torrents/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        raise TorrentValidationError("No file was uploaded. Choose a .torrent file.", "no_file")
    data = f.stream.read(MAX_TORRENT_FILE_BYTES + 1)
    preview = ctx().manager.stage_upload(data, f.filename)
    return jsonify(preview), 201


@bp.post("/api/uploads/<upload_id>/check")
def check(upload_id):
    body = request.get_json(silent=True) or {}
    return jsonify(ctx().manager.check_destination(upload_id, body.get("save_path"), body.get("selected_files")))


@bp.delete("/api/uploads/<upload_id>")
def cancel(upload_id):
    ctx().manager.cancel_upload(upload_id)
    return jsonify({"cancelled": True})


@bp.post("/api/torrents")
def confirm():
    body = request.get_json(silent=True) or {}
    result = ctx().manager.add_torrent(
        body.get("upload_id"), body.get("save_path"), body.get("selected_files"),
        start=bool(body.get("start", True)), conflict=body.get("conflict") or "rename")
    return jsonify(result), 201
