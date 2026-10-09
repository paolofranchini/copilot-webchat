# Istruzioni Copilot per copilot-webchat

Webchat Flask privata per GitHub Copilot CLI, usata personalmente su Raspberry
Pi e raggiungibile tramite Tailscale. Il backend è concentrato in `app.py`;
frontend vanilla in `static/`, senza framework o bundler.

## Avvio e verifiche

```bash
pip install flask
python3 app.py
```

L'app serve su `0.0.0.0:7890`. Dopo modifiche al backend, per applicarle dire
all'utente: «Vai in Impostazioni e seleziona Riavvia servizio». L'autenticazione richiede
`~/.copilot/webchat_auth` con un hash password Werkzeug; vedere la sezione
"Configurazione iniziale" del README.

La suite Python usa `unittest`:

```bash
python3 -m unittest discover -s tests
```

Per modifiche al frontend controllare anche `node --check static/app.js`;
prima di concludere eseguire `git diff --check`. Non dichiarare verifiche che
non sono state eseguite. Per modifiche visuali o specifiche di browser/mobile,
distinguere i controlli automatici dalla prova che deve essere fatta nel
browser reale.

## Architettura

- `app.py` contiene backend, route e accesso SQLite. `init_db()` viene eseguita
  all'import e applica migrazioni incrementali senza framework: per nuove
  colonne seguire il controllo esistente con `PRAGMA table_info`.
- `@app.before_request` (`require_login`) protegge tutte le route tranne le
  pagine e risorse necessarie al login. Le API non autenticate rispondono con
  `401` JSON; le pagine mostrano `login.html`.
- Il frontend invia i messaggi a `POST /api/chat/stream`. Il backend avvia
  Copilot CLI in streaming; i lavori asincroni e il loro stato temporaneo
  usano la tabella SQLite `chat_jobs`. La cronologia conversazionale viene
  letta dai file nativi `events.jsonl` in `~/.copilot/session-state`, non da
  una tabella SQLite `messages` (rimossa dalla migrazione).
- `~/.copilot/webchat.db` conserva impostazioni associate alle chat e stato dei
  lavori e metadati delle risposte che non appartengono alla cronologia nativa
  (per esempio la provenienza Auto del modello); non conserva il testo della
  cronologia. Non ripristinare la vecchia tabella `messages`: la storia continua
  a essere letta dai file nativi Copilot. La provenienza Auto del modello deve
  essere salvata in SQLite e non in `localStorage` o nella sessione browser.
  Usa `get_db()`/`close_db()` per l'accesso SQLite nelle route.
- Ogni sessione browser usa un ID Copilot passato come `--session-id` per una
  sessione nuova o `--resume` per riprenderla. La scansione delle sessioni
  native può includere sessioni create da altri processi Copilot, incluse
  sessioni figlie: non assumere che ogni sessione trovata sia stata avviata
  dalla webchat.
- La chiave Flask persistente è `~/.copilot/webchat_secret`; altri dati e
  allegati sono in `~/.copilot/`. Non spostare dati persistenti nel repository.
- `COPILOT_BIN` è attualmente il percorso assoluto
  `/home/linuxbrew/.linuxbrew/bin/copilot`; `TIMEOUT_SECONDS = 300` limita
  l'esecuzione CLI. Verificare il percorso e le opzioni disponibili prima di
  modificarli.
- `static/index.html`, `static/app.js` e `static/style.css` implementano la UI
  senza template engine. `app.js` comunica col backend tramite `fetch()` e API
  JSON; le risposte di chat usano il flusso streaming e il polling dei lavori.

## Regole per le modifiche

- Prima di intervenire, controllare il codice e le istruzioni interessate: non
  fare affidamento su descrizioni d'architettura che potrebbero essere
  superate. Aggiornare README e queste istruzioni quando una modifica cambia
  direttamente il comportamento o i comandi documentati.
- Rispettare il perimetro richiesto. Per richieste circoscritte, modificare
  solo gli elementi nominati, preservando controlli e comportamenti vicini;
  non cogliere l'occasione per rimuovere o rifattorizzare altro.
- Per screenshot, verificare il dettaglio indicato (testo, simbolo, area) nel
  codice o nei dati prima di concludere cosa rappresenta. Separare chiaramente
  i fatti osservati dalle ipotesi.
- Prima di aggiungere un comando o una funzionalità specifica di Copilot CLI,
  controllare `copilot --help` e la documentazione ufficiale aggiornata.
  Specificare se il comportamento è nativo, tradotto dalla webchat in un
  prompt o non supportato; non presentare un'emulazione come esecuzione nativa.
- Preferire cambiamenti piccoli e coerenti con le convenzioni già presenti.
  Aggiungere o aggiornare test per il comportamento modificato ed eseguire i
  test pertinenti; usare l'intera suite se la modifica attraversa più aree.
- Non eseguire `git commit` o `git push` senza richiesta esplicita dell'utente.
  Non ripristinare né sovrascrivere modifiche preesistenti nel worktree.

## Convenzioni

- Commenti, README e testi rivolti all'utente sono in italiano. Gli errori API
  sono JSON del tipo `{"error": "..."}` con status non-2xx, non pagine HTML.
- Conservare pattern di error handling e validazione esistenti; non nascondere
  errori con fallback silenziosi.
- Gli accessi SQLite delle route passano da `get_db()` e `close_db()` (la
  connessione per richiesta è conservata in Flask `g`), non da connessioni
  ad-hoc.
