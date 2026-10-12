# Progetto

## Scopo e utenti

Interfaccia web personale per usare GitHub Copilot CLI da browser desktop o
mobile, su Raspberry Pi e rete privata Tailscale. Non è un servizio pubblico
multiutente né un'implementazione completa della CLI interattiva.
Fonti: [README](../README.md), [backend](../app.py) e [UI](../static/index.html).

## Casi d'uso e requisiti osservabili

- Accedere con password, creare/riprendere sessioni native Copilot, rinominarle
  e consultarle sia da CLI sia da browser.
- Inviare messaggi e allegati, vedere attività/risposte, recuperare lavori
  asincroni senza reinviare il prompt dopo una disconnessione.
- Scegliere modello e modalità Ask/Edit/Plan/Agent; approvare o annullare un piano.
- Mostrare immagini e metadati delle risposte, senza inventare consumi mancanti.
- Gestire configurazioni MCP globali e consultare o attivare/disattivare
  skill/plugin globali per le sessioni Copilot future; aggiungere skill da
  URL HTTPS o percorso locale del server.
- Eliminare esplicitamente una sessione e i relativi dati; applicare aggiornamenti
  del backend tramite il servizio supervisionato.
- Installare la webchat come PWA standalone su HTTPS privato, senza modificare
  l'accesso HTTP esistente né mettere in cache conversazioni o API.

Sono comportamenti riscontrati nel codice e nei test, non una dichiarazione di
collaudo in produzione. [ROADMAP](ROADMAP.md) distingue stato, limiti e proposte.
Configurazione e limiti numerici per l'utente restano nel README.

## Vincoli e criteri di accettazione

Preservare accesso privato e autenticazione, continuità delle sessioni native,
separazione tra cronologia e metadati webchat, leggerezza senza build frontend,
errori espliciti e compatibilità con la CLI installata.
I criteri di regressione osservabili e le relative evidenze sono in
[TESTING](TESTING.md): una modifica deve superare i controlli pertinenti,
non duplicare invii e non attribuire risultati alla chat sbagliata.
L'integrazione non deve presentare prompt tradotti come comandi nativi.

## Scope e informazioni non stabilite

Fleet è esplicitamente esclusa e rifiutata dal backend. Lo scope storicamente
documentato esclude anche integrazione GitHub nativa e agenti di revisione
integrati nella webchat: non equivale a un divieto di usare strumenti Copilot
per sviluppare il repository. Fonte storica: documentazione nel commit `4de243e`.

Non sono definiti requisiti multiutente, SLA, politica di backup/conservazione,
matrice di browser supportati, versioni CLI garantite, budget o scadenze.
Non inferire nuove priorità dalle funzionalità mancanti; richiedere una decisione
di scope quando un'attività le richiede. Per lo sviluppo, le regole canoniche
sono in [AGENTS](../AGENTS.md).
