# Architettura verificata

Descrizione del codice ispezionato, non certificazione del servizio installato.
Scopo in [PROJECT](PROJECT.md), configurazione operativa nel [README](../README.md).

## Componenti e dipendenze

| Componente | Responsabilità / evidenza |
| --- | --- |
| [app.py](../app.py) | Flask, autenticazione, API, SQLite, runner CLI, lavori in thread e riavvio systemd. |
| [index.html](../static/index.html), [app.js](../static/app.js), [style.css](../static/style.css), [manifest.webmanifest](../static/manifest.webmanifest), [service-worker.js](../static/service-worker.js) | UI vanilla installabile in modalità standalone; service worker network-only senza cache. |
| [login.html](../static/login.html), [login.js](../static/login.js), [login.css](../static/login.css) | Login via API e cookie Flask. |
| GitHub Copilot CLI | Processo locale autenticato: sessioni, strumenti, modelli, MCP, statistiche. |
| SQLite / filesystem | Dati separati per responsabilità, descritti sotto. |
| systemd / Tailscale | Supervisione prevista e rete privata; unit di esempio nel README, non configurazione versionata. |

Python 3.10+ e Flask sono documentati; Werkzeug è usato tramite Flask.
Le altre importazioni backend sono della libreria standard. Nessun manifest di
dipendenze con versioni bloccate o pipeline CI è versionato.
Node serve ai controlli JS, non all'esecuzione del server.
Il codice imposta `COPILOT_BIN = /home/linuxbrew/.linuxbrew/bin/copilot`,
timeout CLI di 300 secondi e ascolto HTTP `0.0.0.0:7890`. All'avvio tenta di
avviare HTTPS su `0.0.0.0:7891` con una CA locale in `~/.copilot/webchat_tls/`;
un errore TLS viene registrato e non disabilita HTTP. La route autenticata
`/api/tls/ca` serve solo il certificato pubblico della CA, mai le chiavi.
Manifest, icone, helper PWA e service worker sono pubblici; il service worker
inoltra le richieste direttamente alla rete senza cache, e la PWA non è offline.
L'host reale va verificato.

## Dati e fonti autorevoli

Tutti i dati runtime sono sotto `~/.copilot/`; l'elenco operativo è nel README.
`init_db()` viene eseguita all'import: crea/migra tabelle, normalizza metadati
legacy e rimuove `messages`. Non è un import privo di effetti su disco.

- `session-state/<id>/events.jsonl`: fonte dei messaggi; `workspace.yaml`: metadati
  nativi, inclusa rinomina. `native_sessions()` include anche sessioni esterne
  alla webchat con messaggi utente leggibili.
- `session-store.db`: lettura in sola lettura di `assistant_usage_events` per
  consumi di sessione/turno. Il costo del turno si aggrega tra timestamp utente
  e compare solo sull'ultima risposta; dati mancanti non equivalgono a zero.
- `webchat.db`: `chats`, `mcp_servers`, `chat_jobs`, `auto_model_responses`.
  Nessun archivio duplicato della cronologia, ma progressi e risultati dei job
  contengono testo. `chats.working_directory` conserva la directory di lavoro
  impostata con `/cwd`; il marker Auto è associato a chat/timestamp e persiste
  tra browser.
- `webchat_directline/`: configurazione opzionale del secret Direct Line.
  `secret.enc` contiene il valore cifrato con Fernet e `key` la chiave separata;
  directory e file hanno permessi privati. La API non restituisce il secret e
  ne consente il salvataggio/rimozione solo via HTTPS. Il backend genera token,
  avvia esplicitamente una conversazione e aggiorna i token Direct Line usando
  l'endpoint Europa coerente con il tenant osservato; la tabella
  `studio_messages` conserva messaggi di chat Studio, distinti dalle sessioni
  CLI native.
- Upload, statistiche del runner e configurazioni MCP temporanee vengono puliti
  a fine esecuzione; immagini delle risposte restano in `files/` della sessione.

## Flussi principali

1. Login imposta il cookie Flask; `require_login()` protegge pagine/API salvo
   risorse del login. Il browser seleziona la chat, letta dai file nativi.
2. `submitChat()` invia FormData a `POST /api/chat/stream` con `async=true` e
   UUID `request_id`. Il backend risponde `202`, registra un job e avvia un thread;
   la UI interroga `GET /api/chat/jobs/<id>`. Richieste con lo stesso ID recuperano
   il job; l'indice SQLite limita a un job asincrono attivo per chat, mentre la UI
   può monitorare più job di chat distinte e disabilita l'invio solo per la chat
   selezionata se è occupata. La lista espone lo stato in esecuzione dai job webchat
   e dai lock nativi CLI, evidenziandolo nella sidebar. A job concluso la UI rilegge
   `GET /api/chats/<id>` per rendere tutti gli eventi di messaggio nativi, inclusi
   eventuali messaggi intermedi dell'assistente. I progressi visibili del job
   selezionato (frase di attesa/testo parziale e nomi dei tool) vengono ricostruiti
   quando si riapre la chat. La scheda conserva solo la frase e i nomi dei tool,
   senza testo parziale dell'assistente né argomenti dei tool.
3. `chat_args()` prepara `--session-id`/`--resume`, la directory selezionata con
   `-C` e i permessi; `run_copilot_stream()` legge JSONL CLI, delta/tool e risposta
   finale. La route offre anche SSE diretto senza `async=true`: chiuderlo termina
   il runner, a differenza del job asincrono.
4. Il recupero nella stessa tab usa `sessionStorage` per l'elenco dei job attivi,
   non ritrasmette i prompt e resta compatibile con il precedente singolo job.
   I thread non sopravvivono al server; i job con PID proprietario non più attivo
   diventano errori espliciti quando consultati.
5. Plan registra un marker `pending_plan`; approvazione riprende la sessione con
   i permessi della chat. Il ruolo `plan` è una proiezione sulla cronologia nativa,
   non un archivio separato di piani approvati/rifiutati.

## Integrazioni e confini

Ask esclude strumenti; Edit abilita shell e scrittura insieme; Agent usa
`--allow-all --mode interactive`, non autopilot. Plan nega shell/scrittura/URL.
I permessi sono deleghe alla CLI, non un isolamento del sistema operativo.
Le API MCP/per-tool esistono, ma `submitChat()` invia liste vuote: non dedurre
disponibilità UI dalla sola presenza delle route.
La UI carica skill/plugin con i comandi `list --json` della CLI e consente di
modificarne lo stato globale con `skill|plugin enable|disable`; lo stato è
verificato rileggendo l'elenco CLI. Sono impostazioni persistenti che riguardano
le sessioni future, non la singola chat, e possono essere soggette a policy
gestite o override del repository. L'aggiunta skill chiama `copilot skill add`
senza shell, accettando solo URL HTTPS diretti a `SKILL.md` o percorsi locali
assoluti sul server; il target predefinito della CLI è il profilo personale.
Non è quindi possibile selezionare un file del dispositivo browser. Le skill
personali (`source=personal-copilot`) possono essere eliminate con
`copilot skill remove <name>` dopo conferma UI; la route ricontrolla la fonte e
verifica l'esito rileggendo l'elenco. Skill builtin, di progetto e provenienti da
plugin non vengono rimosse dalla webchat. Le skill sono istruzioni e possono
includere risorse/script, perciò l'utente deve fidarsi della fonte.
`/help`, `/usage`, `/model` e `/cwd` sono gestiti localmente; `/cwd` persiste la
directory per chat e la passa alle invocazioni CLI successive. `chroniclePrompt()`
traduce alcuni `/chronicle` in prompt, senza esecuzione nativa del comando.

La password è verificata con hash Werkzeug e i cookie sono firmati con chiave
persistente. Il servizio è previsto per un singolo utente fidato su rete privata,
non per esposizione pubblica. Shell/MCP possono agire con i permessi dell'utente
server; variabili MCP sono conservate nel DB, non in un vault.
Il secret Direct Line è cifrato a riposo, ma la chiave di cifratura si trova
nello stesso profilo server: i permessi dei file proteggono da letture non
autorizzate a livello di sistema, non da un account server compromesso.
Copilot Studio è un provider separato selezionabile nella modalità chat; invio e
polling Direct Line avvengono dal backend, con token di conversazione cifrati.
Sono supportati messaggi di testo, non allegati, piani o comandi CLI.
Immagini locali autenticate sono limitate a `files/`, con controllo dei percorsi
e dei formati; URL esterni sono caricati dal browser. Eliminare una chat rimuove
la sessione nativa: non provarlo su dati reali. Riavvio/delezione controllano job
e lock CLI; il riavvio richiede supervisione systemd verificata.
