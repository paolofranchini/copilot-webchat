# Istruzioni operative per GitHub Copilot

Webchat personale Flask per GitHub Copilot CLI, con frontend vanilla e accesso
privato via Tailscale. [README](README.md): installazione, utilizzo e servizio.
GitHub Copilot è l'unico ambiente agente supportato; quando serve scegliere un
modello per lo sviluppo, preferire un modello OpenAI disponibile senza fissarne
la versione. Non aggiungere integrazioni per altri agenti né applicare questa
preferenza al selettore dei modelli della webchat.

## Prima di implementare

- Leggere questo file, [SESSION](docs/SESSION.md) e [PROJECT](docs/PROJECT.md).
  Consultare solo gli altri documenti pertinenti: [ARCHITECTURE](docs/ARCHITECTURE.md),
  [DECISIONS](docs/DECISIONS.md), [ROADMAP](docs/ROADMAP.md), [TESTING](docs/TESTING.md).
- Eseguire `git status --short`; leggere codice, test, configurazione e diff
  rilevanti. Preservare modifiche preesistenti, anche nei file da aggiornare.
- Verificare le ipotesi nel repository: codice, configurazione, Git e risultati
  reali dei test prevalgono sulle descrizioni e sulle conversazioni precedenti.
  Le proposte in ROADMAP non sono lavori automaticamente autorizzati.

## Vincoli e convenzioni

- Cambiamenti circoscritti, senza refactoring o correzioni estranei alla richiesta.
  Commenti, documentazione e testi utente in italiano; seguire lo stile esistente.
- Backend in `app.py`, UI in `static/`, senza framework frontend o bundler.
  Le route usano `get_db()` e il teardown `close_db()`; per migrazioni di colonne
  seguire `init_db()` con `PRAGMA table_info`.
- La cronologia viene dalle sessioni native Copilot, non dalla vecchia tabella
  `messages`: non reintrodurla. SQLite conserva impostazioni, lavori e provenienza
  Auto delle risposte; quest'ultima non va spostata nello storage del browser.
  `chat_jobs` può contenere testo di progressi/risultati, non è l'archivio storico.
- Non assumere che le sessioni native siano tutte create dalla webchat: possono
  provenire dalla CLI o da sottoagenti. Non spostare dati persistenti nel repo.
- Preservare autenticazione, validazione ed errori API JSON con status non-2xx;
  gli errori durante SSE/lavori hanno eventi/stati espliciti. Non nascondere errori
  con fallback silenziosi. Non ritentare automaticamente l'invio di prompt.
- Prima di aggiungere funzionalità CLI, verificare `copilot --help`, il binario
  configurato e la documentazione ufficiale aggiornata. Distinguere funzioni
  native, comandi gestiti dalla webchat, prompt tradotti e funzioni non supportate.
- Per screenshot e dettagli visuali, verificare l'elemento nel codice o nei dati;
  distinguere fatti da ipotesi.

## Durante il lavoro

- Registrare decisioni durevoli in DECISIONS; aggiornare ARCHITECTURE se cambia
  l'architettura reale e PROJECT/ROADMAP se cambiano requisiti, scope o piani.
- Separare fatti, assunzioni e proposte. Registrare lezioni riutilizzabili da
  tentativi falliti nel documento pertinente, non trascrivere conversazioni.
- Mantenere una sola fonte per ogni dettaglio; usare collegamenti negli altri
  file. Le istruzioni Copilot specifiche rimandano qui, non ne fanno una copia.

## Verifica e conclusione

- Comandi esistenti: `pip install flask`, `python3 app.py` per l'avvio;
  `python3 -m unittest discover -s tests` per Python;
  `node --check static/app.js` per sintassi frontend; `git diff --check`.
  Test Node aggiuntivi e precauzioni sull'import in [TESTING](docs/TESTING.md).
  Non risultano build, lint o formatter configurati; non inventare comandi.
- Eseguire test/check pertinenti; usare la suite completa per modifiche trasversali.
  Riportare comandi effettivamente eseguiti e risultati reali, includendo errori,
  blocchi e verifiche automatiche non superate. Non dichiarare successi non
  verificati.
- Aggiornare SESSION al termine di ogni attività significativa con lavoro
  completato, file, verifiche, problemi e prossima azione concreta. Aggiornare gli
  altri documenti solo quando giustificato; non lasciare uno stato obsoleto.
- Rivedere il diff completo (inclusi file nuovi) per contraddizioni, duplicazioni
  e modifiche estranee; ricontrollare lo stato Git. Non fare commit o push senza
  richiesta esplicita.
- Dopo modifiche al backend dire: «Vai in Impostazioni e seleziona Riavvia
  servizio». Prerequisiti e limiti del riavvio sono nel README.
