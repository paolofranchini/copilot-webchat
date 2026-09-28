#!/usr/bin/env python3
"""Frontend web per GitHub Copilot CLI: una semplice chat privata.

Espone un'interfaccia web che invoca `copilot -p` in modalità non interattiva,
mantenendo la continuità della conversazione tramite --session-id / --resume.
Pensato per essere raggiunto solo via Tailscale (rete privata).
"""
import json
import math
import mimetypes
import os
import re
import selectors
import sqlite3
import subprocess
import tempfile
import time
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, session, stream_with_context
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
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 5
MAX_TEXT_ATTACHMENT_SIZE = 1 * 1024 * 1024
UPLOAD_DIR = CONFIG_DIR / "webchat_uploads"
SESSION_STATE_DIR = CONFIG_DIR / "session-state"
WEBCHAT_SESSION_PREFIX = "webchat:"
PERMISSION_FLAGS = {
    "shell": "--allow-tool=shell",
    "write": "--allow-tool=write",
    "all": "--allow-all",
}
DENY_PERMISSION_FLAGS = {
    "shell": "--deny-tool=shell",
    "write": "--deny-tool=write",
}
TOOL_PATTERN = re.compile(
    r"^(?:shell\([a-zA-Z0-9_./ :*-]{1,100}\)|"
    r"write\([a-zA-Z0-9_./ -]{1,150}\)|"
    r"url\((?:https?://)?[a-zA-Z0-9.*:-]{1,150}\)|"
    r"[a-zA-Z][a-zA-Z0-9_-]{0,60}\([a-zA-Z0-9_-]{1,80}\))$"
)
SERVER_NAME = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,60}$")
ENV_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


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


def valid_tool_permissions(tools):
    if (
        not isinstance(tools, list)
        or len(tools) > 20
        or any(not isinstance(tool, str) or not TOOL_PATTERN.fullmatch(tool) for tool in tools)
        or len(set(tools)) != len(tools)
    ):
        return None
    return tools


def advanced_request(data):
    return data.get("advanced") is True or data.get("advanced") == "true"


def require_advanced(data):
    if not hasattr(data, "get") or not advanced_request(data):
        return jsonify({"error": "modalita' avanzata richiesta"}), 400
    return None


def save_attachments(files: list[FileStorage]):
    if len(files) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise ValueError(
            f"puoi allegare al massimo {MAX_ATTACHMENTS_PER_MESSAGE} file"
        )

    attachments = []
    try:
        for uploaded_file in files:
            data = uploaded_file.read(MAX_ATTACHMENT_SIZE + 1)
            if not data:
                raise ValueError("file vuoto")
            if len(data) > MAX_ATTACHMENT_SIZE:
                raise ValueError("il file supera il limite di 10 MB")
            filename = Path(uploaded_file.filename or "")
            suffix = filename.suffix if len(filename.suffix) <= 20 else ""
            UPLOAD_DIR.mkdir(mode=0o700, exist_ok=True)
            path = UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
            path.write_bytes(data)
            attachments.append(path)
    except (OSError, ValueError):
        for path in attachments:
            path.unlink(missing_ok=True)
        raise
    return attachments


def prepare_attachments(attachments: list[Path]):
    """Prepara gli allegati testuali nel prompt e lascia gli altri a Copilot."""
    copilot_attachments = []
    text_attachments = []
    for attachment in attachments:
        content_type = mimetypes.guess_type(attachment.name)[0] or ""
        if content_type.startswith("text/") or attachment.suffix.lower() in {
            ".csv",
            ".json",
            ".md",
            ".rst",
            ".toml",
            ".tsv",
            ".xml",
            ".yaml",
            ".yml",
        }:
            data = attachment.read_bytes()
            if len(data) > MAX_TEXT_ATTACHMENT_SIZE:
                raise ValueError(
                    f"il file testuale {attachment.name} supera il limite di 1 MB"
                )
            try:
                text = data.decode("utf-8").replace("\x00", "\\0")
                text_attachments.append(
                    f"\n\n--- File allegato: {attachment.name} ---\n"
                    f"{text}"
                )
            except UnicodeDecodeError as exc:
                raise ValueError(
                    f"il file {attachment.name} non e' un testo UTF-8 valido"
                ) from exc
        else:
            copilot_attachments.append(attachment)
    return copilot_attachments, text_attachments


def init_db():
    with closing(sqlite3.connect(DB_PATH)) as db, db:
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
        db.execute(
            """CREATE TABLE IF NOT EXISTS mcp_servers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
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
        if "pending_plan" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN pending_plan TEXT")
        if "mcp_servers" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]'")
        if "tool_permissions" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN tool_permissions TEXT NOT NULL DEFAULT '[]'")
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


def read_session_metadata(path):
    metadata = {}
    try:
        for line in (path / "workspace.yaml").read_text().splitlines():
            key, separator, value = line.partition(":")
            if separator:
                metadata[key.strip()] = value.strip()
    except (OSError, UnicodeDecodeError):
        return metadata
    return metadata


def session_display_name(name):
    return name.removeprefix(WEBCHAT_SESSION_PREFIX).strip()


def write_session_name(session_id, title):
    if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        return
    path = SESSION_STATE_DIR / session_id / "workspace.yaml"
    if not path.is_file():
        return
    lines = path.read_text().splitlines()
    for index, line in enumerate(lines):
        if line.startswith("name:"):
            lines[index] = f"name: {WEBCHAT_SESSION_PREFIX}{title}"
            path.write_text("\n".join(lines) + "\n")
            return
    path.write_text(
        "\n".join([f"name: {WEBCHAT_SESSION_PREFIX}{title}", *lines]) + "\n"
    )


def rebuild_chat_database(db):
    chats = []
    if SESSION_STATE_DIR.exists():
        for session_dir in SESSION_STATE_DIR.iterdir():
            if not session_dir.is_dir() or not re.fullmatch(
                r"[0-9a-f-]{36}", session_dir.name
            ):
                continue
            events_path = session_dir / "events.jsonl"
            if not events_path.is_file():
                continue
            metadata = read_session_metadata(session_dir)
            if not metadata.get("name", "").startswith(WEBCHAT_SESSION_PREFIX):
                continue
            messages = []
            try:
                for line in events_path.read_text().splitlines():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        app.logger.warning("Evento sessione non valido: %s", events_path)
                        continue
                    event_data = event.get("data", {})
                    if not isinstance(event_data, dict):
                        continue
                    role = (
                        "user" if event.get("type") == "user.message"
                        else "bot" if event.get("type") == "assistant.message"
                        else None
                    )
                    content = event_data.get("content")
                    if role and isinstance(content, str) and content.strip():
                        messages.append({
                            "role": role,
                            "content": content,
                            "model": event_data.get("model") if role == "bot" else None,
                            "ts": event.get("timestamp") or "",
                        })
            except (OSError, UnicodeDecodeError) as exc:
                app.logger.warning("Sessione non leggibile %s: %s", events_path, exc)
                continue
            if not any(message["role"] == "user" for message in messages):
                continue
            first_user = next(message for message in messages if message["role"] == "user")
            title = session_display_name(metadata["name"]) or first_user["content"][:60]
            created_at = (
                metadata.get("created_at")
                or first_user["ts"]
                or datetime.fromtimestamp(
                    events_path.stat().st_mtime, timezone.utc
                ).isoformat()
            )
            chats.append((session_dir.name, title[:120], created_at, messages))

    db.execute("DELETE FROM messages")
    db.execute("DELETE FROM chats")
    for chat_id, title, created_at, messages in chats:
        db.execute(
            "INSERT INTO chats (id, title, created_at, permissions) VALUES (?, ?, ?, '[]')",
            (chat_id, title or "Senza titolo", created_at),
        )
        for message in messages:
            db.execute(
                "INSERT INTO messages (chat_id, role, content, model, ts) "
                "VALUES (?, ?, ?, ?, ?)",
                (chat_id, message["role"], message["content"],
                 message["model"], message["ts"] or created_at),
            )
        first_model = next(
            (message["model"] for message in messages
             if message["role"] == "bot" and message["model"]),
            None,
        )
        if first_model:
            db.execute("UPDATE chats SET model = ? WHERE id = ?",
                       (first_model, chat_id))
    db.commit()
    return len(chats)


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


@app.errorhandler(500)
def handle_internal_error(error):
    app.logger.error("Errore interno nell'API: %s", error)
    if request.path.startswith("/api/"):
        return jsonify({"error": "errore interno del server"}), 500
    return error


def run_copilot(
    prompt: str,
    copilot_session_id: str,
    is_new: bool,
    model: str = "auto",
    permissions: list[str] | None = None,
    attachments: list[Path] | None = None,
) -> tuple[str, str | None, dict | None]:
    """Invoca Copilot e restituisce risposta, modello e statistiche d'uso."""
    prompt = prompt.replace("\x00", "\\0")
    args = [COPILOT_BIN]
    if is_new:
        args += [
            "--session-id", copilot_session_id,
            "--name", f"{WEBCHAT_SESSION_PREFIX}{copilot_session_id}",
        ]
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


def advanced_args(chat_id, is_new, model, permissions, attachments, tools, servers,
                  plan, is_approval=False):
    args = [COPILOT_BIN]
    args += ["--session-id" if is_new else "--resume", chat_id, "--model", model,
             "--no-ask-user"]
    if is_new:
        args += ["--name", f"{WEBCHAT_SESSION_PREFIX}{chat_id}"]
    if plan:
        args += ["--plan", "--deny-tool=shell", "--deny-tool=write", "--deny-tool=url",
                 "--disable-builtin-mcps"]
    else:
        if is_approval:
            args += ["--mode", "interactive"]
        for permission in permissions:
            args.append(PERMISSION_FLAGS[permission])
        if "all" not in permissions:
            for permission, flag in DENY_PERMISSION_FLAGS.items():
                if permission not in permissions and not any(
                    tool.startswith(permission + "(") for tool in tools
                ):
                    args.append(flag)
            args.extend(f"--allow-tool={tool}" for tool in tools)
        if servers:
            config_fd, config_path = tempfile.mkstemp(
                prefix="webchat-mcp-", suffix=".json", dir=CONFIG_DIR
            )
            try:
                with os.fdopen(config_fd, "w") as config_file:
                    json.dump({"mcpServers": {
                        row["name"]: json.loads(row["config_json"]) for row in servers
                    }}, config_file)
            except BaseException:
                Path(config_path).unlink(missing_ok=True)
                raise
            args += ["--additional-mcp-config", f"@{config_path}"]
    for attachment in attachments:
        args += ["--attachment", str(attachment)]
    return args


def sse(event):
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def run_copilot_stream(args, prompt, chat_id, model, plan, attachments, is_approval=False):
    db = get_db()
    usage_fd, usage_path = tempfile.mkstemp(
        prefix="webchat-usage-", suffix=".json", dir=CONFIG_DIR
    )
    os.close(usage_fd)
    process = None
    try:
        args += ["--usage-output-file", usage_path, "-p",
                 prompt.replace("\x00", "\\0"), "--output-format", "json", "--stream", "on"]
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)
            reply, used_model = None, None
            remaining = b""
            deadline = time.monotonic() + TIMEOUT_SECONDS
            last_heartbeat = time.monotonic()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        raise CopilotRunError("timeout: risposta troppo lenta",
                                              read_copilot_usage(Path(usage_path)), 504)
                    if not selector.select(min(0.5, max(0, deadline - time.monotonic()))):
                        if time.monotonic() - last_heartbeat >= 2:
                            yield ": attesa\n\n"
                            last_heartbeat = time.monotonic()
                        continue
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        selector.unregister(process.stdout)
                        if not remaining:
                            break
                        chunk = b"\n"
                    remaining += chunk
                    if len(remaining) > 2 * 1024 * 1024 and b"\n" not in remaining:
                        raise CopilotRunError("risposta CLI troppo grande",
                                              read_copilot_usage(Path(usage_path)))
                    while b"\n" in remaining:
                        line, remaining = remaining.split(b"\n", 1)
                        try:
                            evt = json.loads(line)
                        except (ValueError, UnicodeDecodeError):
                            app.logger.warning("Evento JSON Copilot non leggibile")
                            continue
                        if not isinstance(evt, dict):
                            continue
                        kind = evt.get("type")
                        data = evt.get("data")
                        if not isinstance(data, dict):
                            data = {}
                        if kind == "assistant.message":
                            reply = data.get("content", reply)
                            used_model = data.get("model", used_model)
                        elif kind == "assistant.message.delta":
                            yield sse({"type": kind, "content": data.get("content", "")})
                        elif kind in ("tool.execution_start", "tool.execution_complete"):
                            yield sse({"type": kind, "data": data})
            try:
                process.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired as exc:
                raise CopilotRunError("timeout: risposta troppo lenta",
                                      read_copilot_usage(Path(usage_path)), 504) from exc
            usage = read_copilot_usage(Path(usage_path))
            if process.returncode:
                errors.seek(0)
                detail = errors.read(4096).decode("utf-8", errors="replace").strip()
                raise CopilotRunError(detail or "errore nell'esecuzione di Copilot", usage)
            if not isinstance(reply, str):
                raise CopilotRunError("nessuna risposta ricevuta da copilot", usage)
            reply = reply.strip()
            bot_ts = datetime.now(timezone.utc).isoformat()
            role = "plan" if plan else "bot"
            db.execute(
                "INSERT INTO messages (chat_id, role, content, model, ts) VALUES (?, ?, ?, ?, ?)",
                (chat_id, role, reply, used_model, bot_ts),
            )
            if plan:
                model_to_pin = used_model or (model if model != "auto" else None)
                db.execute(
                    "UPDATE chats SET pending_plan = ?, model = COALESCE(model, ?) WHERE id = ?",
                    (reply, model_to_pin, chat_id),
                )
            else:
                model_to_pin = used_model or (model if model != "auto" else None)
                if model_to_pin:
                    db.execute("UPDATE chats SET model = COALESCE(model, ?) WHERE id = ?",
                               (model_to_pin, chat_id))
                if is_approval:
                    db.execute("UPDATE chats SET pending_plan = NULL WHERE id = ?", (chat_id,))
            store_chat_usage(db, chat_id, usage)
            yield sse({"type": "done", "reply": reply, "model": used_model,
                       "usage": usage, "chat_id": chat_id, "ts": bot_ts,
                       "pending_plan": plan})
    except (CopilotRunError, OSError, subprocess.SubprocessError) as exc:
        if not isinstance(exc, CopilotRunError):
            app.logger.error("Impossibile eseguire Copilot: %s", exc)
        usage = exc.usage if isinstance(exc, CopilotRunError) else None
        store_chat_usage(db, chat_id, usage)
        yield sse({"type": "error",
                   "error": str(exc) if isinstance(exc, CopilotRunError)
                   else "impossibile eseguire Copilot",
                   "chat_id": chat_id, "usage": usage})
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdout is not None:
                process.stdout.close()
        Path(usage_path).unlink(missing_ok=True)
        if "--additional-mcp-config" in args:
            config_path = args[args.index("--additional-mcp-config") + 1]
            Path(config_path.removeprefix("@")).unlink(missing_ok=True)
        for attachment in attachments:
            attachment.unlink(missing_ok=True)


def selected_mcp_servers(db, chat_id):
    row = db.execute("SELECT mcp_servers FROM chats WHERE id = ?", (chat_id,)).fetchone()
    selected = json.loads(row["mcp_servers"]) if row else []
    if not selected:
        return []
    rows = db.execute(
        f"SELECT name, config_json FROM mcp_servers WHERE enabled = 1 "
        f"AND id IN ({','.join('?' for _ in selected)})", selected
    ).fetchall()
    return rows


def validate_mcp_config(config):
    if not isinstance(config, dict) or set(config) - {"command", "args", "env"}:
        return None
    command = config.get("command")
    args = config.get("args", [])
    env = config.get("env", {})
    if (not isinstance(command, str) or not command.startswith("/")
            or len(command) > 256 or "\x00" in command
            or not isinstance(args, list) or len(args) > 30
            or any(not isinstance(arg, str) or len(arg) > 1024 or "\x00" in arg for arg in args)
            or not isinstance(env, dict) or len(env) > 30
            or any(not isinstance(key, str) or not ENV_NAME.fullmatch(key)
                   or not isinstance(value, str) or len(value) > 2048 or "\x00" in value
                   for key, value in env.items())):
        return None
    return {"command": command, "args": args, "env": env}


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
        "SELECT id, title, created_at, permissions, model, usage, pending_plan, "
        "mcp_servers, tool_permissions FROM chats "
        "ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    chats = []
    for row in rows:
        chat = dict(row)
        chat["title"] = session_display_name(chat["title"])
        chat["permissions"] = json.loads(chat["permissions"])
        chat["usage"] = json.loads(chat["usage"]) if chat["usage"] else None
        chat["pending_plan"] = bool(chat["pending_plan"])
        chat["mcp_servers"] = json.loads(chat["mcp_servers"])
        chat["tool_permissions"] = json.loads(chat["tool_permissions"])
        chats.append(chat)
    return jsonify(chats)


@app.route("/api/chats/rebuild", methods=["POST"])
def rebuild_chats():
    try:
        count = rebuild_chat_database(get_db())
    except (OSError, sqlite3.Error) as exc:
        get_db().rollback()
        app.logger.error("Impossibile aggiornare il database chat: %s", exc)
        return jsonify({"error": "impossibile aggiornare il database chat"}), 500
    session.pop("copilot_session_id", None)
    return jsonify({"ok": True, "count": count})


@app.route("/api/chats/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    db = get_db()
    rows = db.execute(
        "SELECT role, content, model, ts FROM messages WHERE chat_id = ? ORDER BY ts ASC, id ASC",
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
    try:
        write_session_name(chat_id, title)
    except (OSError, UnicodeDecodeError) as exc:
        db.rollback()
        app.logger.error("Impossibile aggiornare il nome della sessione: %s", exc)
        return jsonify({"error": "impossibile aggiornare il nome della sessione"}), 500
    db.commit()
    return jsonify({"ok": True, "title": title})


@app.route("/api/chats/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    db = get_db()
    row = db.execute("SELECT 1 FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if row is None:
        return jsonify({"error": "chat non trovata"}), 404
    try:
        session_path = SESSION_STATE_DIR / chat_id / "workspace.yaml"
        if session_path.is_file():
            lines = session_path.read_text().splitlines()
            for index, line in enumerate(lines):
                if line.startswith("name:"):
                    name = line.partition(":")[2].strip()
                    if name.startswith(WEBCHAT_SESSION_PREFIX):
                        lines[index] = f"name: {session_display_name(name)}"
                        session_path.write_text("\n".join(lines) + "\n")
                    break
    except (OSError, UnicodeDecodeError) as exc:
        app.logger.error("Impossibile scollegare la sessione Copilot: %s", exc)
        return jsonify({"error": "impossibile eliminare la chat"}), 500
    db.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
    db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    db.commit()
    if session.get("copilot_session_id") == chat_id:
        session.pop("copilot_session_id", None)
    return jsonify({"ok": True})


@app.route("/api/mcp-servers", methods=["GET", "POST"])
def mcp_servers():
    db = get_db()
    if request.method == "GET":
        rows = db.execute("SELECT id, name, config_json, enabled FROM mcp_servers "
                          "ORDER BY name").fetchall()
        return jsonify([{"id": row["id"], "name": row["name"],
                         "config": json.loads(row["config_json"]),
                         "enabled": bool(row["enabled"])} for row in rows])
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    name = data.get("name")
    config = validate_mcp_config(data.get("config"))
    if not isinstance(name, str) or not SERVER_NAME.fullmatch(name) or config is None:
        return jsonify({"error": "configurazione MCP non valida"}), 400
    server_id = str(uuid.uuid4())
    try:
        db.execute("INSERT INTO mcp_servers VALUES (?, ?, ?, 1)",
                   (server_id, name, json.dumps(config)))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "server MCP gia' presente"}), 409
    return jsonify({"id": server_id, "name": name, "config": config, "enabled": True}), 201


@app.route("/api/mcp-servers/<server_id>", methods=["PUT", "DELETE"])
def edit_mcp_server(server_id):
    db = get_db()
    if request.method == "DELETE":
        data = request.get_json(silent=True) or {}
        if (error := require_advanced(data)):
            return error
        result = db.execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))
        if not result.rowcount:
            return jsonify({"error": "server MCP non trovato"}), 404
        rows = db.execute("SELECT id, mcp_servers FROM chats").fetchall()
        for row in rows:
            selected = json.loads(row["mcp_servers"])
            if server_id in selected:
                db.execute("UPDATE chats SET mcp_servers = ? WHERE id = ?",
                           (json.dumps([s for s in selected if s != server_id]), row["id"]))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    existing = db.execute("SELECT * FROM mcp_servers WHERE id = ?", (server_id,)).fetchone()
    if not existing:
        return jsonify({"error": "server MCP non trovato"}), 404
    name = data.get("name", existing["name"])
    config = (validate_mcp_config(data["config"]) if "config" in data
              else json.loads(existing["config_json"]))
    enabled = data.get("enabled", bool(existing["enabled"]))
    if (not isinstance(name, str) or not SERVER_NAME.fullmatch(name)
            or config is None or not isinstance(enabled, bool)):
        return jsonify({"error": "configurazione MCP non valida"}), 400
    try:
        db.execute("UPDATE mcp_servers SET name = ?, config_json = ?, enabled = ? WHERE id = ?",
                   (name, json.dumps(config), int(enabled), server_id))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "server MCP gia' presente"}), 409
    return jsonify({"id": server_id, "name": name, "config": config, "enabled": enabled})


@app.route("/api/chats/<chat_id>/mcp-servers", methods=["PUT"])
def update_chat_mcp(chat_id):
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    servers = data.get("servers")
    if (not isinstance(servers, list) or len(servers) > 20
            or any(not isinstance(server, str) for server in servers)
            or len(set(servers)) != len(servers)):
        return jsonify({"error": "server MCP non validi"}), 400
    db = get_db()
    known = {row["id"] for row in db.execute("SELECT id FROM mcp_servers").fetchall()}
    if any(server not in known for server in servers):
        return jsonify({"error": "server MCP non trovati"}), 400
    result = db.execute("UPDATE chats SET mcp_servers = ? WHERE id = ?",
                        (json.dumps(servers), chat_id))
    if not result.rowcount:
        return jsonify({"error": "chat non trovata"}), 404
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/chats/<chat_id>/tool-permissions", methods=["PUT"])
def update_chat_tools(chat_id):
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    tools = valid_tool_permissions(data.get("tools"))
    if tools is None:
        return jsonify({"error": "permessi tool non validi"}), 400
    db = get_db()
    result = db.execute("UPDATE chats SET tool_permissions = ? WHERE id = ?",
                        (json.dumps(tools), chat_id))
    if not result.rowcount:
        return jsonify({"error": "chat non trovata"}), 404
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/skills")
def skills():
    result = {}
    for key, command in (
        ("skills", "skill"), ("plugins", "plugin")
    ):
        try:
            output = subprocess.run([COPILOT_BIN, command, "list", "--json"],
                                    capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            app.logger.error("Impossibile elencare %s: %s", key, exc)
            return jsonify({"error": "impossibile leggere skill e plugin"}), 500
        if output.returncode:
            app.logger.error("Elenco %s fallito: %s", key, output.stderr)
            return jsonify({"error": "impossibile leggere skill e plugin"}), 500
        try:
            entries = json.loads(output.stdout)
            if not isinstance(entries, list):
                raise ValueError("formato inatteso")
            result[key] = [
                {"name": entry.get("name"), "description": entry.get("description", ""),
                 "source": entry.get("source", ""), "enabled": entry.get("enabled", True)}
                for entry in entries if isinstance(entry, dict) and isinstance(entry.get("name"), str)
            ]
        except ValueError as exc:
            app.logger.error("Elenco %s non valido: %s", key, exc)
            return jsonify({"error": "formato skill e plugin non valido"}), 500
    return jsonify(result)


@app.route("/api/chat/stream", methods=["POST"])
def chat_stream():
    data = request.form
    if (error := require_advanced(data)):
        return error
    message = (data.get("message") or "").strip()
    uploaded = [file for file in request.files.getlist("files") if file.filename]
    if not message and not uploaded:
        return jsonify({"error": "messaggio vuoto"}), 400
    try:
        permissions = valid_permissions(json.loads(data.get("permissions", "[]")))
    except json.JSONDecodeError:
        permissions = None
    if permissions is None:
        return jsonify({"error": "autorizzazioni non valide"}), 400
    try:
        selected_servers = json.loads(data.get("mcp_servers", "[]"))
        requested_tools = json.loads(data.get("tool_permissions", "[]"))
    except json.JSONDecodeError:
        return jsonify({"error": "impostazioni avanzate non valide"}), 400
    if (not isinstance(selected_servers, list) or len(selected_servers) > 20
            or any(not isinstance(server, str) for server in selected_servers)
            or len(set(selected_servers)) != len(selected_servers)
            or valid_tool_permissions(requested_tools) is None):
        return jsonify({"error": "impostazioni avanzate non valide"}), 400
    db = get_db()
    known_servers = {row["id"] for row in db.execute("SELECT id FROM mcp_servers")}
    if any(server not in known_servers for server in selected_servers):
        return jsonify({"error": "server MCP non trovati"}), 400
    model = (data.get("model") or "auto").strip() or "auto"
    if len(model) > 80 or not re.fullmatch(r"[a-zA-Z0-9._-]+", model):
        return jsonify({"error": "modello non valido"}), 400
    plan = data.get("plan") == "true"
    if "fleet" in data:
        return jsonify({"error": "fleet non supportato"}), 400
    attachments = []
    try:
        attachments = save_attachments(uploaded)
        copilot_attachments, text_attachments = prepare_attachments(attachments)
    except (ValueError, OSError) as exc:
        for path in attachments:
            path.unlink(missing_ok=True)
        if isinstance(exc, OSError):
            app.logger.error("Impossibile salvare l'allegato: %s", exc)
            return jsonify({"error": "impossibile salvare il file allegato"}), 500
        return jsonify({"error": str(exc)}), 400
    is_new = "copilot_session_id" not in session
    if is_new:
        session["copilot_session_id"] = str(uuid.uuid4())
    chat_id = session["copilot_session_id"]
    row = db.execute("SELECT model, pending_plan, tool_permissions, mcp_servers FROM chats WHERE id = ?",
                     (chat_id,)).fetchone()
    if row and row["pending_plan"]:
        for path in attachments:
            path.unlink(missing_ok=True)
        return jsonify({"error": "approva o annulla il piano prima di inviare"}), 409
    if row and "mcp_servers" not in data:
        selected_servers = json.loads(row["mcp_servers"])
    if row and "tool_permissions" not in data:
        requested_tools = json.loads(row["tool_permissions"])
    now = datetime.now(timezone.utc).isoformat()
    db.execute("INSERT OR IGNORE INTO chats (id, title, created_at, permissions) VALUES (?, ?, ?, ?)",
               (chat_id, message[:60] or "File allegato", now, json.dumps(permissions)))
    db.execute("UPDATE chats SET permissions = ?, mcp_servers = ?, tool_permissions = ? WHERE id = ?",
               (json.dumps(permissions), json.dumps(selected_servers),
                json.dumps(requested_tools), chat_id))
    try:
        args = advanced_args(chat_id, is_new or row is None,
                             row["model"] or model if row else model,
                             permissions, copilot_attachments, requested_tools,
                             selected_mcp_servers(db, chat_id), plan)
    except OSError as exc:
        for path in attachments:
            path.unlink(missing_ok=True)
        app.logger.error("Impossibile preparare Copilot: %s", exc)
        return jsonify({"error": "impossibile preparare Copilot"}), 500
    stored_message = (f"{message}\n\n[Allegati {len(attachments)} file]"
                      if attachments and message else
                      f"[Allegati {len(attachments)} file]" if attachments else message)
    db.execute("INSERT INTO messages (chat_id, role, content, ts) VALUES (?, 'user', ?, ?)",
               (chat_id, stored_message, now))
    db.commit()
    prompt = message or "Analizza i file allegati."
    prompt += "".join(text_attachments)
    if plan:
        prompt += "\n\nPrepara solo un piano; non modificare file e non eseguire comandi."
    def stream_with_chat():
        # La chat e' gia' stata committata insieme al primo messaggio: rendila
        # visibile subito nella sidebar, senza attendere la risposta di Copilot.
        yield sse({"type": "chat_created", "chat_id": chat_id,
                   "title": message[:60] or "File allegato"})
        yield from run_copilot_stream(
            args, prompt, chat_id, row["model"] or model if row else model,
            plan, attachments
        )

    stream = stream_with_chat()
    return Response(stream_with_context(stream), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/chat/plan/approve", methods=["POST"])
def approve_plan():
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    chat_id = session.get("copilot_session_id")
    db = get_db()
    row = (db.execute("SELECT model, permissions, pending_plan, tool_permissions "
                      "FROM chats WHERE id = ?", (chat_id,)).fetchone() if chat_id else None)
    if not row or not row["pending_plan"]:
        return jsonify({"error": "nessun piano in attesa"}), 409
    model = row["model"] or "auto"
    now = datetime.now(timezone.utc).isoformat()
    prompt = "Approvo il piano proposto. Procedi con l'implementazione."
    args = advanced_args(chat_id, False, model, json.loads(row["permissions"]), [],
                         json.loads(row["tool_permissions"]),
                         selected_mcp_servers(db, chat_id), False, is_approval=True)
    db.execute("INSERT INTO messages (chat_id, role, content, ts) VALUES (?, 'user', ?, ?)",
               (chat_id, prompt, now))
    db.commit()
    outcome = None
    for event in run_copilot_stream(args, prompt, chat_id, model, False, [], is_approval=True):
        if not event.startswith("data: "):
            continue
        payload = json.loads(event.removeprefix("data: ").strip())
        if payload["type"] in ("done", "error"):
            outcome = payload
    if outcome is None or outcome["type"] == "error":
        return jsonify({"error": outcome["error"] if outcome else "nessuna risposta",
                        "chat_id": chat_id,
                        "usage": outcome.get("usage") if outcome else None}), 500
    outcome.pop("type")
    outcome["user_ts"] = now
    return jsonify(outcome)


@app.route("/api/chat/plan/cancel", methods=["POST"])
def cancel_plan():
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    chat_id = session.get("copilot_session_id")
    db = get_db()
    result = db.execute("UPDATE chats SET pending_plan = NULL WHERE id = ? AND pending_plan IS NOT NULL",
                        (chat_id,))
    if not result.rowcount:
        return jsonify({"error": "nessun piano in attesa"}), 409
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/command", methods=["POST"])
def command():
    data = request.get_json(silent=True) or {}
    if (error := require_advanced(data)):
        return error
    text = data.get("command")
    if not isinstance(text, str):
        return jsonify({"error": "comando non valido"}), 400
    parts = text.strip().split(maxsplit=1)
    if not parts:
        return jsonify({"error": "comando non valido"}), 400
    db = get_db()
    chat_id = session.get("copilot_session_id")
    if parts[0] == "/help" and len(parts) == 1:
        return jsonify({"reply": "Comandi disponibili: /help, /usage, /model <modello>"})
    if parts[0] == "/usage" and len(parts) == 1:
        row = (db.execute("SELECT usage FROM chats WHERE id = ?", (chat_id,)).fetchone()
               if chat_id else None)
        usage = json.loads(row["usage"]) if row and row["usage"] else None
        return jsonify({"reply": "Utilizzo non disponibile" if usage is None else
                        "Utilizzo corrente della chat", "usage": usage})
    if parts[0] == "/model" and len(parts) == 2:
        model = parts[1].strip()
        if not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model):
            return jsonify({"error": "modello non valido"}), 400
        if chat_id:
            db.execute("UPDATE chats SET model = ? WHERE id = ?", (model, chat_id))
            db.commit()
        return jsonify({"reply": f"Modello impostato: {model}", "model": model})
    return jsonify({"error": "comando non supportato"}), 400


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) if request.is_json else request.form
    data = data or {}
    message = (data.get("message") or "").strip()
    uploaded_files = [
        file
        for field in ("files", "images")
        for file in request.files.getlist(field)
        if file.filename
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
    attachments = []
    try:
        attachments = save_attachments(uploaded_files)
        copilot_attachments, text_attachments = prepare_attachments(attachments)
    except ValueError as exc:
        for attachment in attachments:
            attachment.unlink(missing_ok=True)
        return jsonify({"error": str(exc)}), 400
    except OSError as exc:
        for attachment in attachments:
            attachment.unlink(missing_ok=True)
        app.logger.error("Impossibile salvare il file allegato: %s", exc)
        return jsonify({"error": "impossibile salvare il file allegato"}), 500

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
            f"{message}\n\n[Allegati {len(attachments)} file]"
            if message
            else f"[Allegati {len(attachments)} file]"
        )
    title = message[:60] or "File allegato"
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
        prompt = message or "Analizza i file allegati."
        if text_attachments:
            prompt += "".join(text_attachments)
        reply, used_model, usage = run_copilot(
            prompt,
            copilot_session_id,
            is_new,
            model,
            permissions,
            copilot_attachments,
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
    except (OSError, subprocess.SubprocessError) as exc:
        app.logger.error("Impossibile eseguire Copilot: %s", exc)
        store_chat_usage(db, copilot_session_id, None)
        return jsonify(
            {
                "error": "impossibile eseguire Copilot",
                "chat_id": copilot_session_id,
            }
        ), 500
    finally:
        for attachment in attachments:
            attachment.unlink(missing_ok=True)

    bot_ts = datetime.now(timezone.utc).isoformat()
    db.execute(
        "INSERT INTO messages (chat_id, role, content, model, ts) VALUES (?, 'bot', ?, ?, ?)",
        (copilot_session_id, reply, used_model, bot_ts),
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
            "user_ts": now,
            "ts": bot_ts,
        }
    )


@app.route("/api/new-chat", methods=["POST"])
def new_chat():
    session.pop("copilot_session_id", None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7890)
