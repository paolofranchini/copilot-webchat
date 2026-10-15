# Copilot CLI Webchat @ raspberrypi

Una piccola chat web privata per [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli), pensata per essere usata su un Raspberry Pi e raggiunta solo tramite la propria rete [Tailscale](https://tailscale.com/).

In pratica: un chatbot personale con la potenza di Copilot CLI, accessibile da browser (desktop o mobile) invece che solo da terminale.

## Documentazione e memoria del progetto

Per contribuire con GitHub Copilot partire da [AGENTS.md](AGENTS.md).
Questo README descrive scopo, utilizzo e configurazione;
[ARCHITECTURE](docs/ARCHITECTURE.md) raccoglie flussi e decisioni tecniche,
[TESTING](docs/TESTING.md) i comandi e le precauzioni di verifica.

Copilot CLI supporta `AGENTS.md` e `.github/copilot-instructions.md` come
istruzioni di repository; i documenti collegati vanno letti esplicitamente.
In una nuova sessione interattiva usare `/instructions` per verificare quali
file sono caricati e abilitati. La memoria durevole resta nei file Markdown
da versionare, indipendentemente dal modello e dalla memoria automatica della CLI.

## Scopo e limiti

Il progetto è personale e per rete privata, non un servizio pubblico multiutente
né una replica completa della CLI interattiva. Copilot Studio è un provider
separato per l'agente pubblicato: non converte le sessioni CLI e supporta solo
testo, senza allegati, Plan o comandi CLI.
Fleet è esclusa e il backend ne rifiuta il parametro; integrazione GitHub nativa
e agenti di revisione integrati nella UI non fanno parte dello scope stabilito.
Questo non limita gli strumenti Copilot usati per sviluppare il repository.

Non sono stabiliti SLA, politica di backup/conservazione, matrice di browser
o versioni CLI garantite. L'assenza di una funzionalità non ne autorizza
l'implementazione. Le modifiche devono preservare accesso privato, continuità
delle sessioni e risultati associati alla chat d'origine, senza duplicare invii.

## Caratteristiche

- **Interfaccia chat** semplice, scura, responsive (sidebar collassabile su mobile).
- **Notifiche PWA**: dopo averle attivate da Impostazioni e con il permesso del browser, una risposta completata mostra una notifica se la pagina è in background o si sta visualizzando un'altra chat; toccarla apre la chat interessata. Impostazioni include una notifica di prova. La pagina deve restare aperta: senza un servizio Web Push la PWA chiusa non può ricevere notifiche.
- **Backend push Android**: il backend può inviare via FCM una notifica generica al completamento dei lavori asincroni, senza inserire prompt o risposte nel payload. Il client Android nativo non è incluso: può registrare/revocare il token FCM tramite API autenticate HTTPS.
- **Indicatore di attesa animato** con puntini durante l'elaborazione e testo nel colore originale; rispetta la preferenza del browser per ridurre il movimento e lascia spazio alla risposta appena arriva.
- **Login con sola password** (nessun nome utente), hash salvato con `scrypt`.
- **Cronologia conversazioni** letta dai file nativi delle sessioni Copilot; le stesse sessioni sono accessibili sia dalla CLI sia dalla webchat.
- **Gestione sessioni**: ogni sessione Copilot può essere rinominata o eliminata definitivamente dalla sidebar.
  La rinomina sostituisce anche i nomi multilinea e codifica i caratteri speciali nel file YAML, mantenendo la sessione leggibile dalla CLI.
- **Continuità di contesto**: ogni conversazione richiama `copilot --resume` sullo stesso `session-id`, così Copilot ricorda lo storico dei messaggi precedenti.
- **Risposte in streaming**: testo e attività dei tool vengono recuperati durante l'elaborazione; anche l'approvazione dei piani è asincrona. Mentre Copilot lavora puoi consultare le impostazioni o altre chat e inviare nuovi messaggi in sessioni diverse; la chat in esecuzione è evidenziata in verde nella sidebar e il risultato resta associato alla sessione d'origine. Il flusso resta attivo se cambi app o ricarichi la pagina e non reinvia il prompt.
- **Risposte asincrone**: dopo l'invio Copilot lavora sul server, anche se cambi app, spegni lo schermo o ricarichi la pagina. Al ritorno nella stessa tab la risposta viene recuperata automaticamente; una perdita di connessione mostra un avviso neutro, non un errore rosso, e non reinvia il prompt. Gli errori effettivi di Copilot restano segnalati.
- **Modello per chat**: l'elenco del selettore viene caricato dalla CLI a ogni apertura della webapp, senza una lista di modelli mantenuta nel frontend. Su una chat aperta la scelta equivale a `/model <modello>` e vale per i turni successivi; per una chat nuova viene usata come modello iniziale.
- **Crediti per sessione**: il totale AIU viene letto dal database nativo di Copilot CLI e mostrato nell'area di composizione della chat.
- **Metadati delle risposte**: modello, crediti e ora sono allineati su una sola riga. Il suffisso `(Auto)` distingue le risposte generate con selezione automatica del modello; la provenienza è salvata in `webchat.db` e resta associata alla risposta anche su altri browser. I crediti sono il costo del turno (tutte le chiamate registrate tra un messaggio utente e il successivo, incluse attività dei tool e sottoagenti) e compaiono solo sull'ultima risposta del turno, anche nella cronologia. I messaggi utente mostrano solo l'ora; se la CLI non ha registrato dati di consumo o timestamp utilizzabili, il costo non viene mostrato.
- **Provider e modalità chat**: Provider separa GitHub Copilot (predefinito) da Copilot Studio; cambiarlo crea una nuova chat con il provider scelto. Modalità chat controlla i permessi GitHub Copilot: Ask non espone strumenti, Edit abilita comandi e modifica file, Agent concede tutti i permessi mantenendo la modalità interattiva della CLI. Plan è disponibile solo per chat GitHub Copilot. La modalità è associata alla chat e viene applicata al primo messaggio di una nuova chat.
- **File allegati**: il pulsante `+` apre un'area per selezionare o trascinare file (fino a 5 file da 10 MB ciascuno per messaggio). Puoi anche incollare un'immagine dagli appunti nel campo del messaggio. Immagini e documenti nativi vengono passati a Copilot come allegati; i file testuali comuni vengono inseriti direttamente nel prompt.
- **Immagini nelle risposte**: Copilot può usare `![descrizione](https://...)` per mostrare immagini esterne oppure salvare immagini PNG, JPEG, GIF, WebP o AVIF nella cartella `files/` della sessione e mostrarle tramite `/api/chats/<id>/images/<nome-file>`. Un clic apre l'immagine a dimensione intera; gli errori di caricamento sono indicati nel messaggio. Il supporto funziona anche nella cronologia e nelle risposte asincrone; non aggiunge un generatore di immagini né modifica i permessi della chat.
- **Leggero**: Flask + SQLite, nessuna build/frontend framework, adatto a girare su un Raspberry Pi.

## Impostazioni e funzionalità

Premi **Impostazioni** sotto «Nuova chat» per aprire la schermata dedicata
nell'area principale; scegli una chat dalla sidebar o premi «Nuova chat» per
tornare ai messaggi. La schermata contiene il riavvio del servizio, la gestione
globale dei server MCP, l'elenco delle skill/plugin e la configurazione opzionale
del secret Direct Line. Modello e modalità chat si scelgono nella sidebar e le
impostazioni delle chat sono salvate nel database.

- **Streaming e continuità**: la chat usa il flusso di eventi JSONL della CLI e
  recupera periodicamente testo e attività dei tool. Se la CLI non emette delta
  testuali, la risposta compare al termine. La disconnessione del browser non
  termina il processo e **non** ritenta il prompt. Il limite di esecuzione resta
  di 300 secondi; gli invii passano dall'endpoint streaming.
- **Piano**: `--plan` produce un piano senza autorizzare shell, scrittura o URL.
  L'utente può approvarlo o annullarlo; l'approvazione riprende la stessa sessione
  CLI con i permessi della chat. Finché il piano è in attesa, non è possibile inviare
  altri messaggi.
- **Server MCP**: la webchat gestisce server locali `stdio` e remoti HTTP
  Streamable. Per Microsoft Learn, ad esempio, usa
  `{"type":"http","url":"https://learn.microsoft.com/api/mcp","tools":["*"]}`.
  I server abilitati vengono inclusi nei nuovi turni CLI con permessi compatibili;
  Ask e Plan non li usano. Il backend passa la configurazione alla CLI con
  `--additional-mcp-config` tramite un file temporaneo privato, cancellato a fine
  esecuzione. Nel messaggio si può scrivere `#nome-server` per selezionare
  esplicitamente uno o più server abilitati per quel turno; senza riferimenti si
  usano tutti i server abilitati. I riferimenti sono disponibili in modalità
  Edit e Agent, non in Ask, Plan o Copilot Studio. Gli endpoint remoti richiedono
  HTTPS; HTTP è consentito solo per server loopback. La configurazione (incluse
  variabili e header) resta in `~/.copilot/webchat.db`: non inserire segreti se
  altri utenti possono leggere il DB.
  I server già configurati direttamente nella CLI restano soggetti alle sue impostazioni
  globali; gli interruttori della webchat valgono solo per i server creati qui.
- **Skill e plugin**: l'elenco usa `copilot skill list --json` e
  `copilot plugin list --json`; le checkbox attivano o disattivano gli elementi
  con i comandi CLI corrispondenti. La modifica è globale e vale per le sessioni
  Copilot future, anche fuori dalla webchat; policy gestite o configurazioni del
  repository possono impedirla. Se la CLI rifiuta il comando, la UI ripristina
  la checkbox e mostra l'errore. Il modulo permette anche di aggiungere una
  skill da URL HTTPS diretto a `SKILL.md` o da percorso assoluto sul server,
  usando `copilot skill add`; URL e percorsi locali sono validati e gli errori
  della CLI vengono mostrati. I percorsi sono quelli del server, non del browser.
  Le skill personali hanno un comando cestino con conferma; le skill integrate
  e quelle fornite dai plugin non sono eliminabili da qui. La rimozione elimina
  la skill dal profilo personale Copilot. Aggiungi solo skill fidate: le
  istruzioni e gli eventuali script influenzano ciò che Copilot può fare.
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

- Python 3.10+ con le dipendenze installate (`pip install -r requirements.txt`).
- OpenSSL installato per il listener HTTPS facoltativo.
- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli) installata e autenticata sulla stessa macchina.
- (Consigliato) una rete privata come Tailscale per esporre il servizio solo ai propri dispositivi.

Nelle **Impostazioni** è possibile salvare il secret Direct Line per una futura
integrazione: il valore viene cifrato sul server e la chiave è custodita in un
file distinto con permessi privati. Il salvataggio è consentito solo via HTTPS
(porta 7891). Se configurato, il selettore **Provider → Copilot Studio**
crea una chat separata che usa Direct Line; il cambio provider avvia una nuova
chat e non converte cronologie esistenti. Sono supportati messaggi testuali,
non allegati, Plan o comandi CLI. Non riutilizzare secret condivisi in chat o
già esposti: rigenerali prima di salvarli.

### Notifiche push per un client Android

Il backend invia una notifica FCM quando termina con successo un lavoro
asincrono (GitHub Copilot o Copilot Studio). Il server deve poter raggiungere
in uscita Google OAuth e FCM; non è necessario esporre la webchat su Internet.
Per abilitarlo:

1. Crea un progetto Firebase, abilita Firebase Cloud Messaging e configura
   l'app Android associata. Il client Android usa il proprio `google-services.json`;
   non contiene né sostituisce la credenziale server.
2. Crea una credenziale service account server autorizzata a inviare messaggi
   FCM (abilita la Firebase Cloud Messaging API e assegna al service account il
   ruolo **Firebase Cloud Messaging API Admin**). Salva il JSON fuori dal
   repository, leggibile solo dall'utente del servizio (ad esempio in
   `~/.copilot/fcm-service-account.json`, con permessi `600`), e imposta
   `GOOGLE_APPLICATION_CREDENTIALS` nel servizio systemd:

   ```ini
   Environment=GOOGLE_APPLICATION_CREDENTIALS=/home/<utente>/.copilot/fcm-service-account.json
   ```

3. Riavvia il servizio. Il client, dopo il login e il consenso alle notifiche,
   può controllare `GET /api/push/android/status`, poi inviare
   `POST /api/push/android/register` con `{"token":"<token FCM>"}`. Per revocarlo
   usa `POST /api/push/android/unregister` con lo stesso JSON. Tutte le API
   richiedono la sessione autenticata; registrazione e revoca richiedono HTTPS
   (porta 7891).

Il backend conserva i token cifrati con una chiave di cifratura privata in
`~/.copilot/webchat_fcm/`; il token non viene restituito dalle API. Il payload
inviato a FCM contiene solo un testo generico e `chat_id`/tipo per aprire la
chat nel client, non il prompt o la risposta. I token dichiarati non più
registrati da FCM vengono rimossi; altri errori sono scritti nei log e non
annullano la risposta completata. Se si perde la chiave di cifratura, il client
deve registrare nuovamente il token.

## Struttura del progetto

```
copilot-webchat/
├── AGENTS.md           # istruzioni operative canoniche per Copilot
├── docs/               # conoscenza durevole del progetto
├── tests/              # regressioni Python e Node
├── app.py              # backend Flask: API, metadati SQLite, cronologia nativa
└── static/
    ├── index.html      # pagina principale della chat
    ├── manifest.webmanifest # installazione PWA in modalità standalone
    ├── service-worker.js # pass-through rete, senza cache offline
    ├── login.html       # pagina di login
    ├── style.css        # stile chat
    ├── login.css         # stile login
    └── app.js            # logica frontend (invio messaggi, cronologia, sidebar)
```

Dati d'esecuzione (non versionati, salvati fuori dal repo in `~/.copilot/`):

- `webchat_auth` — hash della password di accesso.
- `webchat_secret` — chiave segreta per firmare i cookie di sessione Flask.
- `webchat.db` — impostazioni specifiche della webchat associate agli ID di sessione (modello, autorizzazioni e server MCP), provenienza Auto delle risposte, stato, progressi e risultati testuali dei lavori asincroni. Non è l'archivio della cronologia: cronologia principale e crediti restano nei dati nativi Copilot. I risultati dei lavori vengono rimossi quando elimini la chat.
- `webchat_fcm/key` — chiave privata locale che cifra i token dei dispositivi Android salvati nel database.
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
Con OpenSSL installato, avvia anche HTTPS su tutte le interfacce alla porta
`7891`. Il listener HTTPS genera al primo avvio una CA locale e un certificato
per gli hostname e gli indirizzi privati/Tailscale rilevati; la CA e le chiavi restano in
`~/.copilot/webchat_tls/` (directory privata, chiavi non scaricabili). Se TLS
non è disponibile, l'errore viene scritto nei log e HTTP continua a funzionare.
La porta 7890 e il relativo URL non cambiano.

### HTTPS e installazione come app

1. Dopo aver aggiornato il backend, vai in **Impostazioni** e seleziona **Riavvia servizio**. In alternativa, riavvia il servizio secondo la modalità d'installazione.
2. Apri l'indirizzo HTTP già in uso dalla rete privata Tailscale ed effettua il login.
3. Vai in **Impostazioni → Generali** e scarica il certificato CA. Scaricalo solo attraverso la connessione Tailscale fidata: installarlo significa autorizzare sul dispositivo i certificati firmati da questa CA privata.
4. Installa il certificato sul dispositivo come CA attendibile. Su iOS occorre anche abilitare la fiducia completa in **Impostazioni → Generali → Info → Impostazioni attendibilità certificati**; su Android la procedura per installare una CA utente varia in base alla versione.
5. Apri in browser `https://<ip-locale>:7891`, usando lo stesso nome/IP locale di prima e cambiando solo schema e porta. Dopo il login, usa **Installa app** dal menu del browser; una voce separata **Aggiungi a schermata Home** può creare soltanto una scorciatoia. La modalità `standalone` apre la chat senza la barra del browser quando il browser supporta l'installazione PWA.

La porta 7891 deve essere raggiungibile dal dispositivo sulla rete privata. Se l'IP cambia, riavvia il servizio per rigenerare il certificato con gli indirizzi correnti. Se OpenSSL o il listener HTTPS non sono disponibili, controlla i log del servizio. Il certificato CA è scaricabile solo dopo il login; la chiave privata non viene mai esposta dall'API.

Il service worker inoltra le richieste direttamente alla rete: non mette in cache HTML, API, credenziali o cronologia. La PWA non funziona offline. Le risorse PWA pubbliche (manifest, icone e service worker) sono accessibili senza login; le pagine e i dati dell'app restano protetti.

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
