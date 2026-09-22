#!/usr/bin/env python3
"""Frontend web per GitHub Copilot CLI: una semplice chat privata.

Espone un'interfaccia web che invoca `copilot -p` in modalità non interattiva,
mantenendo la continuità della conversazione tramite --session-id / --resume.
Pensato per essere raggiunto solo via Tailscale (rete privata).
"""
import json
import sqlite3
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, g, jsonify, request, session
from werkzeug.security import check_password_hash

app = Flask(__name__, static_folder="static", static_url_path="")
CONFIG_DIR = Path.home() / ".copilot"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

# Chiave di sessione persistente su disco, cosi' i cookie restano validi
# tra un riavvio e l'altro del servizio.
SECRET_FILE = CONFIG_DIR / "webchat_secret"
if not SECRET_FILE.exists():
    SECRET_FILE.write_text(uuid.uuid4().hex)
app.secret_key = SECRET_FILE.read_text().strip()
app.permanent_session_lifetime = timedelta(days=30)

AUTH_FILE = CONFIG_DIR / "webchat_auth"
PASSWORD_HASH = AUTH_FILE.read_text().strip() if AUTH_FILE.exists() else None

DB_PATH = CONFIG_DIR / "webchat.db"
COPILOT_BIN = "/home/linuxbrew/.linuxbrew/bin/copilot"
TIMEOUT_SECONDS = 300
PERMISSION_FLAGS = {
    "shell": "--allow-tool=shell",
    "write": "--allow-tool=write",
}


def get_db():
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
    return db


@app.teardown_appcontext
def close_db(_exc):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        db.execute(
            """CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                model TEXT,
                ts TEXT NOT NULL
            )"""
        )
        # Migrazione soft: aggiunge la colonna 'model' se il db esisteva già senza.
        cols = [r[1] for r in db.execute("PRAGMA table_info(messages)").fetchall()]
        if "model" not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN model TEXT")


init_db()


@app.before_request
def require_login():
    open_paths = {"/login", "/api/login", "/login.html", "/login.css", "/login.js"}
    if request.path in open_paths:
        return None
    if session.get("authenticated"):
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "non autenticato"}), 401
    return app.send_static_file("login.html")


def run_copilot(
    prompt: str,
    copilot_session_id: str,
    is_new: bool,
    model: str = "auto",
    permissions: list[str] | None = None,
) -> tuple[str, str | None]:
    """Invoca copilot e restituisce (risposta, modello_usato).

    La prima richiesta lascia scegliere il modello a Copilot; le richieste
    successive riprendono la sessione senza sovrascrivere il modello scelto.
    """
    args = [COPILOT_BIN]
    if is_new:
        args += ["--session-id", copilot_session_id]
        args += ["--model", model]
    else:
        args += ["--resume", copilot_session_id]
    for permission in permissions or []:
        args.append(PERMISSION_FLAGS[permission])
    args += ["-p", prompt, "--output-format", "json"]

    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "errore sconosciuto").strip()
        raise RuntimeError(err)

    reply, model = None, None
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except ValueError:
            continue
        if evt.get("type") == "assistant.message":
            reply = evt.get("data", {}).get("content", reply)
            model = evt.get("data", {}).get("model", model)

    if reply is None:
        raise RuntimeError("nessuna risposta ricevuta da copilot")
    return reply.strip(), model


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    password = data.get("password") or ""
    if not PASSWORD_HASH or not check_password_hash(PASSWORD_HASH, password):
        return jsonify({"error": "password errata"}), 401
    session.permanent = True
    session["authenticated"] = True
    return jsonify({"ok": True})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/chats", methods=["GET"])
def list_chats():
    db = get_db()
    rows = db.execute(
        "SELECT id, title, created_at FROM chats ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/chats/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    db = get_db()
    rows = db.execute(
        "SELECT role, content, model, ts FROM messages WHERE chat_id = ? ORDER BY id ASC",
        (chat_id,),
    ).fetchall()
    session["copilot_session_id"] = chat_id
    return jsonify([dict(r) for r in rows])


@app.route("/api/chats/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    db = get_db()
    row = db.execute("SELECT 1 FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if row is None:
        return jsonify({"error": "chat non trovata"}), 404
    db.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
    db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    db.commit()
    if session.get("copilot_session_id") == chat_id:
        session.pop("copilot_session_id", None)
    return jsonify({"ok": True})


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "messaggio vuoto"}), 400
    permissions = data.get("permissions", [])
    if (
        not isinstance(permissions, list)
        or any(
            not isinstance(permission, str) or permission not in PERMISSION_FLAGS
            for permission in permissions
        )
        or len(set(permissions)) != len(permissions)
    ):
        return jsonify({"error": "autorizzazioni non valide"}), 400
    model = (data.get("model") or "auto").strip()
    if not model:
        model = "auto"

    is_new = "copilot_session_id" not in session
    if is_new:
        session["copilot_session_id"] = str(uuid.uuid4())
    copilot_session_id = session["copilot_session_id"]

    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    # INSERT OR IGNORE si autoripara: se il cookie di sessione punta a un
    # copilot_session_id che non esiste piu' nella tabella chats (es. dopo
    # un reset del db), la chat viene ricreata invece di restare orfana.
    title = message[:60]
    db.execute(
        "INSERT OR IGNORE INTO chats (id, title, created_at) VALUES (?, ?, ?)",
        (copilot_session_id, title, now),
    )
    db.execute(
        "INSERT INTO messages (chat_id, role, content, ts) VALUES (?, 'user', ?, ?)",
        (copilot_session_id, message, now),
    )
    db.commit()

    try:
        reply, used_model = run_copilot(
            message, copilot_session_id, is_new, model, permissions
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout: risposta troppo lenta"}), 504
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    db.execute(
        "INSERT INTO messages (chat_id, role, content, model, ts) VALUES (?, 'bot', ?, ?, ?)",
        (copilot_session_id, reply, used_model, datetime.now(timezone.utc).isoformat()),
    )
    db.commit()

    return jsonify({"reply": reply, "chat_id": copilot_session_id, "model": used_model})


@app.route("/api/new-chat", methods=["POST"])
def new_chat():
    session.pop("copilot_session_id", None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7890)
