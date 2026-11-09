"""Download listing, controls, files, history and the live event stream."""
from __future__ import annotations

import json
import time

from flask import Blueprint, Response, jsonify, request, stream_with_context

from routes import check_id, ctx

bp = Blueprint("downloads", __name__)


@bp.get("/api/torrents")
def list_torrents():
    return jsonify(ctx().manager.snapshot())


@bp.get("/api/torrents/<tid>")
def detail(tid):
    return jsonify(ctx().manager.get(check_id(tid)))


_ACTIONS = {
    "start": "start_task",
    "pause": "pause",
    "resume": "resume_task",
    "stop": "stop",
    "retry": "retry",
}


@bp.post("/api/torrents/<tid>/<action>")
def control(tid, action):
    check_id(tid)
    m = ctx().manager
    if action in _ACTIONS:
        return jsonify(getattr(m, _ACTIONS[action])(tid))
    if action == "open-folder":
        return jsonify({"opened": m.open_folder(tid)})
    if action == "queue":
        body = request.get_json(silent=True) or {}
        return jsonify(m.queue_move(tid, body.get("direction", "")))
    if action == "peers":
        body = request.get_json(silent=True) or {}
        m.connect_peer(tid, body.get("host", ""), body.get("port"))
        return jsonify({"connecting": True})
    if action == "delete-files":
        body = request.get_json(silent=True) or {}
        return jsonify(m.delete_files(tid, body.get("confirm") is True))
    return jsonify({"error": {"code": "not_found", "message": "Unknown action."}}), 404


@bp.delete("/api/torrents/<tid>")
def remove(tid):
    return jsonify(ctx().manager.remove(check_id(tid)))


@bp.get("/api/torrents/<tid>/files")
def files(tid):
    return jsonify({"files": ctx().manager.files(check_id(tid))})


@bp.put("/api/torrents/<tid>/files")
def set_files(tid):
    body = request.get_json(silent=True) or {}
    return jsonify(ctx().manager.set_files(check_id(tid), body.get("selected_files")))


@bp.post("/api/torrents/pause-all")
def pause_all():
    return jsonify({"paused": ctx().manager.pause_all()})


@bp.post("/api/torrents/resume-all")
def resume_all():
    return jsonify({"resumed": ctx().manager.resume_all()})


@bp.get("/api/history")
def history():
    return jsonify({"history": ctx().manager.history()})


@bp.get("/api/events")
def events():
    """Server-sent events: the cached snapshot about once per second, plus notifications."""
    c = ctx()
    manager, feed = c.manager, c.events
    try:
        last_event = int(request.args.get("last_event", feed.last_id))
    except ValueError:
        last_event = feed.last_id

    @stream_with_context
    def gen():
        nonlocal last_event
        last_sent = 0.0
        yield "retry: 2000\n\n"
        while True:
            snap = manager.snapshot()
            if snap["generated_at"] != last_sent:
                last_sent = snap["generated_at"]
                yield f"event: snapshot\ndata: {json.dumps(snap)}\n\n"
            for ev in feed.since(last_event):
                last_event = ev["id"]
                yield f"event: notice\ndata: {json.dumps(ev)}\n\n"
            if not manager.started:
                return
            time.sleep(0.5)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
