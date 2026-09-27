# Copilot instructions for copilot-webchat

Small single-file Flask app: a private web chat UI that wraps the GitHub
Copilot CLI (`copilot -p ...`) for personal use on a Raspberry Pi, reachable
only via Tailscale. No frontend build step, no test suite, no linter
configured in this repo.

## Running

```bash
pip install flask
python3 app.py            # serves on 0.0.0.0:7890
```

There is no reload/watch mode; restart the process after editing `app.py`.
Auth requires `~/.copilot/webchat_auth` to contain a `werkzeug` password hash
(see README "Configurazione iniziale"); without it, login always fails.

## Architecture

- `app.py` — entire Flask backend in one file:
  - Serves `static/` as the app (`index.html`, `login.html`, CSS/JS) via
    `static_folder`/`send_static_file`; there is no template engine.
  - `@app.before_request` (`require_login`) gatekeeps every route except a
    small `open_paths` allowlist (login page/assets); unauthenticated API
    calls get `401 json`, unauthenticated page loads get `login.html`.
  - Persistent state lives outside the repo in `~/.copilot/`:
    `webchat_auth` (password hash), `webchat_secret` (Flask session key,
    generated on first run), `webchat.db` (SQLite chats/messages).
  - `init_db()` runs at import time and does soft migrations (e.g. checks
    `PRAGMA table_info` before `ALTER TABLE ADD COLUMN`) instead of using a
    migration framework — follow that pattern for schema changes.
  - Each browser session maps 1:1 to a Copilot CLI session: the Flask
    `session["copilot_session_id"]` (a uuid4) is passed as `--session-id`
    (new chat) or `--resume` (continuing chat) to the `copilot` binary, so
    conversation continuity is delegated entirely to the CLI, not
    reconstructed from the SQLite history.
  - `run_copilot()` shells out via `subprocess.run([COPILOT_BIN, ...])` with
    `--output-format json` and parses newline-delimited JSON events, pulling
    the reply from the `assistant.message` event's `data.content`/`data.model`.
    Model is always `"auto"`; the actual model used is returned by the CLI
    and stored per-message.
  - `COPILOT_BIN` is a hardcoded absolute path
    (`/home/linuxbrew/.linuxbrew/bin/copilot`) — update it if the CLI is
    installed elsewhere. `TIMEOUT_SECONDS = 300` bounds each CLI call.
- `static/app.js` — vanilla JS, no framework/bundler. Talks to the backend
  only through `fetch()` against the `/api/*` JSON endpoints; a `401` on
  `/api/chat` redirects the browser to `/login.html`.

## Conventions

- Code comments and README are written in Italian; keep new comments/user
  facing strings consistent with that (error messages returned by the API
  are Italian, e.g. `"messaggio vuoto"`, `"non autenticato"`).
- API errors are always `{"error": "..."}` JSON with a non-2xx status, not
  HTML error pages.
- SQLite access goes through `get_db()`/`close_db()` (per-request connection
  stored on Flask's `g`), not ad-hoc `sqlite3.connect()` calls in routes.
