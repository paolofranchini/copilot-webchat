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
