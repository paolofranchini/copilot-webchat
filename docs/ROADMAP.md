# Stato e lavori aperti

Baseline applicativa: commit `4de243e`; esiti delle verifiche di questa attività
in [SESSION](SESSION.md). Nessuna scadenza o priorità prodotto è stata trovata.
Questo documento è la fonte corrente per stato, limiti e proposte;
la documentazione storica in Git non è prova di collaudo attuale.

## Stato osservato

| Area | Evidenza / limite attuale |
| --- | --- |
| Sessioni native, login, allegati, immagini | Codice e regressioni presenti; non collaudati su host/browser in questa attività. |
| Streaming e recupero asincrono, piani | Runner, polling e test presenti; riavvio server interrompe i lavori, senza rilancio. |
| Modelli, crediti/Auto, riavvio servizio | Implementazioni e test presenti; dipendono dai formati CLI, dai dati d'uso e da systemd. |
| MCP / permessi granulari | API e test backend presenti; UI solo CRUD MCP globale, senza selezione per chat/editor per-tool; invio UI con liste vuote. |
| Skill/plugin | Elenco in sola lettura; selezione per chat non implementata. Limite CLI documentato da riconfermare dopo aggiornamenti. |
| Slash command | Comandi locali e `/chronicle` tradotto; non equivalenza completa con CLI interattiva. |
| Screenshot/dettatura | Nessun controllo o integrazione browser corrispondente nella UI ispezionata. Non lavori pianificati automaticamente. |
| Fleet | Esclusa esplicitamente; backend rifiuta il parametro. |

I commit recenti `b0475f5`, `c2fc058`, `d31fc1c`, `4de243e` riguardano
sincronizzazione, sessioni native, asincronia e controlli del servizio;
i titoli Git non dimostrano il rilascio sull'host.

## Attività e dipendenze

- **Completato in questa attività:** sistema documentale nel worktree, senza
  cambiamenti applicativi. Verifiche e handoff in SESSION.
- **Da verificare, non feature pianificate:** caricamento istruzioni in una
  sessione Copilot nuova, compatibilità della CLI host e scenari browser critici
  di [TESTING](TESTING.md).
- **Debito osservabile, senza intervento autorizzato:** dipendenza da schema
  session-store/formato completion CLI e import backend con effetti persistenti;
  nessun lock delle dipendenze o CI versionata.
- **Proposte non approvate:** CI, matrice browser/versioni CLI, backup o eventuale
  reintroduzione di funzioni UI storiche richiedono una decisione di scope.

Non è identificabile un'altra attività applicativa in corso dal worktree
inizialmente pulito e dai documenti esistenti. Non trasformare lacune di copertura
o proposte in requisiti senza conferma.
