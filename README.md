# Copilot CLI Webchat @ raspberrypi

Una piccola chat web privata per [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli), pensata per essere usata su un Raspberry Pi e raggiunta solo tramite la propria rete [Tailscale](https://tailscale.com/).

In pratica: un chatbot personale con la potenza di Copilot CLI, accessibile da browser (desktop o mobile) invece che solo da terminale.

## Caratteristiche

- **Interfaccia chat** semplice, scura, responsive (sidebar collassabile su mobile).
- **Login con sola password** (nessun nome utente), hash salvato con `scrypt`.
- **Cronologia conversazioni** letta dai file nativi delle sessioni Copilot; le stesse sessioni sono accessibili sia dalla CLI sia dalla webchat.
- **Gestione sessioni**: ogni sessione Copilot può essere rinominata o eliminata definitivamente dalla sidebar.
- **Continuità di contesto**: ogni conversazione richiama `copilot --resume` sullo stesso `session-id`, così Copilot ricorda lo storico dei messaggi precedenti.
- **Modello per chat**: il modello si seleziona dalla sidebar; su una chat aperta la scelta equivale a `/model <modello>` e vale per i turni successivi. Per una chat nuova viene usato come modello iniziale.
- **Crediti per sessione**: il totale AIU viene letto dal database nativo di Copilot CLI e mostrato nell'area di composizione della chat.
- **Modalità chat**: Ask non espone strumenti, Edit abilita comandi e modifica file, Agent concede tutti i permessi mantenendo la modalità interattiva della CLI. La scelta è associata alla chat.
- **File allegati**: il pulsante `+` apre un'area per selezionare o trascinare file (fino a 5 file da 10 MB ciascuno per messaggio). Immagini e documenti nativi vengono passati a Copilot come allegati; i file testuali comuni vengono inseriti direttamente nel prompt.
- **Leggero**: Flask + SQLite, nessuna build/frontend framework, adatto a girare su un Raspberry Pi.

## Modalità avanzata (sperimentale)

Premi **Impostazioni** sotto «Nuova chat» per aprire la schermata dedicata
nell'area principale; scegli una chat dalla sidebar o premi «Nuova chat» per
tornare ai messaggi. La schermata riunisce l'interruttore **Modalità avanzata**
nella sezione Generali, il modello e la modalità chat (disponibili anche
nella sidebar), le opzioni per la chat selezionata e la gestione dei server MCP e delle
skill/plugin. Modello e autorizzazioni sono sincronizzati tra le due posizioni.
La modalità avanzata è salvata nel `localStorage` del browser; di default
è spenta e la chat normale continua a usare `POST /api/chat` senza nuovi
flag. Le impostazioni delle singole chat sono salvate nel database.

- **Streaming**: la chat avanzata legge gli eventi JSONL della CLI durante l'esecuzione
  tramite `POST /api/chat/stream` (SSE) e mostra l'attività dei tool. Se la CLI non
  emette delta testuali, la risposta compare al termine; un'interruzione a metà
  **non** ritenta automaticamente il prompt, per non eseguire due volte la richiesta.
  Timeout e disconnessione terminano il processo.
- **Piano**: `--plan` produce un piano senza autorizzare shell, scrittura o URL.
  L'utente può approvarlo o annullarlo; l'approvazione riprende la stessa sessione
  CLI con i permessi della chat. Finché il piano è in attesa, non è possibile inviare
  altri messaggi in modalità avanzata.
- **Server MCP locali**: è possibile registrare un comando con percorso assoluto,
  argomenti e variabili d'ambiente, abilitarlo globalmente e selezionarlo per chat.
  Viene passato alla CLI con `--additional-mcp-config` tramite un file temporaneo
  privato, cancellato alla fine. La configurazione (incluse le variabili) resta in
  `~/.copilot/webchat.db`: non inserire segreti se altri utenti possono leggere il DB.
  I server già configurati direttamente nella CLI restano soggetti alle sue impostazioni
  globali; la selezione per chat riguarda solo i server creati nella webchat.
- **Skill e plugin**: elenco in sola lettura tramite `copilot skill list --json` e
  `copilot plugin list --json`. La CLI installata non offre un flag di selezione
  delle skill per singola invocazione; non è possibile abilitarle per chat dalla UI.
- **Comandi**: `/help` e `/usage` (in modalità avanzata) e `/model <modello>` sono
  gestiti dalla webchat, non inviati arbitrariamente alla CLI. Il selettore applica
  `/model` alla chat aperta anche senza modalità avanzata. I permessi avanzati possono autorizzare pattern
  puntuali come `shell(git status)` o `url(github.com)`, oltre ai permessi esistenti.
  La CLI non espone un canale di approvazione bidirezionale affidabile in modalità
  `-p`: le richieste di conferma per singola azione **non** sono disponibili.
- **Allegati**: screenshot tramite condivisione schermo e dettatura tramite le API
  del browser (se supportate). La dettatura compila il campo di testo, senza inviare
  l'audio al backend. Queste API potrebbero richiedere **HTTPS** o `localhost`;
  una pagina HTTP raggiunta tramite IP Tailscale potrebbe non poterle usare.

Le opzioni sono state verificate con la CLI installata (versione 1.0.88);
ricontrolla `copilot --help` dopo gli aggiornamenti per eventuali cambiamenti.
Le autorizzazioni `shell` e gli strumenti MCP locali possono eseguire operazioni
potenti: abilitali solo per configurazioni fidate.

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
- `webchat.db` — impostazioni specifiche della webchat associate agli ID di sessione (modello, autorizzazioni e server MCP). Non contiene la cronologia né i crediti.
- `session-state/` — sessioni native Copilot, inclusi eventi e cronologia delle conversazioni.

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
3. Seleziona il modello e la modalità dalla sidebar, poi scrivi un messaggio. Su una chat aperta cambiare modello applica subito `/model <modello>` alla chat e influisce sui turni successivi; quando non è selezionata una chat, la scelta diventa il modello iniziale per la prossima chat. Il modello usato viene mostrato sotto ogni risposta. La modalità resta associata alla chat. **Ask** non espone tool; **Edit** abilita shell e scrittura; **Agent** usa `--allow-all` mantenendo `--mode interactive`. Usa il pulsante `+` vicino al campo di testo per allegare qualsiasi tipo di file.
4. Usa "＋ Nuova chat" per iniziare una conversazione pulita, seleziona una chat precedente per riprenderla, l'icona matita per rinominarla o il cestino per eliminarla.
5. L'utilizzo crediti viene aggiornato dopo ogni esecuzione della CLI; le chat senza statistiche disponibili mostrano "Utilizzo crediti non disponibile".

La sidebar legge le sessioni native Copilot, indipendentemente da come sono state create. Puoi iniziare una chat nella webchat e riprenderla dalla CLI, o viceversa; i nomi legacy che iniziano con `webchat:` vengono mostrati senza prefisso. **Elimina** rimuove l'intera directory della sessione Copilot e i relativi metadati webchat dal database, quindi la cronologia non è recuperabile. Le sessioni attualmente in uso dalla CLI non possono essere eliminate.

## Sicurezza

- **Ask** limita la CLI a nessuno strumento; **Edit** abilita `--allow-tool=shell` e `--allow-tool=write`; **Agent** usa `--allow-all` in modalità interattiva, non autopilot. Shell può modificare file anche quando lo strumento `write` è negato, quindi Edit consente operazioni potenzialmente distruttive. La modalità avanzata mantiene inoltre le impostazioni separate per tool specifici e server MCP.
- **Non esporre questo servizio su internet pubblico** senza aggiungere ulteriori misure di sicurezza (reverse proxy con TLS, rate limiting, ecc.). È pensato per essere raggiunto solo tramite una rete privata come Tailscale.
- La password è salvata solo come hash (`scrypt`), mai in chiaro.
