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
node tests/test_markdown.js
node tests/test_message_metadata.js
node tests/test_service_restart.js
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
| [test_app.py](../tests/test_app.py) | Login/errori, chat occupata, modello, eventi e import nativo senza sovrascrivere impostazioni, limite allegati. |
| [test_advanced.py](../tests/test_advanced.py) | CLI fittizia, SSE, piani, MCP/per-tool, Fleet rifiutata, skill, migrazione legacy, timeout/chiusura SSE. |
| [test_async_chat.py](../tests/test_async_chat.py) | Job, recupero da altro client, idempotenza, chat occupata, progressi, approvazione asincrona, errori e PID non più attivo. |
| [test_images.py](../tests/test_images.py), [test_markdown.js](../tests/test_markdown.js) | Immagini autenticate, percorsi/symlink, formati vietati, cronologia; rendering ed escaping Markdown/URL. |
| [test_message_usage.py](../tests/test_message_usage.py), [test_message_metadata.js](../tests/test_message_metadata.js) | Consumi sull'ultima risposta del turno, Auto nel DB, dati mancanti/zero e riga metadati. |
| [test_session_names.py](../tests/test_session_names.py) | Rinomina YAML multilinea/caratteri speciali, preservazione metadati e cronologia. |
| [test_service_restart.py](../tests/test_service_restart.py), [test_service_restart.js](../tests/test_service_restart.js) | Supervisione, blocchi job/lock, errori systemctl/timer, attesa nuova istanza e disconnessione frontend. |

## Controlli documentali e manuali

Per documentazione: controllare esistenza di link/file locali, correttezza delle
affermazioni nel codice e nella storia Git, assenza di istruzioni duplicate o
contraddittorie e diff completo. In una nuova sessione interattiva Copilot,
`/instructions` verifica file caricati/abilitati; un link in Markdown non carica
automaticamente il documento collegato.

Le suite non verificano la CLI reale, la compatibilità dopo aggiornamenti,
l'autenticazione Copilot, la configurazione Tailscale/systemd o il layout reale.
I test JS estraggono funzioni e usano contesti VM/DOM simulati, non un browser.
Per modifiche UI/browser provare desktop e mobile: sidebar/tastiera, allegati e
incolla immagini, Markdown, sospensione/ricarica/offline durante un job,
cambio chat con risposta attribuita all'origine e approvazione del piano.
Per modifiche di integrazione verificare help/flag della CLI installata e,
su dati di prova, sessione nuova/resume e consumi. Dichiarare separatamente
queste prove manuali; assenza di un errore osservato non dimostra copertura.
