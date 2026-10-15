# Architettura e decisioni tecniche

Scopo, configurazione e limiti utente nel [README](../README.md);
regressioni e precauzioni in [TESTING](TESTING.md).
Questo documento conserva i vincoli non ovvi, non un inventario delle route.
Codice e risultati reali prevalgono sulle descrizioni.

## Componenti

- [app.py](../app.py): Flask, autenticazione, API, SQLite, runner CLI,
  lavori asincroni, Direct Line, HTTPS e riavvio systemd.
- [static/app.js](../static/app.js) e [index.html](../static/index.html):
  frontend vanilla con fetch, polling e rendering Markdown, senza build.
  [login.js](../static/login.js) gestisce il login.
- [requirements.txt](../requirements.txt): Flask e cryptography; Werkzeug
  arriva tramite Flask. SQLite è nella libreria standard. Node serve ai test,
  OpenSSL alla generazione TLS. Nessun lock di versioni o pipeline CI versionata.
- Copilot CLI è un processo locale autenticato; Copilot Studio usa Direct Line
  dal backend. Tailscale e systemd sono configurazioni dell'host, non del repo.

## Dati e continuità

I dati runtime restano sotto `~/.copilot/`, non nel repository.
`init_db()` viene eseguita all'import e modifica il DB: vedere TESTING prima
di importare il backend su un profilo reale. Le migrazioni controllano le
colonne con `PRAGMA table_info`; le route usano `get_db()` e il teardown.

La cronologia CLI viene da `session-state/<id>/events.jsonl`, i nomi da
`workspace.yaml`. La scelta evita una cronologia duplicata e consente di riprendere
la stessa sessione da browser e CLI. Le sessioni possono provenire anche da altri
processi/sottoagenti. Non reintrodurre la tabella legacy `messages`.
Il formato dei file e dello schema CLI è una dipendenza esterna da ricontrollare
dopo aggiornamenti.

`webchat.db` conserva impostazioni in `chats`, configurazioni `mcp_servers`,
progressi/risultati testuali in `chat_jobs` e marker `auto_model_responses`.
Il marker Auto resta nel DB per essere disponibile tra browser, non nel
localStorage. `working_directory` viene impostata da `/cwd` e passata con `-C`.
Solo le chat Studio hanno cronologia in `studio_messages` e token di conversazione
cifrati; non si convertono chat o cronologie tra provider. Il selettore Provider
sceglie GitHub Copilot (predefinito) o Copilot Studio e un cambio provider avvia
una nuova chat; Modalità chat resta dedicata ai permessi CLI e non include provider.
`android_push_tokens` conserva hash e token FCM cifrato dei dispositivi registrati;
la chiave Fernet è separata in `~/.copilot/webchat_fcm/key`.

I crediti CLI vengono letti in sola lettura da `session-store.db`.
Il costo del turno si aggrega tra timestamp utente e compare sull'ultima risposta:
dati mancanti non equivalgono a zero. Upload, statistiche e configurazioni MCP
temporanee vengono puliti a fine esecuzione; immagini delle risposte rimangono
in `files/` della sessione.

## Invio, recupero e permessi

La UI invia FormData a `/api/chat/stream` con `async=true` e UUID `request_id`.
Il backend registra un job, risponde `202` e avvia un thread; la UI interroga
`/api/chat/jobs/<id>`. Lo stesso ID recupera il job invece di duplicarlo.
Un indice SQLite limita a un job asincrono attivo per chat; chat distinte possono
procedere in parallelo. Al termine la UI rilegge la cronologia completa.
`sessionStorage` conserva i job della tab e il minimo stato visuale necessario,
non un archivio conversazionale. Cambiare chat non cambia l'origine del risultato.

I thread sopravvivono alla disconnessione, non al processo Flask: i job con PID
non più attivo diventano errori al recupero. Non reinviare automaticamente prompt
perché possono eseguire azioni. La variante SSE diretta senza `async=true`,
invece, termina il runner quando il flusso viene chiuso.
Il runner CLI legge JSONL con timeout; la risposta non è necessariamente emessa
in delta. Il binario configurato e i flag effettivi sono in `chat_args()`.

Ask esclude strumenti, Edit abilita shell e scrittura insieme, Agent concede
`--allow-all --mode interactive`, non autopilot. Sono deleghe alla CLI,
non sandbox del sistema operativo. Plan nega shell/scrittura/URL e mantiene
`pending_plan`; approvazione riprende la sessione con i permessi della chat.
Il ruolo `plan` è una proiezione sulla cronologia, non un archivio di approvazioni.

I server MCP abilitati nella webchat vengono selezionati dall'invio UI per i
turni CLI con permessi compatibili; Ask e Plan li escludono. Sono supportate
configurazioni `stdio` e HTTP Streamable, validate dal backend e passate alla CLI
con `--additional-mcp-config`. I server remoti richiedono HTTPS, salvo HTTP
loopback; le configurazioni, inclusi header, sono dati locali nel DB, non un vault.
In modalità Edit e Agent, i riferimenti `#nome-server` selezionano server
abilitati per il singolo turno; in assenza di riferimenti si usano tutti quelli
abilitati. Ask, Plan e Copilot Studio non offrono il completamento MCP.
Skill/plugin sono impostazioni globali CLI, verificate rileggendo l'elenco;
aggiunta/rimozione riguarda skill personali, non file del browser. Policy o
override del repository possono prevalere.
`/help`, `/usage`, `/model`, `/cwd` sono locali; alcuni `/chronicle` sono prompt
tradotti, non esecuzioni native. Verificare help CLI prima di estendere i comandi.

## Confini di sicurezza e integrazioni

L'accesso privato è protetto da hash password e cookie Flask firmati con chiave
persistente. Shell/MCP agiscono come l'utente server; variabili MCP nel DB
non sono un vault. Immagini locali richiedono login e controlli di percorso/formato;
quelle esterne vengono caricate dal browser. Eliminazione e riavvio controllano
job e lock CLI; eliminare una chat CLI rimuove la sessione nativa.
Il riavvio richiede supervisione systemd verificata.

HTTP resta disponibile; HTTPS usa una CA locale persistente. Solo il certificato
pubblico CA è scaricabile dopo login, mai le chiavi. La PWA standalone usa
asset pubblici e un service worker network-only: niente cache di API,
credenziali o conversazioni, niente modalità offline.
Le notifiche di risposta sono opt-in e locali al browser: quando una pagina
ancora aperta rileva il completamento di una chat non visibile, chiede al service
worker di mostrare una notifica priva del testo conversazionale. Il click riporta
alla chat. Non sono notifiche push e non funzionano dopo la chiusura della PWA.

Secret e token Direct Line sono cifrati con Fernet; la chiave separata rimane
nello stesso profilo server. Questo non protegge da compromissione dell'account
o dell'host. Salvataggio/rimozione del secret richiedono HTTPS e l'API non ne
restituisce il valore. Usare solo credenziali non esposte.
Il backend genera/aggiorna token, avvia la conversazione e interroga le attività;
gli ID utente sono `dl_<UUID>`. `DIRECTLINE_API` usa l'endpoint Europa e deve
corrispondere alla regione dell'agente. Gli errori riportano operazione e codice
stabile, non secret/token o messaggi remoti. Un 403 non dimostra da solo una causa:
verificare la risposta del tenant. I mock non certificano il collegamento reale.

Il push Android è separato dalle notifiche locali PWA. Il client registra il
token FCM con API autenticate e HTTPS; la credenziale service account resta sul
server, configurata con `GOOGLE_APPLICATION_CREDENTIALS` e mai nel repository.
Alla conclusione positiva del job asincrono, il backend invia un payload generico
con ID chat e tipo, senza contenuto conversazionale. Gli errori di invio sono
registrati senza cambiare l'esito del job; FCM `UNREGISTERED` rimuove il token.
La consegna dipende da rete e servizi Google e non è garantita dal backend.
