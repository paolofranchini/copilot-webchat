# Contesto di ripresa

Aggiornato: 2026-10-12. Stato mutabile, non trascrizione delle conversazioni.

## Ultima modifica — Istruzioni di verifica

Rimosse da `AGENTS.md` le indicazioni che chiedevano all'agente di fare o
segnalare verifiche reali nel browser. Aggiornato `docs/TESTING.md` rimuovendo
la checklist manuale UI/browser; le prove visuali sul dispositivo restano a
carico dell'utente. Le istruzioni mantengono i controlli automatizzati e le
verifiche CLI pertinenti.

## Attività corrente — PWA standalone e HTTPS locale

Implementati manifest e icone PWA con `display: standalone`, e listener HTTPS
sulla porta 7891 senza cambiare la porta HTTP 7890. All'avvio viene creata una
CA locale persistente e un certificato server con gli hostname/IP privati e
Tailscale rilevati. Solo il certificato pubblico CA è scaricabile, dopo login,
da **Impostazioni → Generali**; le chiavi private rimangono in
`~/.copilot/webchat_tls/` con permessi privati.

Dopo aver verificato il messaggio Edge «Questa app non può essere installata»,
aggiunti service worker network-only, registrazione in pagine app e login,
asset PWA pubblici (per renderli reperibili anche prima dell'autenticazione) e
icona maskable con logo entro l'area sicura. Il worker inoltra le fetch
direttamente alla rete e non usa Cache API: niente cache offline di API/chat.
Per installare scegliere la voce browser **Installa app**; la voce per creare
una scorciatoia Home non implica l'installazione standalone.

Suite Python completa dopo la correzione: **53 test superati** (HOME
temporanea). Test TLS verificano firma CA/SAN/permessi/handshake HTTPS; test
PWA verificano asset pubblici e manifest; test JS verifica lifecycle e
pass-through network-only senza cache. `git diff --check` e controlli JS
superati. La schermata Edge condivisa è precedente alla correzione; nessuna
prova manuale di installazione sulla versione aggiornata ancora eseguita.

Al controllo successivo all'implementazione, le porte 7890/7891 risultavano
in ascolto e i certificati locali erano presenti; handshake HTTPS completato
con risposta 401 prevista perché la richiesta di prova era anonima. non è stato
scaricato/installato il certificato su un dispositivo mobile durante quella
verifica; in seguito l'utente ha installato la CA e verificato Firefox.
Prossima azione dopo aggiornamento e riavvio backend: riprovare l'opzione Edge
**Installa**, quindi verificare avvio standalone senza barra. Non installare la
CA su dispositivi non fidati.

File modificati: `app.py`, pagine e script PWA, manifest, icone PNG,
`tests/test_pwa_tls.py`, `tests/test_service_worker.js`, `README.md` e documenti
architettura, progetto, decisioni, test e sessione.

## Ultima modifica — Organizzazione impostazioni

Il pannello Impostazioni è stato suddiviso in card indipendenti: Sessioni,
HTTPS e installazione, Riavvio servizio, Server MCP e Skill/plugin. Ogni card
ha un titolo e una descrizione breve; la spiegazione CA è stata ridotta e il
download è presentato come pulsante. Gli ID e i controlli esistenti del riavvio,
MCP e skill sono stati mantenuti.

Verifiche: `node --check static/app.js`, `node --check static/pwa.js`,
`node --check static/service-worker.js`, `node tests/test_service_restart.js`,
`node tests/test_service_worker.js`, `node tests/test_sidebar_swipe.js` e
`git diff --check` superati. Controllo HTML mirato: cinque card, ognuna con
titolo e descrizione. Nessuna prova manuale in browser svolta.

## Attività corrente — Skill/plugin e dimensione testo chat

Skill e plugin sono presentati con checkbox per attivare/disattivare la
configurazione globale Copilot, valida per le sessioni future e non per la
singola chat. I comandi CLI sono verificati rileggendo lo stato; in caso di
errore la UI ripristina la selezione e mostra il messaggio. Le descrizioni
vengono abbreviate e `source`/`path` non sono più mostrati.

Dopo il feedback sullo screenshot, la card Skill/plugin è stata estesa a tutta
la griglia Impostazioni e le singole voci sono disposte in schede allineate a
due colonne, con una colonna sui viewport stretti.

La card include input per aggiungere una skill da URL HTTPS diretto a `SKILL.md`
o da percorso assoluto sul server, e un cestino sulle skill `personal-copilot`.
La rimozione richiede conferma, è ricontrollata dal backend rispetto alla fonte
CLI e verifica l'assenza della skill dopo il comando. Skill builtin, di progetto
e plugin non possono essere rimosse da questa UI. Aggiunta e rimozione usano la
CLI senza shell, con input validato e timeout; il target di aggiunta è il
profilo personale. La UI aggiorna l'elenco al successo e mostra gli errori.
L'origine delle skill va considerata codice/istruzioni fidati; i percorsi locali
sono del server, non del browser.

Il testo dei messaggi chat `.msg` è ridotto a `0.9em`; il codice inline usa
`1em` rispetto al messaggio, quindi ha la stessa dimensione del testo normale.
Sidebar, impostazioni e controlli non sono stati modificati.

Aggiornati README, PROJECT, ARCHITECTURE e TESTING. I test API coprono
autenticazione, input, timeout, errori CLI, rimozione solo della fonte personale
e verifica post-rimozione; test UI coprono invio, reset, conferma/rifiuto ed
errori. Suite Python completa (64 test), tutti gli script Node, controlli di
sintassi JS e `git diff --check` superati.

## Stato verificato e lavoro svolto

Attività completata: implementato `/cwd` come comando locale della webchat.
Il comando mostra la directory della chat corrente o imposta una directory
esistente, salvata in `chats.working_directory` e passata alle successive
invocazioni CLI tramite `-C`. Le nuove chat usano la directory del server finché
non ne viene scelta una; le sessioni precedenti mantengono il comportamento
esistente finché l'utente non cambia esplicitamente directory. Corretta anche
la visualizzazione del nome tool: la CLI invia `data.toolName`, mentre la UI
leggeva altri campi e ricadeva sul generico `tool`. L'etichetta è "Uso <tool>".
Durante l'attesa la UI alterna 62 frasi italiane, anche umoristiche;
le cambia circa ogni 5 secondi e, quando arriva testo streaming, mostra la
risposta parziale al posto delle frasi. Verificato inoltre che la CLI può
salvare più messaggi dell'assistente in un singolo turno: al completamento, la
webchat rilegge la cronologia nativa per mostrarli tutti senza reload manuale.
Su mobile la sidebar si chiude con swipe verso sinistra o tap fuori da essa;
resta l'hamburger per riaprirla.

- Backend: migrazione SQLite, API autenticata con validazione dei percorsi,
  supporto a directory relative e passaggio della directory ai turni e
  all'approvazione di un piano.
- Frontend: comando riconosciuto nella chat e suggerito nell'autocompletamento.
- Eventi attività: la UI mostra il nome del tool dai payload CLI senza mostrare
  gli argomenti, che possono contenere dati sensibili.
- Stato di attesa: frasi brevi ruotano durante il polling e si fermano appena
  arriva il testo della risposta; il cambio è limitato a un intervallo di 5
  secondi. Le 62 frasi sono originali e verificate per unicità.
- Cronologia live: dopo la risposta la UI ricarica gli eventi nativi della chat,
  così i messaggi intermedi dell'assistente sono visibili anche senza refresh.
- Sidebar mobile: chiusura con swipe verso sinistra o tap esterno; movimenti
  verticali e swipe brevi non la chiudono, e il tap hamburger resta escluso.
- Aggiornati [README](../README.md), [ARCHITECTURE](ARCHITECTURE.md),
  [TESTING](TESTING.md) e questo handoff.
- Commit e push richiesti dall'utente per l'insieme di modifiche descritto qui.
  Worktree pulito all'inizio dell'attività applicativa.

## Verifiche effettive

- Binario configurato `/home/linuxbrew/.linuxbrew/bin/copilot`: `--help` e
  `help commands` confermano il comando interattivo `/cwd` e l'opzione `-C`.
  La [documentazione ufficiale CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
  è stata consultata. Non è stato eseguito un collaudo con sessione Copilot reale.
- Suite Python completa con HOME temporanea: **48 test superati**. Include test
  per percorsi con spazi, validazione, persistenza e flag `-C`; i log warning/error
  nei test di errori simulati sono attesi.
- `node --check static/app.js`, `node tests/test_markdown.js`,
  `node tests/test_chat_history.js`, `node tests/test_message_metadata.js`,
  `node tests/test_tool_activity.js`, `node tests/test_service_restart.js` e
  `node tests/test_sidebar_swipe.js`: superati. I test frontend verificano anche
  cronologia multipla, rotazione ogni 5 secondi e gesture sidebar.
- `git diff --check`: superato. Nessun collaudo manuale in browser/mobile.

## Prossima azione

Dopo l'aggiornamento del backend, vai in Impostazioni e seleziona Riavvia
servizio. Per sessioni CLI preesistenti con directory diverse dalla directory
del server, il valore effettivo non è verificato su una sessione reale; `/cwd`
legge il campo `cwd` se presente nei metadati nativi, altrimenti mostra la
directory del server fino alla selezione esplicita di un nuovo percorso.
