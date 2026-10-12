#!/usr/bin/env python3
"""Frontend web per GitHub Copilot CLI: una semplice chat privata.

Espone un'interfaccia web che invoca `copilot -p` in modalità non interattiva,
mantenendo la continuità della conversazione tramite --session-id / --resume.
Pensato per essere raggiunto solo via Tailscale (rete privata).
"""
import ipaddress
import json
import math
import mimetypes
import os
import re
import selectors
import shutil
import sqlite3
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import closing
from bisect import bisect_right
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, g, jsonify, request, send_file, session, stream_with_context
from werkzeug.datastructures import FileStorage
from werkzeug.security import check_password_hash
from werkzeug.serving import make_server

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
TLS_DIR = CONFIG_DIR / "webchat_tls"
TLS_CA_CERT = TLS_DIR / "ca.crt"
TLS_PORT = 7891
COPILOT_BIN = "/home/linuxbrew/.linuxbrew/bin/copilot"
TIMEOUT_SECONDS = 300
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 5
MAX_TEXT_ATTACHMENT_SIZE = 1 * 1024 * 1024
UPLOAD_DIR = CONFIG_DIR / "webchat_uploads"
SESSION_STATE_DIR = CONFIG_DIR / "session-state"
IMAGE_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
}
PERMISSION_FLAGS = {
    "shell": "--allow-tool=shell",
    "write": "--allow-tool=write",
    "all": "--allow-all",
}
TOOL_PATTERN = re.compile(
    r"^(?:shell\([a-zA-Z0-9_./ :*-]{1,100}\)|"
    r"write\([a-zA-Z0-9_./ -]{1,150}\)|"
    r"url\((?:https?://)?[a-zA-Z0-9.*:-]{1,150}\)|"
    r"[a-zA-Z][a-zA-Z0-9_-]{0,60}\([a-zA-Z0-9_-]{1,80}\))$"
)
SERVER_NAME = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,60}$")
ENV_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
SERVICE_INSTANCE_ID = uuid.uuid4().hex
SERVICE_RESTART_LOCK = threading.Lock()
service_restarting = False


def collect_tls_subject_alt_names():
    """Raccoglie hostname e indirizzi privati con cui si raggiunge il servizio."""
    names = {"DNS:localhost", "IP:127.0.0.1", "IP:::1"}
    for hostname in (socket.gethostname(), socket.getfqdn()):
        hostname = hostname.rstrip(".").lower()
        if len(hostname) <= 253 and all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in hostname.split(".")
        ):
            names.add(f"DNS:{hostname}")

    addresses = set()
    tailscale = shutil.which("tailscale")
    if tailscale:
        try:
            result = subprocess.run(
                [tailscale, "ip"], capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0:
                addresses.update(result.stdout.split())
        except (OSError, subprocess.SubprocessError):
            app.logger.warning("Impossibile rilevare gli indirizzi Tailscale")

    ip_command = shutil.which("ip")
    if ip_command:
        try:
            result = subprocess.run(
                [ip_command, "-j", "address", "show"],
                capture_output=True, text=True, timeout=3,
            )
            if result.returncode == 0:
                for interface in json.loads(result.stdout):
                    for address in interface.get("addr_info", []):
                        addresses.add(address.get("local", ""))
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            app.logger.warning("Impossibile rilevare gli indirizzi di rete locali")

    tailscale_network = ipaddress.ip_network("100.64.0.0/10")
    for value in addresses:
        try:
            address = ipaddress.ip_address(value.split("%", 1)[0])
        except ValueError:
            continue
        if (
            address.is_loopback or address.is_link_local
            or address.is_multicast or address.is_unspecified
        ):
            continue
        if address.is_private or address in tailscale_network:
            names.add(f"IP:{address}")
    return sorted(names)


def ensure_tls_certificates(tls_dir, subject_alt_names):
    """Crea una CA privata persistente e rinnova il certificato server locale."""
    openssl = shutil.which("openssl")
    if not openssl:
        raise RuntimeError("openssl non è installato")

    tls_dir = Path(tls_dir)
    tls_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    tls_dir.chmod(0o700)
    ca_cert = tls_dir / "ca.crt"
    ca_key = tls_dir / "ca.key"
    server_cert = tls_dir / "server.crt"
    server_key = tls_dir / "server.key"
    if ca_cert.exists() != ca_key.exists():
        raise RuntimeError("configurazione CA incompleta in webchat_tls")

    def run_openssl(arguments):
        result = subprocess.run(
            [openssl, *arguments], capture_output=True, text=True, timeout=30
        )
        if result.returncode:
            detail = result.stderr.strip().splitlines()
            message = detail[-1] if detail else "errore OpenSSL"
            raise RuntimeError(message)

    with tempfile.TemporaryDirectory(prefix=".tls-", dir=tls_dir) as temporary:
        temporary = Path(temporary)
        if not ca_cert.exists():
            generated_ca_key = temporary / "ca.key"
            generated_ca_cert = temporary / "ca.crt"
            run_openssl([
                "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256",
                "-days", "3650", "-keyout", str(generated_ca_key),
                "-out", str(generated_ca_cert), "-subj",
                "/CN=Copilot Webchat Local CA", "-addext",
                "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            ])
            os.chmod(generated_ca_key, 0o600)
            os.replace(generated_ca_key, ca_key)
            os.replace(generated_ca_cert, ca_cert)

        if not server_key.exists():
            generated_server_key = temporary / "server.key"
            run_openssl([
                "genpkey", "-algorithm", "RSA", "-pkeyopt",
                "rsa_keygen_bits:2048", "-out", str(generated_server_key),
            ])
            os.chmod(generated_server_key, 0o600)
            os.replace(generated_server_key, server_key)
        else:
            os.chmod(server_key, 0o600)
        os.chmod(ca_key, 0o600)

        csr = temporary / "server.csr"
        extensions = temporary / "server.ext"
        generated_server_cert = temporary / "server.crt"
        names = sorted(set(subject_alt_names) | {
            "DNS:localhost", "IP:127.0.0.1", "IP:::1",
        })
        if any(not re.fullmatch(
            r"(?:DNS:[a-z0-9.-]{1,253}|IP:(?:[0-9a-fA-F:.]+))", name
        ) for name in names):
            raise ValueError("nome alternativo del certificato non valido")
        extensions.write_text(
            f"subjectAltName = {','.join(names)}\n"
            "basicConstraints = critical,CA:FALSE\n"
            "keyUsage = critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage = serverAuth\n"
        )
        run_openssl([
            "req", "-new", "-key", str(server_key), "-out", str(csr),
            "-subj", "/CN=Copilot CLI Webchat",
        ])
        run_openssl([
            "x509", "-req", "-in", str(csr), "-CA", str(ca_cert),
            "-CAkey", str(ca_key), "-CAserial", str(tls_dir / "ca.srl"),
            "-CAcreateserial", "-out", str(generated_server_cert),
            "-days", "825", "-sha256", "-extfile", str(extensions),
        ])
        os.replace(generated_server_cert, server_cert)
    return ca_cert, server_cert, server_key


def start_https_listener():
    """Avvia HTTPS in parallelo; un problema TLS non interrompe la porta HTTP."""
    try:
        ca_cert, server_cert, server_key = ensure_tls_certificates(
            TLS_DIR, collect_tls_subject_alt_names()
        )
        server = make_server(
            "0.0.0.0", TLS_PORT, app, threaded=True,
            ssl_context=(str(server_cert), str(server_key)),
        )
        worker = threading.Thread(
            target=server.serve_forever, name="webchat-https", daemon=True
        )
        worker.start()
    except Exception:
        app.logger.exception(
            "HTTPS non disponibile sulla porta %s; HTTP resta attivo sulla 7890",
            TLS_PORT,
        )
        return False
    app.logger.info(
        "HTTPS attivo sulla porta %s; certificato CA: %s", TLS_PORT, ca_cert
    )
    return True


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
    return ["shell", "write"] if permissions else []


def valid_tool_permissions(tools):
    if (
        not isinstance(tools, list)
        or len(tools) > 20
        or any(not isinstance(tool, str) or not TOOL_PATTERN.fullmatch(tool) for tool in tools)
        or len(set(tools)) != len(tools)
    ):
        return None
    return tools


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
                model TEXT
            )"""
        )
        db.execute(
            """CREATE TABLE IF NOT EXISTS mcp_servers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
            )"""
        )
        chat_cols = [r[1] for r in db.execute("PRAGMA table_info(chats)").fetchall()]
        if "permissions" not in chat_cols:
            db.execute(
                "ALTER TABLE chats ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'"
            )
        if "model" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN model TEXT")
        if "working_directory" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN working_directory TEXT")
        if "usage" in chat_cols:
            db.execute("UPDATE chats SET usage = NULL")
        if "pending_plan" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN pending_plan TEXT")
        if "mcp_servers" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]'")
        if "tool_permissions" not in chat_cols:
            db.execute("ALTER TABLE chats ADD COLUMN tool_permissions TEXT NOT NULL DEFAULT '[]'")
        db.execute("UPDATE chats SET title = 'Sessione Copilot'")
        db.execute(
            "UPDATE chats SET pending_plan = '1' WHERE pending_plan IS NOT NULL"
        )
        message_cols = [
            row[1] for row in db.execute("PRAGMA table_info(messages)").fetchall()
        ]
        if "model" in message_cols:
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
        db.execute("DROP TABLE IF EXISTS messages")
        db.execute(
            """CREATE TABLE IF NOT EXISTS chat_jobs (
                id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
                status TEXT NOT NULL, owner_pid INTEGER NOT NULL,
                progress TEXT NOT NULL DEFAULT '{}', result TEXT
            )"""
        )
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS chat_jobs_running "
            "ON chat_jobs(chat_id) WHERE status = 'running'"
        )
        db.execute(
            """CREATE TABLE IF NOT EXISTS auto_model_responses (
                chat_id TEXT NOT NULL,
                message_ts TEXT NOT NULL,
                PRIMARY KEY (chat_id, message_ts)
            )"""
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


def read_cli_usage(session_ids):
    if not session_ids:
        return {}
    usage_db_path = CONFIG_DIR / "session-store.db"
    uri = usage_db_path.as_uri() + "?mode=ro"
    usage_by_session = {}
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as usage_db:
            for offset in range(0, len(session_ids), 900):
                batch = session_ids[offset:offset + 900]
                placeholders = ",".join("?" for _ in batch)
                rows = usage_db.execute(
                    "SELECT session_id, SUM(total_nano_aiu) FROM assistant_usage_events "
                    f"WHERE session_id IN ({placeholders}) GROUP BY session_id",
                    batch,
                )
                for session_id, total_nano_aiu in rows:
                    total_nano_aiu = nonnegative_number(total_nano_aiu)
                    if total_nano_aiu is not None:
                        usage_by_session[session_id] = {
                            "ai_credits": total_nano_aiu / 1_000_000_000
                        }
    except sqlite3.Error as exc:
        app.logger.warning("Utilizzo Copilot non leggibile dal database CLI: %s", exc)
    return usage_by_session


def read_session_metadata(path):
    metadata = {}
    try:
        lines = (path / "workspace.yaml").read_text().splitlines()
        index = 0
        while index < len(lines):
            line = lines[index]
            key, separator, value = line.partition(":")
            if separator:
                key, value = key.strip(), value.strip()
                if key == "name" and re.fullmatch(r"[|>][+-]?", value):
                    block = []
                    index += 1
                    while index < len(lines) and (
                        not lines[index].strip() or lines[index][0].isspace()
                    ):
                        block.append(lines[index])
                        index += 1
                    indentation = min(
                        (len(item) - len(item.lstrip()) for item in block if item.strip()),
                        default=0,
                    )
                    block = [item[indentation:] if item.strip() else "" for item in block]
                    value = " ".join(part.strip() for part in block if part.strip()) \
                        if value.startswith(">") else "\n".join(block).strip()
                    metadata[key] = value
                    continue
                if key == "name" and value.startswith('"'):
                    try:
                        value = json.loads(value)
                    except json.JSONDecodeError as exc:
                        app.logger.warning("Nome sessione non decodificabile %s: %s", path, exc)
                metadata[key] = value
            index += 1
    except (OSError, UnicodeDecodeError):
        return metadata
    return metadata


def message_timestamp(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp


def attach_message_usage(session_id, messages):
    """Il costo del turno include i tool ed e' mostrato sull'ultima risposta."""
    turns = []
    for index, message in enumerate(messages):
        timestamp = message_timestamp(message["ts"])
        if message["role"] == "user" and timestamp is not None:
            turns.append((timestamp, index))
    if not turns:
        return
    if any(turns[index][0] < turns[index - 1][0] for index in range(1, len(turns))):
        app.logger.warning("Timestamp dei turni Copilot non ordinati: %s", session_id)
        return
    totals = {}
    timestamps = [turn[0] for turn in turns]
    uri = (CONFIG_DIR / "session-store.db").as_uri() + "?mode=ro"
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as usage_db:
            rows = usage_db.execute(
                "SELECT created_at, total_nano_aiu FROM assistant_usage_events "
                "WHERE session_id = ? AND total_nano_aiu IS NOT NULL",
                (session_id,),
            )
            for created_at, nano_aiu in rows:
                timestamp = message_timestamp(created_at)
                amount = nonnegative_number(nano_aiu)
                if timestamp is None or amount is None:
                    continue
                turn = bisect_right(timestamps, timestamp) - 1
                if turn >= 0:
                    totals[turn] = totals.get(turn, 0) + amount
    except sqlite3.Error as exc:
        app.logger.warning("Crediti per turno Copilot non leggibili: %s", exc)
        return
    for turn, nano_aiu in totals.items():
        start = turns[turn][1]
        end = turns[turn + 1][1] if turn + 1 < len(turns) else len(messages)
        bot = next((message for message in reversed(messages[start:end])
                    if message["role"] == "bot"), None)
        if bot is not None:
            bot["usage"] = {"ai_credits": nano_aiu / 1_000_000_000}


def latest_message_usage(session_id):
    chat = read_native_chat(session_id)
    if chat is None or not chat["messages"] or chat["messages"][-1]["role"] != "bot":
        return None
    return chat["messages"][-1].get("usage")


def mark_auto_model_response(db, chat_id, message_ts):
    if message_ts:
        db.execute(
            "INSERT OR IGNORE INTO auto_model_responses (chat_id, message_ts) "
            "VALUES (?, ?)",
            (chat_id, message_ts),
        )


def is_auto_model_response(db, chat_id, message_ts):
    if not message_ts:
        return False
    return db.execute(
        "SELECT 1 FROM auto_model_responses WHERE chat_id = ? AND message_ts = ?",
        (chat_id, message_ts),
    ).fetchone() is not None


def session_display_name(name):
    return name.removeprefix("webchat:").strip()


def read_native_chat(session_id, include_messages=True):
    if not valid_session_id(session_id):
        return None
    session_dir = SESSION_STATE_DIR / session_id
    if session_dir.resolve().parent != SESSION_STATE_DIR.resolve():
        return None
    events_path = session_dir / "events.jsonl"
    if not events_path.is_file():
        return None

    metadata = read_session_metadata(session_dir)
    name = metadata.get("name", "")

    messages = []
    first_user = None
    first_model = None
    last_message_at = None
    try:
        with events_path.open(encoding="utf-8") as events_file:
            for line in events_file:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    app.logger.warning("Evento sessione non valido: %s", events_path)
                    continue
                if not isinstance(event, dict):
                    continue
                event_data = event.get("data")
                if not isinstance(event_data, dict):
                    continue
                role = (
                    "user" if event.get("type") == "user.message"
                    else "bot" if event.get("type") == "assistant.message"
                    else None
                )
                content = event_data.get("content")
                if not role or not isinstance(content, str) or not content.strip():
                    continue
                if role == "user":
                    content = content.removesuffix(image_response_prompt("", session_id))
                timestamp = event.get("timestamp") or ""
                model = event_data.get("model") if role == "bot" else None
                if timestamp:
                    last_message_at = timestamp
                if role == "user" and first_user is None:
                    first_user = {
                        "content": content,
                        "ts": timestamp,
                    }
                if role == "bot" and first_model is None and isinstance(model, str):
                    first_model = model
                if include_messages:
                    messages.append({
                        "role": role,
                        "content": content,
                        "model": model,
                        "ts": timestamp,
                    })
    except (OSError, UnicodeDecodeError) as exc:
        app.logger.warning("Sessione non leggibile %s: %s", events_path, exc)
        return None

    if first_user is None:
        return None
    if include_messages:
        attach_message_usage(session_id, messages)
    try:
        modified_at = datetime.fromtimestamp(
            events_path.stat().st_mtime, timezone.utc
        ).isoformat()
    except OSError as exc:
        app.logger.warning("Impossibile leggere i metadati sessione %s: %s", events_path, exc)
        return None
    created_at = metadata.get("created_at") or first_user["ts"] or modified_at
    display_name = re.sub(r"\s+", " ", session_display_name(name)).strip()
    if not display_name or display_name == session_id:
        display_name = re.sub(r"\s+", " ", first_user["content"]).strip()[:60]
    return {
        "id": session_id,
        "title": display_name[:120] or "Senza titolo",
        "created_at": created_at,
        "last_message_at": last_message_at or created_at,
        "messages": messages,
        "first_model": first_model,
    }


def native_sessions():
    sessions = []
    if not SESSION_STATE_DIR.exists():
        return sessions
    try:
        session_dirs = list(SESSION_STATE_DIR.iterdir())
    except OSError as exc:
        app.logger.error("Impossibile leggere le sessioni Copilot: %s", exc)
        raise
    for session_dir in session_dirs:
        if not session_dir.is_dir():
            continue
        chat = read_native_chat(session_dir.name, include_messages=False)
        if chat:
            sessions.append(chat)
    sessions.sort(key=lambda chat: chat["created_at"], reverse=True)
    return sessions


def ensure_chat_import(db, chat):
    db.execute(
        "INSERT OR IGNORE INTO chats (id, title, created_at) VALUES (?, ?, ?)",
        (chat["id"], "Sessione Copilot", chat["created_at"]),
    )
    if chat["first_model"]:
        db.execute(
            "UPDATE chats SET model = COALESCE(model, ?) WHERE id = ?",
            (chat["first_model"], chat["id"]),
        )


def write_session_name(session_id, title):
    if not valid_session_id(session_id):
        return
    path = SESSION_STATE_DIR / session_id / "workspace.yaml"
    if not path.is_file():
        return
    lines = path.read_text().splitlines()
    name_value = re.sub(
        r"[\x7f-\x9f\u2028\u2029]",
        lambda match: f"\\u{ord(match[0]):04x}",
        json.dumps(title, ensure_ascii=False),
    )
    name_line = f"name: {name_value}"
    for index, line in enumerate(lines):
        if line.startswith("name:"):
            end = index + 1
            # Rimuove anche le continuazioni del precedente nome YAML multilinea.
            while end < len(lines) and (
                not lines[end].strip() or lines[end][0].isspace()
            ):
                end += 1
            lines[index:end] = [name_line]
            path.write_text("\n".join(lines) + "\n")
            return
    path.write_text(
        "\n".join([name_line, *lines]) + "\n"
    )


def valid_session_id(session_id):
    try:
        return str(uuid.UUID(session_id)) == session_id
    except (AttributeError, TypeError, ValueError):
        return False


def session_is_running(session_dir):
    for marker in session_dir.glob("inuse.*.lock"):
        match = re.fullmatch(r"inuse\.(\d+)\.lock", marker.name)
        if not match:
            continue
        try:
            os.kill(int(match.group(1)), 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            return True
        return True
    return False


class CopilotRunError(RuntimeError):
    def __init__(self, message, usage, status_code=500):
        super().__init__(message)
        self.usage = usage
        self.status_code = status_code


@app.before_request
def require_login():
    open_paths = {
        "/login", "/api/login", "/login.html", "/login.css", "/login.js",
        "/manifest.webmanifest", "/pwa.js", "/service-worker.js",
        "/icon-180.png", "/icon-192.png", "/icon-512.png",
        "/icon-maskable-512.png",
    }
    if request.path in open_paths:
        return None
    if session.get("authenticated"):
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "non autenticato"}), 401
    return app.send_static_file("login.html")


@app.before_request
def protect_chat_job():
    if not session.get("authenticated") or request.method != "POST":
        return None
    if request.path not in {
        "/api/chat/stream", "/api/chat/plan/approve",
        "/api/chat/plan/cancel",
    }:
        return None
    if service_restarting:
        return jsonify({"error": "servizio in riavvio, attendi prima di inviare"}), 503
    data = (request.get_json(silent=True) if request.is_json else request.form) or {}
    if data.get("async") in (True, "true"):
        job_id = data.get("request_id")
        if not valid_session_id(job_id):
            return jsonify({"error": "identificativo richiesta non valido"}), 400
        row = get_db().execute("SELECT chat_id FROM chat_jobs WHERE id = ?", (job_id,)).fetchone()
        if row:
            session["copilot_session_id"] = row["chat_id"]
            return jsonify({"job_id": job_id, "chat_id": row["chat_id"]}), 202
    chat_id = data.get("chat_id") or session.get("copilot_session_id")
    if chat_id and running_chat_job(chat_id):
        return jsonify({"error": "Copilot sta gia' elaborando questa chat",
                        "chat_id": chat_id}), 409


def running_chat_job(chat_id):
    row = get_db().execute(
        "SELECT id FROM chat_jobs WHERE chat_id = ? AND status = 'running'", (chat_id,)
    ).fetchone()
    if row:
        refresh_job(row["id"])
        return get_db().execute(
            "SELECT id FROM chat_jobs WHERE id = ? AND status = 'running'", (row["id"],)
        ).fetchone()
    return None


def refresh_job(job_id):
    db = get_db()
    row = db.execute("SELECT * FROM chat_jobs WHERE id = ?", (job_id,)).fetchone()
    if row and row["status"] == "running":
        try:
            os.kill(row["owner_pid"], 0)
        except ProcessLookupError:
            result = {"type": "error", "chat_id": row["chat_id"],
                      "error": "elaborazione interrotta dal riavvio del server; controlla la cronologia prima di riprovare"}
            app.logger.warning("Lavoro Copilot interrotto: %s", job_id)
            db.execute("UPDATE chat_jobs SET status = 'error', result = ? WHERE id = ?",
                       (json.dumps(result), job_id))
            db.commit()
            row = db.execute("SELECT * FROM chat_jobs WHERE id = ?", (job_id,)).fetchone()
        except PermissionError:
            pass
    return row


def cleanup_job_files(attachments, args):
    for attachment in attachments:
        attachment.unlink(missing_ok=True)
    if "--additional-mcp-config" in args:
        Path(args[args.index("--additional-mcp-config") + 1].removeprefix("@")).unlink(missing_ok=True)


def start_chat_job(data, chat_id, events, attachments=(), args=()):
    with SERVICE_RESTART_LOCK:
        if service_restarting:
            cleanup_job_files(attachments, args)
            return jsonify({"error": "servizio in riavvio, attendi prima di inviare"}), 503
        return create_chat_job(data, chat_id, events, attachments, args)


def create_chat_job(data, chat_id, events, attachments, args):
    job_id = data.get("request_id")
    db = get_db()
    try:
        db.execute(
            "INSERT INTO chat_jobs (id, chat_id, status, owner_pid) VALUES (?, ?, 'running', ?)",
            (job_id, chat_id, os.getpid()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        cleanup_job_files(attachments, args)
        existing = db.execute("SELECT chat_id FROM chat_jobs WHERE id = ?", (job_id,)).fetchone()
        if existing:
            return jsonify({"job_id": job_id, "chat_id": existing["chat_id"]}), 202
        return jsonify({"error": "Copilot sta gia' elaborando questa chat",
                        "chat_id": chat_id}), 409

    def work():
        with app.app_context():
            worker_db = get_db()
            progress = {"content": "", "tools": []}
            outcome = None
            try:
                for event in events():
                    if not event.startswith("data: "):
                        continue
                    payload = json.loads(event.removeprefix("data: ").strip())
                    kind = payload.get("type")
                    if kind in ("done", "error"):
                        outcome = payload
                    elif kind == "assistant.message.delta":
                        progress["content"] += payload.get("content") or ""
                    elif kind == "tool.execution_start":
                        progress["tools"] = (progress["tools"] + [payload])[-100:]
                    worker_db.execute("UPDATE chat_jobs SET progress = ? WHERE id = ?",
                                      (json.dumps(progress), job_id))
                    worker_db.commit()
                if outcome is None:
                    raise RuntimeError("nessuna risposta ricevuta da Copilot")
            except Exception:
                app.logger.exception("Errore nel lavoro Copilot %s", job_id)
                worker_db.rollback()
                outcome = {"type": "error", "chat_id": chat_id,
                           "error": "errore interno durante l'elaborazione di Copilot"}
            finally:
                cleanup_job_files(attachments, args)
            worker_db.execute(
                "UPDATE chat_jobs SET status = ?, result = ? WHERE id = ?",
                (outcome["type"], json.dumps(outcome), job_id),
            )
            worker_db.commit()

    worker = threading.Thread(target=work, name=f"copilot-{job_id}", daemon=True)
    try:
        worker.start()
    except RuntimeError:
        app.logger.exception("Impossibile avviare il lavoro Copilot")
        cleanup_job_files(attachments, args)
        db.execute("UPDATE chat_jobs SET status = 'error', result = ? WHERE id = ?",
                   (json.dumps({"type": "error", "chat_id": chat_id,
                                "error": "impossibile avviare Copilot"}), job_id))
        db.commit()
        return jsonify({"error": "impossibile avviare Copilot"}), 500
    return jsonify({"job_id": job_id, "chat_id": chat_id}), 202


@app.route("/api/chat/jobs/<job_id>")
def get_chat_job(job_id):
    row = refresh_job(job_id)
    if row is None:
        return jsonify({"error": "richiesta non trovata"}), 404
    return jsonify({"job_id": job_id, "chat_id": row["chat_id"],
                    "status": row["status"], "progress": json.loads(row["progress"]),
                    "result": json.loads(row["result"]) if row["result"] else None})


@app.errorhandler(500)
def handle_internal_error(error):
    app.logger.error("Errore interno nell'API: %s", error)
    if request.path.startswith("/api/"):
        return jsonify({"error": "errore interno del server"}), 500
    return error


def image_response_prompt(prompt, chat_id):
    image_dir = SESSION_STATE_DIR / chat_id / "files"
    return (
        prompt + "\n\n[Interfaccia webchat: puoi mostrare immagini con "
        "![descrizione](https://...). Per immagini locali create su richiesta, "
        f"salvale in {image_dir}/ (crea la directory se necessario) e usa "
        f"![descrizione](/api/chats/{chat_id}/images/nome-file.png). "
        "Formati locali supportati: PNG, JPEG, GIF, WebP, AVIF; non SVG. "
        "Codifica spazi e caratteri speciali nel percorso URL. "
        "Non usare percorsi locali o file:// nei messaggi. "
        "Non creare immagini se non richieste e rispetta i permessi disponibili.]"
    )


def chat_args(chat_id, is_new, model, permissions, attachments, tools, servers,
              plan, is_approval=False, working_directory=None):
    args = [COPILOT_BIN]
    if working_directory:
        args += ["-C", working_directory]
    args += ["--session-id" if is_new else "--resume", chat_id, "--model", model,
             "--no-ask-user"]
    if plan:
        args += ["--plan", "--deny-tool=shell", "--deny-tool=write", "--deny-tool=url",
                 "--disable-builtin-mcps"]
        if not permissions:
            args.append("--available-tools")
    else:
        if "all" in permissions:
            args += [PERMISSION_FLAGS["all"], "--mode", "interactive"]
        elif permissions:
            permissions = ["shell", "write"]
            for permission in permissions:
                args.append(PERMISSION_FLAGS[permission])
            args.extend(f"--allow-tool={tool}" for tool in tools)
        else:
            args += ["--available-tools", "--disable-builtin-mcps"]
        if servers and permissions:
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
        if is_approval and "all" not in permissions:
            args += ["--mode", "interactive"]
    for attachment in attachments:
        args += ["--attachment", str(attachment)]
    return args


def sse(event):
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def run_copilot_stream(args, prompt, chat_id, model, plan, attachments,
                       is_approval=False, auto_model=False):
    prompt = image_response_prompt(prompt, chat_id)
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
            reply, used_model, assistant_ts = None, None, None
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
                            timestamp = evt.get("timestamp")
                            if isinstance(timestamp, str) and timestamp:
                                assistant_ts = timestamp
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
            bot_ts = assistant_ts or datetime.now(timezone.utc).isoformat()
            if auto_model:
                mark_auto_model_response(db, chat_id, bot_ts)
            if plan:
                model_to_pin = used_model or (model if model != "auto" else None)
                db.execute(
                    "UPDATE chats SET pending_plan = '1', model = COALESCE(model, ?) "
                    "WHERE id = ?",
                    (model_to_pin, chat_id),
                )
            else:
                model_to_pin = used_model or (model if model != "auto" else None)
                if model_to_pin:
                    db.execute("UPDATE chats SET model = COALESCE(model, ?) WHERE id = ?",
                               (model_to_pin, chat_id))
                if is_approval:
                    db.execute("UPDATE chats SET pending_plan = NULL WHERE id = ?", (chat_id,))
            db.commit()
            yield sse({"type": "done", "reply": reply, "model": used_model,
                       "usage": usage, "chat_id": chat_id, "ts": bot_ts,
                       "auto_model": auto_model,
                       "message_usage": latest_message_usage(chat_id),
                       "pending_plan": plan})
    except (CopilotRunError, OSError, subprocess.SubprocessError) as exc:
        if not isinstance(exc, CopilotRunError):
            app.logger.error("Impossibile eseguire Copilot: %s", exc)
        usage = exc.usage if isinstance(exc, CopilotRunError) else None
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


@app.route("/api/chats/<chat_id>/images/<path:filename>")
def chat_image(chat_id, filename):
    if not valid_session_id(chat_id):
        return jsonify({"error": "sessione non valida"}), 400
    try:
        session_dir = (SESSION_STATE_DIR / chat_id).resolve()
        image_dir = (session_dir / "files").resolve()
        image_path = (image_dir / filename).resolve()
        if (session_dir != SESSION_STATE_DIR.resolve() / chat_id
                or image_dir != session_dir / "files"
                or not image_path.is_relative_to(image_dir)
                or not image_path.is_file()):
            return jsonify({"error": "immagine non trovata"}), 404
        content_type = IMAGE_TYPES.get(image_path.suffix.lower())
        if not content_type:
            return jsonify({"error": "formato immagine non supportato"}), 415
        response = send_file(image_path, mimetype=content_type, conditional=True)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return response
    except (OSError, RuntimeError) as exc:
        app.logger.error("Impossibile leggere l'immagine: %s", exc)
        return jsonify({"error": "impossibile leggere l'immagine"}), 500


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


@app.route("/api/service", methods=["GET"])
def service_status():
    return jsonify({"instance_id": SERVICE_INSTANCE_ID,
                    "restarting": service_restarting})


@app.route("/api/tls/ca")
def download_tls_ca():
    if not TLS_CA_CERT.is_file():
        return jsonify({"error": "certificato CA non disponibile; controlla i log del servizio"}), 503
    response = send_file(
        TLS_CA_CERT, mimetype="application/x-pem-file",
        as_attachment=True, download_name="copilot-webchat-ca.crt",
        conditional=False,
    )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/api/service/restart", methods=["POST"])
def restart_service():
    global service_restarting
    with SERVICE_RESTART_LOCK:
        if service_restarting:
            return jsonify({"error": "riavvio gia' in corso"}), 409
        db = get_db()
        running = db.execute(
            "SELECT id FROM chat_jobs WHERE status = 'running'"
        ).fetchall()
        if any(refresh_job(row["id"])["status"] == "running" for row in running):
            return jsonify({"error": "attendi che Copilot termini prima di riavviare"}), 409
        if SESSION_STATE_DIR.exists() and any(
            folder.is_dir() and session_is_running(folder)
            for folder in SESSION_STATE_DIR.iterdir()
        ):
            return jsonify({"error": "una sessione Copilot e' in uso; attendi prima di riavviare"}), 409
        try:
            result = subprocess.run(
                ["/usr/bin/systemctl", "show", "copilot-webchat.service",
                 "--property=MainPID,Restart"],
                capture_output=True, text=True, timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            app.logger.exception("Impossibile verificare il servizio systemd")
            return jsonify({"error": "impossibile verificare il servizio systemd"}), 503
        properties = dict(line.split("=", 1) for line in result.stdout.splitlines()
                          if "=" in line)
        if (result.returncode != 0
                or properties.get("MainPID") != str(os.getpid())
                or properties.get("Restart") not in {"always", "on-failure"}):
            app.logger.warning("Riavvio non disponibile: supervisione systemd non verificata")
            return jsonify({"error": "riavvio disponibile solo con copilot-webchat.service "
                            "e Restart=on-failure o always"}), 503
        # Esce dopo la risposta HTTP; systemd avvia una nuova istanza senza sudo.
        timer = threading.Timer(1.5, os._exit, args=(1,))
        timer.daemon = True
        service_restarting = True
        try:
            timer.start()
        except RuntimeError:
            service_restarting = False
            app.logger.exception("Impossibile programmare il riavvio")
            return jsonify({"error": "impossibile programmare il riavvio"}), 500
        app.logger.warning("Riavvio del servizio richiesto dalla webchat")
        return jsonify({"ok": True, "instance_id": SERVICE_INSTANCE_ID}), 202


@app.route("/api/chats", methods=["GET"])
def list_chats():
    db = get_db()
    native_chats = native_sessions()
    usage_by_session = read_cli_usage([chat["id"] for chat in native_chats])
    chats = []
    for native_chat in native_chats:
        ensure_chat_import(db, native_chat)
        row = db.execute(
            "SELECT permissions, model, pending_plan, mcp_servers, "
            "tool_permissions FROM chats WHERE id = ?",
            (native_chat["id"],),
        ).fetchone()
        chats.append({
            "id": native_chat["id"],
            "title": native_chat["title"],
            "created_at": native_chat["created_at"],
            "last_message_at": native_chat["last_message_at"],
            "permissions": json.loads(row["permissions"]),
            "model": row["model"],
            "usage": usage_by_session.get(native_chat["id"]),
            "pending_plan": bool(row["pending_plan"]),
            "mcp_servers": json.loads(row["mcp_servers"]),
            "tool_permissions": json.loads(row["tool_permissions"]),
        })
    db.commit()
    return jsonify(chats)


@app.route("/api/chats/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    native_chat = read_native_chat(chat_id)
    if native_chat is None:
        return jsonify({"error": "chat non trovata"}), 404
    db = get_db()
    ensure_chat_import(db, native_chat)
    chat_row = db.execute(
        "SELECT pending_plan FROM chats WHERE id = ?", (chat_id,)
    ).fetchone()
    messages = native_chat["messages"]
    auto_model_timestamps = {
        row["message_ts"] for row in db.execute(
            "SELECT message_ts FROM auto_model_responses WHERE chat_id = ?",
            (chat_id,),
        ).fetchall()
    }
    for message in messages:
        message["auto_model"] = (
            message["role"] != "user" and message["ts"] in auto_model_timestamps
        )
    if chat_row["pending_plan"]:
        last_bot = next(
            (index for index in range(len(messages) - 1, -1, -1)
             if messages[index]["role"] == "bot"),
            None,
        )
        if last_bot is not None:
            messages[last_bot]["role"] = "plan"
    db.commit()
    session["copilot_session_id"] = chat_id
    return jsonify(messages)


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
    native_chat = read_native_chat(chat_id, include_messages=False)
    if native_chat is None:
        return jsonify({"error": "chat non trovata"}), 404
    try:
        write_session_name(chat_id, title)
    except (OSError, UnicodeDecodeError) as exc:
        app.logger.error("Impossibile aggiornare il nome della sessione: %s", exc)
        return jsonify({"error": "impossibile aggiornare il nome della sessione"}), 500
    db = get_db()
    ensure_chat_import(db, native_chat)
    db.commit()
    return jsonify({"ok": True, "title": title})


@app.route("/api/chats/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    if running_chat_job(chat_id):
        return jsonify({"error": "sessione Copilot in uso"}), 409
    native_chat = read_native_chat(chat_id, include_messages=False)
    if native_chat is None:
        return jsonify({"error": "chat non trovata"}), 404
    db = get_db()
    session_path = SESSION_STATE_DIR / chat_id
    try:
        if session_path.resolve().parent != SESSION_STATE_DIR.resolve():
            return jsonify({"error": "percorso sessione non valido"}), 400
        if session_is_running(session_path):
            return jsonify({"error": "sessione Copilot in uso"}), 409
        shutil.rmtree(session_path)
    except OSError as exc:
        app.logger.error("Impossibile eliminare la sessione Copilot %s: %s", chat_id, exc)
        return jsonify({"error": "impossibile eliminare la sessione Copilot"}), 500
    db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    db.execute("DELETE FROM chat_jobs WHERE chat_id = ?", (chat_id,))
    db.execute("DELETE FROM auto_model_responses WHERE chat_id = ?", (chat_id,))
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


def list_skills_and_plugins():
    result = {}
    for key, command in (
        ("skills", "skill"), ("plugins", "plugin")
    ):
        try:
            output = subprocess.run([COPILOT_BIN, command, "list", "--json"],
                                    capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            app.logger.error("Impossibile elencare %s: %s", key, exc)
            return None, (jsonify({"error": "impossibile leggere skill e plugin"}), 500)
        if output.returncode:
            app.logger.error("Elenco %s fallito: %s", key, output.stderr)
            return None, (jsonify({"error": "impossibile leggere skill e plugin"}), 500)
        try:
            entries = json.loads(output.stdout)
            if not isinstance(entries, list):
                raise ValueError("formato inatteso")
            result[key] = [
                {"name": entry.get("name"), "description": entry.get("description", ""),
                 "source": entry.get("source", ""), "enabled": entry.get("enabled", True),
                 "removable": key == "skills" and entry.get("source") == "personal-copilot"}
                for entry in entries if isinstance(entry, dict) and isinstance(entry.get("name"), str)
            ]
        except ValueError as exc:
            app.logger.error("Elenco %s non valido: %s", key, exc)
            return None, (jsonify({"error": "formato skill e plugin non valido"}), 500)
    return result, None


@app.route("/api/skills")
def skills():
    result, error = list_skills_and_plugins()
    return error if error else jsonify(result)


@app.route("/api/skills/add", methods=["POST"])
def add_skill():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "richiesta non valida"}), 400
    source = data.get("source")
    if (
        not isinstance(source, str)
        or not source.strip()
        or len(source) > 2048
        or any(ord(char) < 32 or ord(char) == 127 for char in source)
    ):
        return jsonify({"error": "origine della skill non valida"}), 400

    source = source.strip()
    if source.startswith("https://"):
        try:
            parsed = urlparse(source)
            skill_path = parsed.path.lower()
            if (
                not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or not (skill_path.endswith("/skill.md") or skill_path == "skill.md")
                or parsed.fragment
            ):
                raise ValueError("URL skill non valido")
            parsed.port
        except ValueError:
            return jsonify({
                "error": "usa un URL HTTPS diretto a SKILL.md, senza credenziali o frammenti"
            }), 400
    elif source.startswith("~/"):
        source = os.path.expanduser(source)
    elif not os.path.isabs(source):
        return jsonify({
            "error": "per un file o una directory locale usa un percorso assoluto sul server"
        }), 400

    if not source.startswith("https://") and not os.path.isabs(source):
        return jsonify({"error": "percorso locale non valido"}), 400

    try:
        result = subprocess.run(
            [COPILOT_BIN, "skill", "add", source],
            capture_output=True, text=True, timeout=120,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        app.logger.error("Tempo scaduto durante l'aggiunta della skill")
        return jsonify({"error": "tempo scaduto durante l'aggiunta della skill"}), 504
    except (OSError, subprocess.SubprocessError):
        app.logger.exception("Impossibile avviare l'aggiunta della skill")
        return jsonify({"error": "impossibile avviare l'aggiunta della skill"}), 500
    if result.returncode:
        error = result.stderr.strip() or result.stdout.strip() or "Copilot non ha aggiunto la skill"
        app.logger.error("Comando Copilot skill add fallito (codice %s)", result.returncode)
        return jsonify({"error": error}), 500
    return jsonify({"ok": True})


@app.route("/api/skills/remove", methods=["POST"])
def remove_skill():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "richiesta non valida"}), 400
    name = data.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 512:
        return jsonify({"error": "nome skill non valido"}), 400

    entries, error = list_skills_and_plugins()
    if error:
        return error
    entry = next(
        (item for item in entries["skills"] if item["name"] == name), None
    )
    if entry is None:
        return jsonify({"error": "skill non trovata"}), 404
    if entry["source"] != "personal-copilot":
        return jsonify({
            "error": "si possono eliminare solo le skill del profilo personale"
        }), 403

    try:
        result = subprocess.run(
            [COPILOT_BIN, "skill", "remove", name],
            capture_output=True, text=True, timeout=30,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        app.logger.error("Tempo scaduto durante la rimozione della skill")
        return jsonify({"error": "tempo scaduto durante la rimozione della skill"}), 504
    except (OSError, subprocess.SubprocessError):
        app.logger.exception("Impossibile avviare la rimozione della skill")
        return jsonify({"error": "impossibile avviare la rimozione della skill"}), 500
    if result.returncode:
        error = result.stderr.strip() or result.stdout.strip() or "Copilot non ha rimosso la skill"
        app.logger.error("Comando Copilot skill remove fallito (codice %s)", result.returncode)
        return jsonify({"error": error}), 500

    updated, error = list_skills_and_plugins()
    if error:
        return error
    if any(item["name"] == name for item in updated["skills"]):
        app.logger.error("Copilot non ha rimosso la skill %s", name)
        return jsonify({"error": f"la skill {name} risulta ancora installata"}), 500
    return jsonify({"ok": True})


@app.route("/api/skills/state", methods=["PUT"])
def update_skill_or_plugin_state():
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    name = data.get("name")
    enabled = data.get("enabled")
    if (
        not isinstance(kind, str)
        or kind not in {"skills", "plugins"}
        or not isinstance(name, str)
        or not name.strip()
        or len(name) > 512
        or not isinstance(enabled, bool)
    ):
        return jsonify({"error": "skill, plugin o stato non valido"}), 400

    entries, error = list_skills_and_plugins()
    if error:
        return error
    entry = next(
        (item for item in entries[kind] if item["name"] == name), None
    )
    if entry is None:
        return jsonify({"error": "skill o plugin non trovato"}), 404
    if entry["enabled"] is enabled:
        return jsonify({"ok": True, "enabled": enabled})

    command = "skill" if kind == "skills" else "plugin"
    action = "enable" if enabled else "disable"
    try:
        result = subprocess.run(
            [COPILOT_BIN, command, action, name],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        app.logger.exception("Impossibile %s %s %s", action, command, name)
        return jsonify({"error": f"impossibile {action} {command}"}), 500
    if result.returncode:
        app.logger.error(
            "Comando Copilot %s %s fallito: %s",
            action, command, result.stderr.strip(),
        )
        return jsonify({
            "error": result.stderr.strip() or f"impossibile {action} {command}"
        }), 500

    updated, error = list_skills_and_plugins()
    if error:
        return error
    updated_entry = next(
        (item for item in updated[kind] if item["name"] == name), None
    )
    if updated_entry is None or updated_entry["enabled"] is not enabled:
        app.logger.error(
            "Copilot non ha applicato lo stato %s a %s %s",
            enabled, command, name,
        )
        return jsonify({"error": f"Copilot non ha aggiornato lo stato di {name}"}), 500
    return jsonify({"ok": True, "enabled": enabled})


@app.route("/api/chat/stream", methods=["POST"])
def chat_stream():
    data = request.form
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
        return jsonify({"error": "impostazioni chat non valide"}), 400
    if (not isinstance(selected_servers, list) or len(selected_servers) > 20
            or any(not isinstance(server, str) for server in selected_servers)
            or len(set(selected_servers)) != len(selected_servers)
            or valid_tool_permissions(requested_tools) is None):
        return jsonify({"error": "impostazioni chat non valide"}), 400
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
    chat_id = data.get("chat_id") or session.get("copilot_session_id")
    if chat_id and not valid_session_id(chat_id):
        for path in attachments:
            path.unlink(missing_ok=True)
        return jsonify({"error": "sessione non valida"}), 400
    if not chat_id:
        chat_id = str(uuid.uuid4())
    session["copilot_session_id"] = chat_id
    is_new = not (SESSION_STATE_DIR / chat_id).is_dir()
    row = db.execute("SELECT model, pending_plan, tool_permissions, mcp_servers, "
                     "working_directory FROM chats WHERE id = ?",
                     (chat_id,)).fetchone()
    model = row["model"] or model if row else model
    working_directory = (row["working_directory"] if row else
                         str(Path.cwd()) if is_new else None)
    if row and row["pending_plan"]:
        for path in attachments:
            path.unlink(missing_ok=True)
        return jsonify({"error": "approva o annulla il piano prima di inviare"}), 409
    if row and "mcp_servers" not in data:
        selected_servers = json.loads(row["mcp_servers"])
    if row and "tool_permissions" not in data:
        requested_tools = json.loads(row["tool_permissions"])
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        "INSERT OR IGNORE INTO chats "
        "(id, title, created_at, permissions, working_directory) VALUES (?, ?, ?, ?, ?)",
        (chat_id, "Sessione Copilot", now, json.dumps(permissions), working_directory),
    )
    db.execute("UPDATE chats SET permissions = ?, mcp_servers = ?, tool_permissions = ? WHERE id = ?",
               (json.dumps(permissions), json.dumps(selected_servers),
                json.dumps(requested_tools), chat_id))
    try:
        args = chat_args(chat_id, is_new or row is None,
                             model,
                             permissions, copilot_attachments, requested_tools,
                             selected_mcp_servers(db, chat_id), plan,
                             working_directory=working_directory)
    except OSError as exc:
        for path in attachments:
            path.unlink(missing_ok=True)
        app.logger.error("Impossibile preparare Copilot: %s", exc)
        return jsonify({"error": "impossibile preparare Copilot"}), 500
    db.commit()
    prompt = message or "Analizza i file allegati."
    prompt += "".join(text_attachments)
    if plan:
        prompt += "\n\nPrepara solo un piano; non modificare file e non eseguire comandi."
    def stream_with_chat():
        # I metadati sono persistiti; il contenuto apparirà dalla sessione nativa.
        yield sse({"type": "chat_created", "chat_id": chat_id,
                   "title": message[:60] or "File allegato"})
        yield from run_copilot_stream(
            args, prompt, chat_id, model, plan, attachments,
            auto_model=model == "auto",
        )

    if data.get("async") == "true":
        return start_chat_job(data, chat_id, stream_with_chat, attachments, args)
    stream = stream_with_chat()
    return Response(stream_with_context(stream), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/chat/plan/approve", methods=["POST"])
def approve_plan():
    data = request.get_json(silent=True) or {}
    chat_id = data.get("chat_id") or session.get("copilot_session_id")
    db = get_db()
    row = (db.execute("SELECT model, permissions, pending_plan, tool_permissions, "
                      "working_directory "
                      "FROM chats WHERE id = ?", (chat_id,)).fetchone() if chat_id else None)
    if not row or not row["pending_plan"]:
        return jsonify({"error": "nessun piano in attesa"}), 409
    model = row["model"] or "auto"
    native_chat = read_native_chat(chat_id)
    if native_chat is None:
        return jsonify({"error": "chat non trovata"}), 404
    plan_ts = next(
        (message["ts"] for message in reversed(native_chat["messages"])
         if message["role"] == "bot"),
        None,
    )
    auto_model = is_auto_model_response(db, chat_id, plan_ts)
    now = datetime.now(timezone.utc).isoformat()
    prompt = "Approvo il piano proposto. Procedi con l'implementazione."
    args = chat_args(chat_id, False, model, json.loads(row["permissions"]), [],
                         json.loads(row["tool_permissions"]),
                         selected_mcp_servers(db, chat_id), False, is_approval=True,
                         working_directory=row["working_directory"])
    if data.get("async") is True:
        return start_chat_job(
            data, chat_id,
            lambda: run_copilot_stream(args, prompt, chat_id, model, False, [],
                                       is_approval=True, auto_model=auto_model),
            args=args,
        )
    outcome = None
    for event in run_copilot_stream(
        args, prompt, chat_id, model, False, [],
        is_approval=True, auto_model=auto_model,
    ):
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
    if not isinstance(data, dict):
        return jsonify({"error": "comando non valido"}), 400
    text = data.get("command")
    if not isinstance(text, str):
        return jsonify({"error": "comando non valido"}), 400
    parts = text.strip().split(maxsplit=1)
    if not parts:
        return jsonify({"error": "comando non valido"}), 400
    db = get_db()
    chat_id = session.get("copilot_session_id")
    if parts[0] == "/cwd":
        requested_chat_id = data.get("chat_id", chat_id)
        if requested_chat_id is not None and (
                not valid_session_id(requested_chat_id)
                or requested_chat_id != chat_id):
            return jsonify({"error": "chat non valida o non selezionata"}), 400
        target_chat_id = requested_chat_id
        row = (db.execute("SELECT working_directory FROM chats WHERE id = ?",
                          (target_chat_id,)).fetchone() if target_chat_id else None)
        native_chat = None
        if target_chat_id and not row:
            native_chat = read_native_chat(target_chat_id, include_messages=False)
            if native_chat:
                ensure_chat_import(db, native_chat)
                row = db.execute(
                    "SELECT working_directory FROM chats WHERE id = ?",
                    (target_chat_id,),
                ).fetchone()
        metadata_cwd = (
            read_session_metadata(SESSION_STATE_DIR / target_chat_id).get("cwd")
            if target_chat_id and (SESSION_STATE_DIR / target_chat_id).is_dir() else None
        )
        current_directory = (
            row["working_directory"] if row and row["working_directory"]
            else metadata_cwd or str(Path.cwd())
        )
        if len(parts) == 1:
            return jsonify({"reply": f"Directory corrente: {current_directory}",
                            "cwd": current_directory})
        if not target_chat_id:
            return jsonify({"error": "crea o seleziona una chat per cambiare directory"}), 409
        requested_directory = parts[1].strip()
        if len(requested_directory) > 4096 or "\x00" in requested_directory:
            return jsonify({"error": "directory non valida"}), 400
        requested_path = Path(requested_directory).expanduser()
        if not requested_path.is_absolute():
            requested_path = Path(current_directory) / requested_path
        try:
            resolved_directory = requested_path.resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return jsonify({"error": "directory non trovata o non accessibile"}), 400
        if not resolved_directory.is_dir():
            return jsonify({"error": "il percorso indicato non e' una directory"}), 400
        now = datetime.now(timezone.utc).isoformat()
        db.execute(
            "INSERT OR IGNORE INTO chats "
            "(id, title, created_at, working_directory) VALUES (?, ?, ?, ?)",
            (target_chat_id, "Sessione Copilot", now, str(resolved_directory)),
        )
        db.execute("UPDATE chats SET working_directory = ? WHERE id = ?",
                   (str(resolved_directory), target_chat_id))
        db.commit()
        return jsonify({"reply": f"Directory impostata: {resolved_directory}",
                        "cwd": str(resolved_directory)})
    if parts[0] == "/model" and len(parts) == 1:
        try:
            result = subprocess.run(
                [COPILOT_BIN, "completion", "bash"],
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            app.logger.error("Impossibile leggere i modelli di Copilot: %s", exc)
            return jsonify({"error": "impossibile caricare i modelli di Copilot"}), 503
        if result.returncode != 0:
            app.logger.error(
                "Elenco modelli CLI non disponibile: %s",
                (result.stderr or result.stdout).strip(),
            )
            return jsonify({"error": "impossibile caricare i modelli di Copilot"}), 503
        match = re.search(
            r'--model\)\s*COMPREPLY=\(\$\(compgen -W "([^"]+)" --',
            result.stdout,
        )
        if not match:
            app.logger.error("Formato completamento modelli CLI non riconosciuto")
            return jsonify({"error": "impossibile leggere l'elenco modelli di Copilot"}), 503
        models = list(dict.fromkeys(
            model for model in match.group(1).split()
            if re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model)
        ))
        if "auto" not in models:
            models.insert(0, "auto")
        if len(models) == 1:
            app.logger.error("Elenco modelli CLI vuoto")
            return jsonify({"error": "elenco modelli di Copilot vuoto"}), 503
        return jsonify({"reply": "Modelli caricati", "models": models})
    if parts[0] == "/model" and len(parts) == 2:
        model = parts[1].strip()
        if not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model):
            return jsonify({"error": "modello non valido"}), 400
        if chat_id:
            result = db.execute("UPDATE chats SET model = ? WHERE id = ?", (model, chat_id))
            if not result.rowcount:
                return jsonify({"error": "chat non trovata"}), 404
            db.commit()
        return jsonify({"reply": f"Modello impostato: {model}", "model": model})
    if parts[0] == "/help" and len(parts) == 1:
        return jsonify({"reply": "Comandi disponibili: /help, /usage, /cwd [directory], "
                        "/model <modello>, "
                        "/chronicle standup|tips|cost-tips|search <termine>|improve"})
    if parts[0] == "/usage" and len(parts) == 1:
        usage = read_cli_usage([chat_id]).get(chat_id) if chat_id else None
        return jsonify({"reply": "Utilizzo non disponibile" if usage is None else
                        "Utilizzo corrente della chat", "usage": usage})
    return jsonify({"error": "comando non supportato"}), 400


@app.route("/api/new-chat", methods=["POST"])
def new_chat():
    chat_id = str(uuid.uuid4())
    session["copilot_session_id"] = chat_id
    return jsonify({"ok": True, "chat_id": chat_id})


if __name__ == "__main__":
    start_https_listener()
    app.run(host="0.0.0.0", port=7890)
