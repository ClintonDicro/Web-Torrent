import re

from flask import abort, current_app

_ID_RE = re.compile(r"^[0-9a-f]{40}$")


def ctx():
    """The app's engine context (manager, settings, events)."""
    return current_app.extensions["ptd"]


def check_id(tid: str) -> str:
    if not _ID_RE.match(tid or ""):
        abort(404)
    return tid
