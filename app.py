#!/usr/bin/env python3
"""Frontend web per GitHub Copilot CLI: una semplice chat privata.

Espone un'interfaccia web che invoca `copilot -p` in modalità non interattiva,
mantenendo la continuità della conversazione tramite --session-id / --resume.
Pensato per essere raggiunto solo via Tailscale (rete privata).
"""
import json
import math
import os
import sqlite3
import subprocess
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, g, jsonify, request, session
from werkzeug.datastructures import FileStorage
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
MAX_IMAGE_SIZE = 10 * 1024 * 1024
MAX_IMAGES_PER_MESSAGE = 5
UPLOAD_DIR = CONFIG_DIR / "webchat_uploads"
PERMISSION_FLAGS = {
    "shell": "--allow-tool=shell",
    "write": "--allow-tool=write",
    "all": "--allow-all",
}
DENY_PERMISSION_FLAGS = {
    "shell": "--deny-tool=shell",
    "write": "--deny-tool=write",
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


def valid_permissions(permissions):
    if (
        not isinstance(permissions, list)
        or any(
            not isinstance(permission, str) or permission not in PERMISSION_FLAGS
            for permission in permissions
        )
        or len(set(permissions)) != len(permissions)
    ):
        return None
    if "all" in permissions:
        return ["all"]
    return permissions


def image_extension(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    return None


def save_image_attachments(files: list[FileStorage]):
    if len(files) > MAX_IMAGES_PER_MESSAGE:
        raise ValueError(
            f"puoi allegare al massimo {MAX_IMAGES_PER_MESSAGE} immagini"
        )

    attachments = []
    try:
        for uploaded_file in files:
            data = uploaded_file.read(MAX_IMAGE_SIZE + 1)
            if not data:
                raise ValueError("immagine vuota")
            if len(data) > MAX_IMAGE_SIZE:
                raise ValueError("l'immagine supera il limite di 10 MB")
            extension = image_extension(data)
            if extension is None:
                raise ValueError(
                    "formato immagine non supportato: usa PNG, JPEG, GIF o WebP"
                )
            UPLOAD_DIR.mkdir(mode=0o700, exist_ok=True)
            path = UPLOAD_DIR / f"{uuid.uuid4().hex}{extension}"
            path.write_bytes(data)
            attachments.append(path)
    except (OSError, ValueError):
        for path in attachments:
            path.unlink(missing_ok=True)
        raise
    return attachments


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                permissions TEXT NOT NULL DEFAULT '[]',
                model TEXT,
                usage TEXT
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
        chat_cols = [r[1] for r in db.execute("PRAGMA table_info(chats)").fetchall()]
        if "permissions" not in chat_cols:
            db.execute(
                "ALTER TABLE chats ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'"
            )
        if "model" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN model TEXT")
        if "usage" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN usage TEXT")
        # Le chat gia' esistenti vengono fissate al primo modello usato.
        db.execute(
            """UPDATE chats
               SET model = (
                   SELECT model FROM messages
                   WHERE messages.chat_id = chats.id
                     AND messages.role = 'bot'
                     AND messages.model IS NOT NULL
                   ORDER BY messages.id ASC
                   LIMIT 1
               )
               WHERE model IS NULL"""
        )


init_db()


def nonnegative_number(value):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value < 0
    ):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def read_copilot_usage(path):
    try:
        usage_data = json.loads(path.read_text())
    except FileNotFoundError:
        app.logger.warning("Copilot non ha creato il file delle statistiche d'uso")
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        app.logger.warning("Statistiche d'uso Copilot non leggibili: %s", exc)
        return None

    if not isinstance(usage_data, dict):
        app.logger.warning("Formato delle statistiche d'uso Copilot non riconosciuto")
        return None

    usage = {}
    nano_aiu = nonnegative_number(usage_data.get("totalNanoAiu"))
    premium_requests = nonnegative_number(
        usage_data.get("totalPremiumRequestCost")
    )
    if nano_aiu is not None and (
        nano_aiu > 0 or premium_requests in (None, 0)
    ):
        usage["ai_credits"] = nano_aiu / 1_000_000_000
    if premium_requests is not None:
        usage["premium_requests"] = premium_requests
    if not usage:
        app.logger.warning(
            "Statistiche Copilot prive di crediti AI o richieste premium"
        )
        return None
    # Conserva solo i contatori di fatturazione, non il JSON CLI che può
    # contenere percorsi di file modificati.
    return usage


def store_chat_usage(db, chat_id, usage):
    db.execute(
        "UPDATE chats SET usage = ? WHERE id = ?",
        (json.dumps(usage) if usage is not None else None, chat_id),
    )
    db.commit()


class CopilotRunError(RuntimeError):
    def __init__(self, message, usage, status_code=500):
        super().__init__(message)
        self.usage = usage
        self.status_code = status_code


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
    attachments: list[Path] | None = None,
) -> tuple[str, str | None, dict | None]:
    """Invoca Copilot e restituisce risposta, modello e statistiche d'uso."""
    args = [COPILOT_BIN]
    if is_new:
        args += ["--session-id", copilot_session_id]
    else:
        args += ["--resume", copilot_session_id]
    args += ["--model", model]
    permissions = permissions or []
    for permission in permissions:
        args.append(PERMISSION_FLAGS[permission])
    if "all" not in permissions:
        for permission, flag in DENY_PERMISSION_FLAGS.items():
            if permission not in permissions:
                args.append(flag)
    for attachment in attachments or []:
        args += ["--attachment", str(attachment)]

    usage_fd, usage_path = tempfile.mkstemp(
        prefix="webchat-usage-", suffix=".json", dir=CONFIG_DIR
    )
    os.close(usage_fd)
    try:
        args += [
            "--usage-output-file",
            usage_path,
            "-p",
            prompt,
            "--output-format",
            "json",
        ]
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            usage = read_copilot_usage(Path(usage_path))
            raise CopilotRunError(
                "timeout: risposta troppo lenta", usage, 504
            ) from exc

        usage = read_copilot_usage(Path(usage_path))
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "errore sconosciuto").strip()
            raise CopilotRunError(err, usage)

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
            raise CopilotRunError("nessuna risposta ricevuta da copilot", usage)
        return reply.strip(), model, usage
    finally:
        Path(usage_path).unlink(missing_ok=True)


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
        "SELECT id, title, created_at, permissions, model, usage FROM chats "
        "ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    chats = []
    for row in rows:
        chat = dict(row)
        chat["permissions"] = json.loads(chat["permissions"])
        chat["usage"] = json.loads(chat["usage"]) if chat["usage"] else None
        chats.append(chat)
    return jsonify(chats)


@app.route("/api/chats/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    db = get_db()
    rows = db.execute(
        "SELECT role, content, model, ts FROM messages WHERE chat_id = ? ORDER BY id ASC",
        (chat_id,),
    ).fetchall()
    first_model = next((row["model"] for row in rows if row["role"] == "bot" and row["model"]), None)
    if first_model:
        db.execute(
            "UPDATE chats SET model = COALESCE(model, ?) WHERE id = ?",
            (first_model, chat_id),
        )
        db.commit()
    session["copilot_session_id"] = chat_id
    return jsonify([dict(r) for r in rows])


@app.route("/api/chats/<chat_id>/permissions", methods=["PUT"])
def update_chat_permissions(chat_id):
    data = request.get_json(force=True) or {}
    permissions = valid_permissions(data.get("permissions", []))
    if permissions is None:
        return jsonify({"error": "autorizzazioni non valide"}), 400
    db = get_db()
    result = db.execute(
        "UPDATE chats SET permissions = ? WHERE id = ?",
        (json.dumps(permissions), chat_id),
    )
    if result.rowcount == 0:
        return jsonify({"error": "chat non trovata"}), 404
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/chats/<chat_id>/title", methods=["PUT"])
def update_chat_title(chat_id):
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "titolo chat vuoto"}), 400
    if len(title) > 120:
        return jsonify({"error": "titolo chat troppo lungo (massimo 120 caratteri)"}), 400
    db = get_db()
    result = db.execute(
        "UPDATE chats SET title = ? WHERE id = ?",
        (title, chat_id),
    )
    if result.rowcount == 0:
        return jsonify({"error": "chat non trovata"}), 404
    db.commit()
    return jsonify({"ok": True, "title": title})


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
    data = request.get_json(silent=True) if request.is_json else request.form
    data = data or {}
    message = (data.get("message") or "").strip()
    uploaded_files = [
        file for file in request.files.getlist("images") if file.filename
    ]
    if not message and not uploaded_files:
        return jsonify({"error": "messaggio vuoto"}), 400
    raw_permissions = data.get("permissions", [])
    if isinstance(raw_permissions, str):
        try:
            raw_permissions = json.loads(raw_permissions)
        except json.JSONDecodeError:
            return jsonify({"error": "autorizzazioni non valide"}), 400
    permissions = valid_permissions(raw_permissions)
    if permissions is None:
        return jsonify({"error": "autorizzazioni non valide"}), 400
    model = (data.get("model") or "auto").strip()
    if not model:
        model = "auto"
    try:
        attachments = save_image_attachments(uploaded_files)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError as exc:
        app.logger.error("Impossibile salvare l'immagine allegata: %s", exc)
        return jsonify({"error": "impossibile salvare l'immagine allegata"}), 500

    is_new = "copilot_session_id" not in session
    if is_new:
        session["copilot_session_id"] = str(uuid.uuid4())
    copilot_session_id = session["copilot_session_id"]

    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    # INSERT OR IGNORE si autoripara: se il cookie di sessione punta a un
    # copilot_session_id che non esiste piu' nella tabella chats (es. dopo
    # un reset del db), la chat viene ricreata invece di restare orfana.
    stored_message = message
    if attachments:
        stored_message = (
            f"{message}\n\n[Allegate {len(attachments)} immagini]"
            if message
            else f"[Allegate {len(attachments)} immagini]"
        )
    title = message[:60] or "Immagine allegata"
    db.execute(
        "INSERT OR IGNORE INTO chats (id, title, created_at, permissions, model) "
        "VALUES (?, ?, ?, ?, NULL)",
        (copilot_session_id, title, now, json.dumps(permissions)),
    )
    db.execute(
        "UPDATE chats SET permissions = ? WHERE id = ?",
        (json.dumps(permissions), copilot_session_id),
    )
    chat_row = db.execute(
        "SELECT model FROM chats WHERE id = ?", (copilot_session_id,)
    ).fetchone()
    pinned_model = chat_row["model"] if chat_row else None
    model = pinned_model or model
    db.execute(
        "INSERT INTO messages (chat_id, role, content, ts) VALUES (?, 'user', ?, ?)",
        (copilot_session_id, stored_message, now),
    )
    db.commit()

    try:
        reply, used_model, usage = run_copilot(
            message or "Analizza le immagini allegate.",
            copilot_session_id,
            is_new,
            model,
            permissions,
            attachments,
        )
    except CopilotRunError as exc:
        store_chat_usage(db, copilot_session_id, exc.usage)
        return jsonify(
            {
                "error": str(exc),
                "chat_id": copilot_session_id,
                "usage": exc.usage,
            }
        ), exc.status_code
    finally:
        for attachment in attachments:
            attachment.unlink(missing_ok=True)

    db.execute(
        "INSERT INTO messages (chat_id, role, content, model, ts) VALUES (?, 'bot', ?, ?, ?)",
        (copilot_session_id, reply, used_model, datetime.now(timezone.utc).isoformat()),
    )
    model_to_pin = used_model or (model if model != "auto" else None)
    if model_to_pin:
        db.execute(
            "UPDATE chats SET model = COALESCE(model, ?) WHERE id = ?",
            (model_to_pin, copilot_session_id),
        )
    db.execute(
        "UPDATE chats SET usage = ? WHERE id = ?",
        (
            json.dumps(usage) if usage is not None else None,
            copilot_session_id,
        ),
    )
    db.commit()

    return jsonify(
        {
            "reply": reply,
            "chat_id": copilot_session_id,
            "model": used_model,
            "usage": usage,
        }
    )


@app.route("/api/new-chat", methods=["POST"])
def new_chat():
    session.pop("copilot_session_id", None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7890)
