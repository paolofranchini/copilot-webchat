# Decisioni e vincoli consolidati

Registro compatto: il progetto non richiede ADR separati. Le voci **esistenti**
sono ricostruite da documentazione/codice, senza attribuire date o motivazioni
storiche non documentate. L'architettura attuale è in [ARCHITECTURE](ARCHITECTURE.md).
Per nuove decisioni indicare stato, contesto, motivazione, alternative e
conseguenze note; etichettare come proposta ciò che non è approvato.

## D1 — Servizio personale leggero e privato (esistente)

Contesto/motivazione documentati nel [README](../README.md): uso personale su
Raspberry Pi via Tailscale. Flask, SQLite e frontend vanilla evitano una build
frontend. Conseguenza: nessuna promessa di servizio pubblico/multiutente;
accesso privato e supervisione devono essere configurati sull'host.
Non è documentato un confronto formale con stack alternativi.

## D2 — Cronologia nativa, metadati webchat separati (esistente)

Contesto: continuità della stessa sessione tra CLI e browser.
Evidenze: `read_native_chat()`, `init_db()` in [app.py](../app.py),
[test_app.py](../tests/test_app.py) e [test_advanced.py](../tests/test_advanced.py);
i commit `c2fc058` e `4de243e` riguardano gestione/uso delle sessioni native.
Conseguenze: non reintrodurre `messages`; leggere anche sessioni create fuori
dalla webchat; dipendenza dai formati nativi CLI. Il DB webchat conserva marker
Auto e risultati dei job, non sostituisce la cronologia.
La motivazione documentata per Auto è la persistenza tra browser,
non l'affidamento al `localStorage`.

## D3 — Recuperare il job, non reinviare il prompt (esistente)

Contesto: disconnessione o sospensione del browser durante azioni CLI.
Il README documenta il rischio di duplicare azioni; UUID, polling e guardie di
concorrenza sono in [app.py](../app.py) e [app.js](../static/app.js).
Conseguenze: lavoro indipendente dalla connessione ma dipendente dal processo
Flask; dopo un riavvio controllare la cronologia prima di un nuovo invio.
Evidenza di regressione: [test_async_chat.py](../tests/test_async_chat.py).

## D4 — Parità CLI limitata e trasparente (esistente)

La documentazione storica nel commit `4de243e` esclude Fleet e descrive limiti di
skill/approvazioni in modalità non interattiva. Il backend rifiuta `fleet`;
la UI distingue comandi locali, `/chronicle` tradotto e `reindex` non supportato.
Conseguenza: verificare help/documentazione della CLI prima di estendere
l'integrazione; non assumere equivalenza con la CLI interattiva.
Il motivo documentato per escludere Fleet è il mancato utilizzo, non un limite CLI.

## D5 — Memoria Markdown canonica per Copilot (nuova, richiesta in questa attività)

Contesto: ripresa del progetto in una sessione nuova senza ricostruire le chat.
Decisione richiesta: [AGENTS](../AGENTS.md) contiene il workflow comune;
[istruzioni Copilot](../.github/copilot-instructions.md) rimandano ad esso;
`docs/` separa conoscenza durevole e [SESSION](SESSION.md) mutabile.
Conseguenze: aggiornamenti mirati a fine attività, nessuna trascrizione delle
conversazioni, nessuna integrazione con altri agenti. Preferenza OpenAI per lo
sviluppo senza vincoli di versione; nessun cambiamento ai modelli offerti dalla UI.
Su richiesta dell'utente, il piano superato è stato rimosso per ridurre il
contesto e la duplicazione: stato e limiti restano in ROADMAP, decisioni qui.
La rimozione non implica completamento delle funzionalità originariamente
proposte; la fonte storica resta recuperabile da Git.

## D6 — HTTPS locale e PWA standalone senza modalità offline (nuova)

Il listener HTTP esistente sulla porta 7890 resta invariato; HTTPS usa la porta
7891 e una CA locale persistente in `~/.copilot/webchat_tls/`. Il certificato
CA è scaricabile solo autenticati, la chiave CA non viene esposta; il dispositivo
deve fidarsi esplicitamente della CA per aprire l'URL HTTPS con certificato
valido. La PWA usa `display: standalone` e un service worker network-only:
presente per supportare l'installabilità, non salva API, sessioni o conversazioni
e non offre uso offline. Manifest, icone e worker sono pubblici, mentre il resto
della webchat mantiene l'autenticazione. Contesto e istruzioni d'installazione sono nel
[README](../README.md); il flusso TLS è in [ARCHITECTURE](ARCHITECTURE.md).

## D7 — Credenziale Direct Line cifrata sul server (nuova)

La UI Impostazioni consente di salvare o rimuovere un secret Direct Line solo
tramite HTTPS. Flask lo cifra con Fernet in `~/.copilot/webchat_directline/`;
la chiave è separata dal ciphertext e tutti i file/directory sono privati.
L'API espone solo lo stato configurato e non rilegge il valore nel browser.
La chiave resta nello stesso profilo utente: la cifratura protegge il contenuto
da letture isolate del file del secret, non da compromissione dell'account o
dell'host. Decisione di implementazione: Copilot Studio è un provider chat
separato, trasporta testo con token Direct Line generati/aggiornati dal backend
e conserva la cronologia in tabella distinta dalle sessioni CLI. Non converte
chat esistenti e non supporta allegati, Plan o comandi CLI. Mai riutilizzare
credenziali che siano state incollate o esposte: revocarle e generarne una nuova
prima del salvataggio. Gli ID utente Direct Line usano `dl_<UUID>`, come
richiesto dall'API. La diagnostica indica l'operazione e, se presente, il codice
stabile dell'ErrorResponse, mai secret/token o messaggi remoti. Un 403 può indicare
TokenExpired, un endpoint regionale non corretto o una risorsa agente non valida;
la causa concreta va confermata sulla risposta Direct Line del tenant. Verifica
automatizzata con API Direct Line simulate; il collegamento reale resta da provare.
Il backend usa l'endpoint regionale Europa, coerente con il redirect
`europe.token.botframework.com` mostrato nelle impostazioni utente. Se la regione
effettiva dell'agente è diversa, `DIRECTLINE_API` va allineato all'endpoint
Direct Line documentato per quella regione.
