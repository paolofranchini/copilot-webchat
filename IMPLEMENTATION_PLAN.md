# Piano di implementazione — Feature parity con Copilot CLI

Obiettivo: avvicinare la webchat alle capacità di `copilot` CLI aggiungendo le
funzionalità mancanti. Le funzioni descritte sono disponibili direttamente
nell'interfaccia e non dipendono da uno switch o da un flag del client.

Esclusi da questo piano (non richiesti): integrazione GitHub nativa,
agente rubber-duck/code-review integrato.

## Stato di attuazione

| Fase | Stato | Implementato / limite residuo |
| --- | --- | --- |
| Funzioni chat | Completate | Streaming, piani, server MCP, skill/plugin e permessi granulari sono disponibili senza un flag di attivazione; l'interfaccia e il backend usano `/api/chat/stream`. |
| 1. Streaming | Completata | `Popen`, JSONL su SSE, eventi tool/delta se emessi dalla CLI, risposta finale, timeout e pulizia su disconnessione. |
| 2. Plan mode | Completata | `--plan`, autorizzazioni negate nel turno di pianificazione, `pending_plan`, messaggi `role='plan'`, approvazione con `--resume` e annullamento. Non esiste un tag separato per piano approvato/rifiutato nella cronologia. |
| 3. MCP custom | Completata | CRUD globale nella schermata Impostazioni, selezione per chat, configurazione locale validata e passata tramite `--additional-mcp-config` con file temporaneo. I server configurati direttamente nella CLI non sono gestiti qui. |
| 4. Skill / plugin | Parziale (limite CLI) | `GET /api/skills` legge le liste JSON in sola lettura. Nessuna selezione dinamica per chat: la CLI verificata non espone un flag `--skill` per `-p`. |
| 5. Fleet | Esclusa | Funzione rimossa dalla webchat perché non utilizzata; le richieste con il parametro `fleet` vengono rifiutate. |
| 6. Slash command | Parziale | Whitelist webchat `/help`, `/usage`, `/model <modello>` con suggerimenti; gli altri comandi della CLI interattiva non sono implementati. |
| 7. Permessi granulari | Parziale (limite CLI) | Pattern tool per chat validati e passati come `--allow-tool`; nessun flusso di approvazione bidirezionale per singola azione in `-p`. Restano le autorizzazioni `shell` / `write` / `all`. |
| 8. Allegati estesi | Completata | Screenshot tramite condivisione schermo e dettatura nel browser, quando disponibili. Le API possono richiedere HTTPS o localhost; nessun audio è inviato al backend. |

**Organizzazione UI**: il pulsante Impostazioni sotto «Nuova chat» apre
la schermata nell'area principale. Include le impostazioni generali e quelle per chat (modello e
autorizzazioni ripetuti e sincronizzati con quelli della sidebar, modalità
piano, pattern tool e selezione MCP), il CRUD
globale dei server MCP e la lista skill/plugin. Selezionare una chat
o crearne una nuova riporta alla vista messaggi. Le richieste non richiedono
un flag di attivazione delle funzionalità.

## Ordine di implementazione

### 1. Streaming delle risposte

**Perché**: l'esecuzione sincrona attendeva la fine dell'intero processo
(fino a `TIMEOUT_SECONDS`); l'utente vedeva solo "Copilot sta pensando..."
fino alla fine.

**Backend**:
- Aggiungere `run_copilot_stream()` che usa `subprocess.Popen` con
  `stdout=PIPE`, leggendo riga per riga gli eventi NDJSON già emessi da
  `--output-format json` e inoltrandoli man mano.
- Endpoint `POST /api/chat/stream` che
  risponde con **Server-Sent Events** (`text/event-stream`), oppure
  chunked transfer, inoltrando eventi tipo:
  - `{"type": "tool.execution_start", ...}`
  - `{"type": "assistant.message.delta", "content": "..."}` (se la CLI
    supporta delta streaming; altrimenti inoltrare l'evento finale non
    appena disponibile)
  - `{"type": "done", "reply": ..., "model": ..., "usage": ...}`
- Gestire il timeout e la disconnessione client (chiudere il subprocess se
  il client si scollega).

**Frontend**:
- `chatForm` usa `EventSource`/`fetch` con
  `ReadableStream` per ricevere gli eventi dello stream.
- Mostrare un'area "attività" sopra il messaggio bot con lo stato dei tool
  in esecuzione (es. "Eseguo comando: ...", "Modifico file: ...").
- Mantenere il rendering markdown esistente per il messaggio finale.

**Nota**: ripetere un prompt dopo un errore durante lo stream potrebbe
duplicare azioni.

### 2. Plan mode

**Perché**: la CLI supporta una modalità di pianificazione (equivalente a
`Shift+Tab` interattivo) in cui Copilot propone uno step-by-step plan prima
di eseguire modifiche.

**Backend**:
- Verificare il flag CLI corrispondente in modalità non interattiva (da
  documentazione CLI aggiornata: opzione tipo `--plan` o prompt-prefix
  dedicato). Se la CLI non espone un flag diretto in `-p` mode, simulare
  con un prompt di sistema aggiuntivo che chiede esplicitamente un piano
  prima di agire, e un secondo turno di conferma.
- Parametro `plan` sull'endpoint `POST /api/chat/stream` che:
  1. Invia il prompt con richiesta di solo piano (nessuna esecuzione,
     permessi negati di default per questo turno).
  2. Restituisce il piano testuale/strutturato.
  3. Un secondo turno (`POST /api/chat/plan/approve`) invia lo stesso
     `copilot_session_id` con `--resume` e il via libera per eseguire,
     applicando le autorizzazioni scelte dall'utente.
- Salvare lo stato "piano in attesa di approvazione" nella tabella `chats`
  (nuova colonna `pending_plan TEXT`), con migrazione soft come le altre.

**Frontend**:
- Toggle "Modalità piano" nella sidebar o nel form di invio.
- Quando attivo, il messaggio bot con il piano mostra due pulsanti:
  "Approva ed esegui" / "Annulla".
- Cronologia: il piano approvato/rifiutato viene salvato come messaggio
  con un tag distintivo (`role='plan'`).

### 3. Configurazione MCP server custom

**Perché**: la CLI supporta server MCP nativi/custom per estendere gli
strumenti disponibili.

**Backend**:
- Nuova tabella `mcp_servers (id, name, config_json, enabled)`.
- Endpoint CRUD: `GET/POST/PUT/DELETE /api/mcp-servers`.
- Il runner streaming genera un file di configurazione MCP
  temporaneo (o usa il file di config CLI standard, es.
  `~/.copilot/mcp-config.json`, se la CLI lo legge automaticamente) e passa
  il flag corrispondente (`--mcp-config` o equivalente da verificare nella
  reference CLI aggiornata).
- Validare rigorosamente il JSON inserito dall'utente (whitelisting dei
  campi noti: comando, argomenti, variabili d'ambiente) per evitare
  iniezioni di comandi arbitrari non intenzionali.

**Frontend**:
- Nuova sezione nella sidebar "Server MCP": lista, aggiungi/rimuovi,
  abilita/disabilita per singola chat (colonna `mcp_servers` in `chats`,
  simile a `permissions`).

### 4. Skill / plugin

**Perché**: la CLI supporta skill modulari (`/skill`) e plugin
(`/plugin`) per estendere il comportamento dell'agente.

**Backend**:
- Se la CLI espone flag non interattivi per abilitare/disabilitare skill
  (es. `--skill=<name>` o file di config `AGENTS.md`/skill directory),
  aggiungere supporto per selezionare quali skill/plugin passare a
  il runner streaming.
- Endpoint `GET /api/skills` per elencare le skill disponibili localmente
  (lettura directory skill installate, se esposta dalla CLI in formato
  leggibile) ed `PUT /api/chats/<id>/skills` per salvare la selezione per
  chat (nuova colonna `skills TEXT` in `chats`).

**Frontend**:
- Sezione sidebar "Skill/Plugin" con checkbox per skill disponibili,
  analoga a quella delle autorizzazioni.

**Nota di rischio**: questa fase dipende fortemente da cosa la CLI espone
in modalità non interattiva; se non c'è flag dedicato, documentare il
limite e implementare solo la lettura/visualizzazione, rimandando
l'abilitazione dinamica a una fase successiva.

### 5. Fleet / subagent paralleli

**Esclusa su richiesta**: non è più disponibile il pulsante, né l'opzione
per abilitarlo. Il backend rifiuta il parametro `fleet` senza invocare la CLI.

### 6. Slash command generici

**Perché**: la CLI interattiva espone comandi come `/model`, `/help`,
`/session`, `/usage`, ecc.

**Backend**:
- Endpoint `POST /api/command` che accetta un testo `/comando argomenti` e
  lo instrada a funzioni server-side esistenti (es. `/model gpt-...` →
  aggiorna il modello fissato della chat; `/usage` → richiama
  `read_copilot_usage`; `/help` → restituisce elenco comandi supportati
  dalla webchat, non necessariamente 1:1 con la CLI).
- Mantenere un registro esplicito dei comandi supportati (whitelist), per
  evitare di interpretare input arbitrario come comando.

**Frontend**:
- Riconoscere l'input che inizia con `/` nel campo messaggio e mostrare un
  menu di autocompletamento con i comandi disponibili.
- Instradare l'invio a `/api/command` invece che `/api/chat/stream` quando il
  testo è un comando riconosciuto.

### 7. Permessi granulari per singolo tool/comando

**Perché**: oggi le autorizzazioni sono solo `shell` / `write` / `all` per
l'intera chat; la CLI supporta approvazioni puntuali per singola azione.

**Backend**:
- Estendere `PERMISSION_FLAGS`/`DENY_PERMISSION_FLAGS` con altri tool noti
  esposti dalla CLI (es. `read`, `network`/`url`, tool MCP specifici),
  mantenendo compatibilità con `valid_permissions()`.
- Nuovo meccanismo di **approvazione interattiva per singola azione**:
  quando la CLI in JSON streaming emette una richiesta di conferma
  (evento tipo `tool.permission_request`), il backend (in modalità
  streaming, punto 1) inoltra l'evento al frontend e attende una risposta
  dell'utente prima di proseguire (richiede comunicazione bidirezionale,
  es. SSE + endpoint `POST /api/chat/<stream_id>/approve`).

**Frontend**:
- Sidebar: elenco esteso di permessi per chat (invece delle 3 checkbox
  attuali), con possibilità di aggiungere singoli tool per nome.
- Durante lo streaming, se arriva una richiesta di approvazione puntuale,
  mostrare un prompt inline ("Consentire l'esecuzione di: `rm -rf ...`?
  Sì/No") che blocca l'avanzamento finché l'utente non risponde.

**Nota**: questa fase è la più delicata dal punto di vista sicurezza;
va implementata con attenzione a non introdurre injection nei comandi
passati al processo `copilot`.

### 8. Allegati estesi (screenshot / dettatura vocale)

**Perché**: la CLI interattiva supporta scorciatoie per dettatura vocale
(`Ctrl+Space`) e cattura rapida di contenuti; la webchat oggi supporta solo
upload/drag&drop di file esistenti.

**Backend**:
- Nessuna modifica sostanziale: gli allegati generati (screenshot,
  registrazione vocale trascritta) passano comunque per
  `save_attachments()`/`prepare_attachments()` esistenti.
- Se si aggiunge trascrizione vocale lato server, valutare se delegarla
  alla stessa CLI (se supporta audio come allegato) o a un servizio
  esterno separato (fuori scope se non richiesto esplicitamente).

**Frontend**:
- Pulsante "Scatta screenshot" (via `navigator.mediaDevices.getDisplayMedia`
  + cattura canvas) che genera un file immagine e lo aggiunge ad
  `attachedFiles` come i file caricati manualmente.
- Pulsante "Dettatura" (via Web Speech API `SpeechRecognition`, se
  disponibile nel browser) che trascrive in tempo reale nel campo di
  testo, senza inviare audio al backend.
- I controlli sono disponibili nelle Impostazioni; il flusso di
  upload/drag&drop resta invariato.

## Modifiche trasversali

- **DB**: tutte le nuove colonne/tabelle seguono il pattern di migrazione
  soft già usato in `init_db()` (`PRAGMA table_info` + `ALTER TABLE ADD
  COLUMN` solo se mancante).
- **Documentazione**: descrivere le funzionalità disponibili e le loro
  limitazioni rispetto alla CLI reale.
- **Verifica flag CLI**: prima di ogni fase che introduce nuovi flag
  (`--plan`, MCP, skill), verificare con `copilot --help` /
  changelog aggiornato sull'host di destinazione, perché la disponibilità
  di questi flag in modalità `-p` non interattiva non è garantita e può
  cambiare tra versioni della CLI.

## Ordine di esecuzione consigliato (riepilogo)

1. Streaming delle risposte
2. Plan mode
3. Configurazione MCP server custom
4. Skill / plugin
5. Fleet / subagent paralleli — esclusa
6. Slash command generici
7. Permessi granulari per singolo tool/comando
8. Allegati estesi (screenshot / dettatura vocale)

Le parti ancora parziali sono limitate dalle capacità della CLI non
interattiva o richiedono un modello di eventi per-subagent/approvazioni
che la webchat oggi non riceve.
