# Copilot CLI Webchat @ raspberrypi

Una piccola chat web privata per [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli), pensata per essere usata su un Raspberry Pi e raggiunta solo tramite la propria rete [Tailscale](https://tailscale.com/).

In pratica: un chatbot personale con la potenza di Copilot CLI, accessibile da browser (desktop o mobile) invece che solo da terminale.

## Caratteristiche

- **Interfaccia chat** semplice, scura, responsive (sidebar collassabile su mobile).
- **Login con sola password** (nessun nome utente), hash salvato con `scrypt`.
- **Cronologia conversazioni** persistente su SQLite: ogni chat è riprendibile in qualsiasi momento.
- **Gestione chat**: ogni conversazione può essere eliminata dalla sidebar.
- **Continuità di contesto**: ogni conversazione richiama `copilot --resume` sullo stesso `session-id`, così Copilot ricorda lo storico dei messaggi precedenti.
- **Modello scelto all'inizio**: il modello si seleziona dalla sidebar; le richieste successive riprendono la sessione senza forzare un nuovo modello, mostrato come etichetta sotto ogni risposta.
- **Autorizzazioni chat**: nella sidebar puoi autorizzare separatamente l'esecuzione di comandi e la modifica di file per tutta la chat, oppure usare "Consenti tutto" (`--allow-all`); gli strumenti non selezionati vengono negati esplicitamente.
- **Leggero**: Flask + SQLite, nessuna build/frontend framework, adatto a girare su un Raspberry Pi.

## Requisiti

- Python 3.10+ con Flask installato (`pip install flask`).
- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli) installata e autenticata sulla stessa macchina.
- (Consigliato) una rete privata come Tailscale per esporre il servizio solo ai propri dispositivi.

## Struttura del progetto

```
copilot-webchat/
├── app.py              # backend Flask: login, API chat, cronologia SQLite
└── static/
    ├── index.html      # pagina principale della chat
    ├── login.html       # pagina di login
    ├── style.css        # stile chat
    ├── login.css         # stile login
    └── app.js            # logica frontend (invio messaggi, cronologia, sidebar)
```

Dati d'esecuzione (non versionati, salvati fuori dal repo in `~/.copilot/`):

- `webchat_auth` — hash della password di accesso.
- `webchat_secret` — chiave segreta per firmare i cookie di sessione Flask.
- `webchat.db` — database SQLite con l'elenco delle chat e i messaggi.

## Configurazione iniziale

1. Genera l'hash della password che vuoi usare per il login:

   ```bash
   python3 -c "from werkzeug.security import generate_password_hash; print(generate_password_hash('LA_TUA_PASSWORD'))"
   ```

2. Salva l'output in `~/.copilot/webchat_auth`:

   ```bash
   mkdir -p ~/.copilot
   echo 'HASH_GENERATO' > ~/.copilot/webchat_auth
   chmod 600 ~/.copilot/webchat_auth
   ```

3. Verifica il percorso del binario `copilot` e, se diverso, aggiorna la costante `COPILOT_BIN` in `app.py`:

   ```bash
   which copilot
   ```

## Avvio

In locale, per test:

```bash
cd copilot-webchat
python3 app.py
```

Il servizio si mette in ascolto su `http://0.0.0.0:7890`.

### Come servizio systemd (avvio automatico, riavvio in caso di crash)

Esempio di unit file (`/etc/systemd/system/copilot-webchat.service`):

```ini
[Unit]
Description=Copilot CLI Web Chat (privato, uso via Tailscale)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<tuo-utente>
WorkingDirectory=/percorso/a/copilot-webchat
ExecStart=/usr/bin/python3 /percorso/a/copilot-webchat/app.py
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now copilot-webchat.service
```

## Utilizzo

1. Apri `http://<ip-tailscale-o-locale>:7890` da un dispositivo connesso alla tua rete privata.
2. Inserisci la password configurata.
3. Seleziona il modello e le autorizzazioni dalla sidebar, poi scrivi un messaggio: la prima richiesta userà `copilot -p --model <modello>`; le successive useranno `--resume` senza sovrascrivere il modello. Le autorizzazioni restano associate alla chat. "Consenti tutto" equivale a `--allow-all` (anche noto come modalità `/yolo`).
4. Usa "＋ Nuova chat" per iniziare una conversazione pulita, seleziona una chat precedente per riprenderla o usa il cestino per eliminarla.

## Sicurezza

- Per ogni chat puoi concedere separatamente `--allow-tool=shell` (comandi) e `--allow-tool=write` (modifica file), oppure `--allow-all` (tutte le autorizzazioni). Gli strumenti non selezionati ricevono rispettivamente `--deny-tool=shell` e `--deny-tool=write`; se non selezioni nulla, entrambi sono negati. L'autorizzazione `shell` resta potente: i comandi eseguiti possono modificare file anche quando lo strumento `write` è negato.
- **Non esporre questo servizio su internet pubblico** senza aggiungere ulteriori misure di sicurezza (reverse proxy con TLS, rate limiting, ecc.). È pensato per essere raggiunto solo tramite una rete privata come Tailscale.
- La password è salvata solo come hash (`scrypt`), mai in chiaro.
