# Copilot CLI Webchat @ raspberrypi

Una piccola chat web privata per [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli), pensata per essere usata su un Raspberry Pi e raggiunta solo tramite la propria rete [Tailscale](https://tailscale.com/).

In pratica: un chatbot personale con la potenza di Copilot CLI, accessibile da browser (desktop o mobile) invece che solo da terminale.

## Documentazione e memoria del progetto

Per contribuire con GitHub Copilot partire da [AGENTS.md](AGENTS.md) e dal
[contesto di ripresa](docs/SESSION.md). La documentazione separa
[scopo e requisiti](docs/PROJECT.md), [architettura](docs/ARCHITECTURE.md),
[decisioni](docs/DECISIONS.md), [stato e lavori aperti](docs/ROADMAP.md) e
[verifiche](docs/TESTING.md).

Copilot CLI supporta `AGENTS.md` e `.github/copilot-instructions.md` come
istruzioni di repository; i documenti collegati vanno letti esplicitamente.
In una nuova sessione interattiva usare `/instructions` per verificare quali
file sono caricati e abilitati. La memoria durevole resta nei file Markdown
da versionare, indipendentemente dal modello e dalla memoria automatica della CLI.

## Caratteristiche

- **Interfaccia chat** semplice, scura, responsive (sidebar collassabile su mobile).
- **Indicatore di attesa animato** con puntini durante l'elaborazione e testo nel colore originale; rispetta la preferenza del browser per ridurre il movimento e lascia spazio alla risposta appena arriva.
- **Login con sola password** (nessun nome utente), hash salvato con `scrypt`.
- **Cronologia conversazioni** letta dai file nativi delle sessioni Copilot; le stesse sessioni sono accessibili sia dalla CLI sia dalla webchat.
- **Gestione sessioni**: ogni sessione Copilot può essere rinominata o eliminata definitivamente dalla sidebar.
  La rinomina sostituisce anche i nomi multilinea e codifica i caratteri speciali nel file YAML, mantenendo la sessione leggibile dalla CLI.
- **Continuità di contesto**: ogni conversazione richiama `copilot --resume` sullo stesso `session-id`, così Copilot ricorda lo storico dei messaggi precedenti.
- **Risposte in streaming**: testo e attività dei tool vengono recuperati durante l'elaborazione; anche l'approvazione dei piani è asincrona. Mentre Copilot lavora puoi consultare le impostazioni o altre chat; il risultato resta associato alla chat d'origine. Il flusso resta attivo se cambi app o ricarichi la pagina e non reinvia il prompt.
- **Risposte asincrone**: dopo l'invio Copilot lavora sul server, anche se cambi app, spegni lo schermo o ricarichi la pagina. Al ritorno nella stessa tab la risposta viene recuperata automaticamente; una perdita di connessione mostra un avviso neutro, non un errore rosso, e non reinvia il prompt. Gli errori effettivi di Copilot restano segnalati.
- **Modello per chat**: l'elenco del selettore viene caricato dalla CLI a ogni apertura della webapp, senza una lista di modelli mantenuta nel frontend. Su una chat aperta la scelta equivale a `/model <modello>` e vale per i turni successivi; per una chat nuova viene usata come modello iniziale.
- **Crediti per sessione**: il totale AIU viene letto dal database nativo di Copilot CLI e mostrato nell'area di composizione della chat.
- **Metadati delle risposte**: modello, crediti e ora sono allineati su una sola riga. Il suffisso `(Auto)` distingue le risposte generate con selezione automatica del modello; la provenienza è salvata in `webchat.db` e resta associata alla risposta anche su altri browser. I crediti sono il costo del turno (tutte le chiamate registrate tra un messaggio utente e il successivo, incluse attività dei tool e sottoagenti) e compaiono solo sull'ultima risposta del turno, anche nella cronologia. I messaggi utente mostrano solo l'ora; se la CLI non ha registrato dati di consumo o timestamp utilizzabili, il costo non viene mostrato.
- **Modalità chat**: Ask non espone strumenti, Edit abilita comandi e modifica file, Agent concede tutti i permessi mantenendo la modalità interattiva della CLI. La scelta è associata alla chat.
- **File allegati**: il pulsante `+` apre un'area per selezionare o trascinare file (fino a 5 file da 10 MB ciascuno per messaggio). Puoi anche incollare un'immagine dagli appunti nel campo del messaggio. Immagini e documenti nativi vengono passati a Copilot come allegati; i file testuali comuni vengono inseriti direttamente nel prompt.
- **Immagini nelle risposte**: Copilot può usare `![descrizione](https://...)` per mostrare immagini esterne oppure salvare immagini PNG, JPEG, GIF, WebP o AVIF nella cartella `files/` della sessione e mostrarle tramite `/api/chats/<id>/images/<nome-file>`. Un clic apre l'immagine a dimensione intera; gli errori di caricamento sono indicati nel messaggio. Il supporto funziona anche nella cronologia e nelle risposte asincrone; non aggiunge un generatore di immagini né modifica i permessi della chat.
- **Leggero**: Flask + SQLite, nessuna build/frontend framework, adatto a girare su un Raspberry Pi.

## Impostazioni e funzionalità

Premi **Impostazioni** sotto «Nuova chat» per aprire la schermata dedicata
nell'area principale; scegli una chat dalla sidebar o premi «Nuova chat» per
tornare ai messaggi. La schermata contiene il riavvio del servizio, la gestione
globale dei server MCP e l'elenco delle skill/plugin. Modello e modalità chat
si scelgono nella sidebar e le impostazioni delle chat sono salvate nel database.

- **Streaming e continuità**: la chat usa il flusso di eventi JSONL della CLI e
  recupera periodicamente testo e attività dei tool. Se la CLI non emette delta
  testuali, la risposta compare al termine. La disconnessione del browser non
  termina il processo e **non** ritenta il prompt. Il limite di esecuzione resta
  di 300 secondi; gli invii passano dall'endpoint streaming.
- **Piano**: `--plan` produce un piano senza autorizzare shell, scrittura o URL.
  L'utente può approvarlo o annullarlo; l'approvazione riprende la stessa sessione
  CLI con i permessi della chat. Finché il piano è in attesa, non è possibile inviare
  altri messaggi.
- **Server MCP locali**: è possibile registrare un comando con percorso assoluto,
  argomenti e variabili d'ambiente e abilitarlo globalmente. Il backend conserva
  API di selezione per chat, ma la UI attuale non espone tale selezione e invia
  liste MCP e permessi granulari vuote nei nuovi messaggi. Un server selezionato
  tramite API viene passato alla CLI, nei turni con permessi compatibili,
  con `--additional-mcp-config` tramite un file temporaneo
  privato, cancellato alla fine. La configurazione (incluse le variabili) resta in
  `~/.copilot/webchat.db`: non inserire segreti se altri utenti possono leggere il DB.
  I server già configurati direttamente nella CLI restano soggetti alle sue impostazioni
  globali; la selezione per chat riguarda solo i server creati nella webchat.
- **Skill e plugin**: elenco in sola lettura tramite `copilot skill list --json` e
  `copilot plugin list --json`. Non è possibile abilitarle per chat dalla UI;
  l'assenza di un flag CLI di selezione per invocazione è un limite documentato
  dalla verifica precedente, da riconfermare dopo gli aggiornamenti della CLI.
- **Comandi**: `/help`, `/usage`, `/cwd` e `/model` sono gestiti dalla webchat, non
  inviati arbitrariamente alla CLI. All'avvio, `/model` interroga
  le completion della CLI per caricare gli ID disponibili; l'elenco riflette la
  versione installata e può includere modelli non abilitati per il proprio account.
  Il selettore applica `/model <modello>` alla chat aperta. Le API backend per i
  permessi granulari accettano pattern come `shell(git status)` o
  `url(github.com)`; la UI attuale non offre un editor per questi pattern.
  `/cwd` mostra la directory corrente della chat e `/cwd <directory>` la cambia
  per i turni successivi; la scelta è salvata per chat e i percorsi relativi
  partono dalla directory corrente. Serve una chat creata o selezionata.
  `/chronicle standup`, `tips`, `cost-tips`, `search <termine>` e `improve`
  inviano alla CLI prompt dedicati basati sulla cronologia delle sessioni; `improve`
  propone modifiche alle istruzioni senza cambiare file. `/chronicle` mostra i
  sottocomandi disponibili. `reindex` resta disponibile solo nella CLI interattiva.
  Le richieste di conferma per singola azione **non** sono disponibili nella
  webchat; il limite del canale bidirezionale in modalità `-p` è documentato
  dalla verifica precedente della CLI.
Il riferimento della verifica precedente era CLI 1.0.88, non una garanzia di
compatibilità con versioni successive: ricontrolla `copilot --help` dopo gli
aggiornamenti per eventuali cambiamenti.
Le autorizzazioni `shell` e gli strumenti MCP locali possono eseguire operazioni
potenti: abilitali solo per configurazioni fidate.

## Requisiti

- Python 3.10+ con Flask installato (`pip install flask`).
- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli) installata e autenticata sulla stessa macchina.
- (Consigliato) una rete privata come Tailscale per esporre il servizio solo ai propri dispositivi.

## Struttura del progetto

```
copilot-webchat/
├── AGENTS.md           # istruzioni operative canoniche per Copilot
├── docs/               # conoscenza durevole e contesto di ripresa
├── tests/              # regressioni Python e Node
├── app.py              # backend Flask: API, metadati SQLite, cronologia nativa
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
- `webchat.db` — impostazioni specifiche della webchat associate agli ID di sessione (modello, autorizzazioni e server MCP), provenienza Auto delle risposte, stato, progressi e risultati testuali dei lavori asincroni. Non è l'archivio della cronologia: cronologia principale e crediti restano nei dati nativi Copilot. I risultati dei lavori vengono rimossi quando elimini la chat.
- `session-state/` — sessioni native Copilot, inclusi eventi e cronologia delle conversazioni. Le immagini locali mostrate nelle risposte restano nella sottocartella `files/` della sessione e vengono eliminate insieme alla chat.

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

I lavori asincroni continuano finché il processo Flask resta attivo: un riavvio
del server interrompe quelli in corso, che vengono segnalati come interrotti
senza rilanciarli automaticamente. Lo stato di recupero della tab è salvato nel
`sessionStorage` del browser; una ricarica lo conserva, la chiusura della tab no.
In quel caso puoi comunque riaprire la conversazione dalla sidebar.

In **Impostazioni → Generali**, **Riavvia servizio** applica gli aggiornamenti
del backend e ricarica la pagina quando la nuova istanza è pronta. Richiede
che l'app sia il processo principale di `copilot-webchat.service`, con
`Restart=on-failure` (come nell'esempio sotto) oppure `always`: il processo
esce dopo aver risposto e systemd lo rilancia, senza richiedere sudo.
Il riavvio è rifiutato se ci sono lavori webchat o sessioni CLI in esecuzione.
Con `python3 app.py` avviato manualmente il pulsante segnala che il riavvio
non è disponibile. Per installare il pulsante la prima volta serve ancora
un riavvio manuale del servizio.

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

- **Ask** limita la CLI a nessuno strumento; **Edit** abilita `--allow-tool=shell` e `--allow-tool=write`; **Agent** usa `--allow-all` in modalità interattiva, non autopilot. Shell può modificare file anche quando lo strumento `write` è negato, quindi Edit consente operazioni potenzialmente distruttive. La webchat mantiene inoltre impostazioni separate per tool specifici e server MCP.
- **Non esporre questo servizio su internet pubblico** senza aggiungere ulteriori misure di sicurezza (reverse proxy con TLS, rate limiting, ecc.). È pensato per essere raggiunto solo tramite una rete privata come Tailscale.
- La password è salvata solo come hash (`scrypt`), mai in chiaro.
- Le immagini locali richiedono il login e sono limitate alla cartella `files/` della sessione: non sono esposti percorsi arbitrari del server e SVG/HTML non sono serviti. Le immagini esterne vengono caricate direttamente dal browser, senza inviare il referrer: il sito esterno vede comunque l'IP del dispositivo. Usa solo URL fidati.
