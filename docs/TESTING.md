# Guida alle verifiche

## Prerequisiti e sicurezza dei dati

Dalla radice del repository: Python 3.10+, Flask/Werkzeug (`pip install flask`
come nel [README](../README.md)); Node per test/sintassi JavaScript.
I test usano `unittest`, mock e CLI fittizie: non richiedono Copilot autenticato,
rete Tailscale o un servizio systemd reale.
Nessun build, linter, formatter o framework di test documentale è configurato.
Gli esiti effettivi, distinti dai comandi disponibili, restano in [SESSION](SESSION.md).

**Attenzione all'import:** [app.py](../app.py) crea configurazione/chiave ed
esegue migrazioni subito. Molte classi isolano `HOME` prima dell'import;
[test_app.py](../tests/test_app.py) sposta i percorsi solo dopo l'import.
Usare un `HOME` temporaneo già predisposto quando l'import potrebbe precedere
l'isolamento, ad esempio
`HOME=/percorso/temporaneo python3 -m unittest discover -s tests -p 'test_app.py'`.
L'isolamento esterno è consigliato anche per l'intera suite; ripulire soltanto
i file temporanei creati dalla verifica. Non importare il backend per un semplice
controllo documentale sul profilo reale. Non usare sessioni reali per test
di eliminazione o riavvio.

## Comandi disponibili

```bash
python3 -m unittest discover -s tests
python3 -m unittest discover -s tests -p 'test_pwa_tls.py'
python3 -m unittest discover -s tests -p 'test_skills.py'
node tests/test_markdown.js
node tests/test_chat_history.js
node tests/test_chat_job_controls.js
node tests/test_message_metadata.js
node tests/test_new_chat_permissions.js
node tests/test_tool_activity.js
node tests/test_service_restart.js
node tests/test_sidebar_swipe.js
node tests/test_service_worker.js
node tests/test_skill_ui.js
node --check static/app.js
node --check static/login.js
git diff --check
```

Per un intervento locale usare un solo runner con un pattern pertinente, per
esempio `python3 -m unittest discover -s tests -p 'test_service_restart.py'`.
Per modifiche trasversali usare la suite Python completa e gli script Node
coinvolti. `git diff --check` non controlla file untracked: leggerli o verificarli
esplicitamente prima di dichiarare controllato il diff completo.
L'avvio manuale `python3 app.py` e la configurazione del servizio sono nel README;
non avviare/riavviare il servizio condiviso solo per modifiche documentali.

## Mappa delle regressioni

| Test | Scenari critici coperti dal codice dei test |
| --- | --- |
| [test_app.py](../tests/test_app.py) | Login/errori, chat occupata, modello, `/cwd` e validazione directory, eventi e import nativo senza sovrascrivere impostazioni, limite allegati. |
| [test_advanced.py](../tests/test_advanced.py) | CLI fittizia, SSE, piani, directory `/cwd` passata alla CLI, MCP/per-tool, Fleet rifiutata, skill, migrazione legacy, timeout/chiusura SSE. |
| [test_async_chat.py](../tests/test_async_chat.py) | Job, recupero da altro client, idempotenza, chat occupata, esecuzioni parallele su chat distinte, stato running in sidebar API, permessi Agent al primo messaggio, progressi, approvazione asincrona, errori e PID non più attivo. |
| [test_chat_history.js](../tests/test_chat_history.js) | Render della cronologia completa, inclusi più messaggi dell'assistente per turno. |
| [test_chat_job_controls.js](../tests/test_chat_job_controls.js), [test_new_chat_permissions.js](../tests/test_new_chat_permissions.js) | Il job disabilita solo i controlli della chat occupata; la nuova chat conserva i permessi Agent scelti per il primo messaggio. |
| [test_images.py](../tests/test_images.py), [test_markdown.js](../tests/test_markdown.js) | Immagini autenticate, percorsi/symlink, formati vietati, cronologia; rendering ed escaping Markdown/URL. |
| [test_pwa_tls.py](../tests/test_pwa_tls.py), [test_service_worker.js](../tests/test_service_worker.js) | Asset PWA pubblici, manifest e icone, download autenticato della sola CA, generazione/verifica TLS, worker network-only senza cache (OpenSSL richiesto per test TLS). |
| [test_message_usage.py](../tests/test_message_usage.py), [test_message_metadata.js](../tests/test_message_metadata.js) | Consumi sull'ultima risposta del turno, Auto nel DB, dati mancanti/zero, riga metadati e rotazione/arresto delle frasi di attesa. |
| [test_tool_activity.js](../tests/test_tool_activity.js) | Estrae e mostra `toolName` degli eventi CLI senza esporre gli argomenti. |
| [test_session_names.py](../tests/test_session_names.py) | Rinomina YAML multilinea/caratteri speciali, preservazione metadati e cronologia. |
| [test_service_restart.py](../tests/test_service_restart.py), [test_service_restart.js](../tests/test_service_restart.js) | Supervisione, blocchi job/lock, errori systemctl/timer, attesa nuova istanza e disconnessione frontend. |
| [test_sidebar_swipe.js](../tests/test_sidebar_swipe.js) | Verifica swipe verso sinistra e tap esterno; lascia attivi sidebar, hamburger e layout desktop. |
| [test_skills.py](../tests/test_skills.py), [test_skill_ui.js](../tests/test_skill_ui.js) | Aggiunta e rimozione skill CLI, fonte personale-only, autenticazione/errori, conferma UI, toggle globale, descrizioni compatte e ripristino su errore. |

## Controlli documentali e manuali

Per documentazione: controllare esistenza di link/file locali, correttezza delle
affermazioni nel codice e nella storia Git, assenza di istruzioni duplicate o
contraddittorie e diff completo. In una nuova sessione interattiva Copilot,
`/instructions` verifica file caricati/abilitati; un link in Markdown non carica
automaticamente il documento collegato.

Le suite non verificano la CLI reale, la compatibilità dopo aggiornamenti,
l'autenticazione Copilot o la configurazione Tailscale/systemd.
I test JS estraggono funzioni e usano contesti VM/DOM simulati.
Per modifiche di integrazione verificare help/flag della CLI installata e,
su dati di prova, sessione nuova/resume e consumi.
