# Plan: addon de WoW: Forever para Orca (Windows)

Fork de [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow) v0.3.0 (MIT, © 2026 Ryan Hughes; remoto `upstream`).
Objetivo: ver y manejar los agentes de [Orca](https://github.com/stablyai/orca) desde dentro de WoW: Forever, en Windows.

## Cómo funciona la base (no cambia)

Un addon de WoW no puede usar la red ni leer ficheros, así que hay un **bridge** (Node, sin dependencias npm) que corre al lado del juego:

| Sentido | Mecanismo | Código |
|---|---|---|
| Juego → bridge | El addon dibuja una franja de celdas de color (cifrada) en la esquina superior izquierda; el bridge la captura de pantalla y la decodifica | `addon/OrcaWow/Core/Codec.lua`, `Transport.lua` · `bridge/src/codec.js`, `capture.js`, `strip-crypto.js` |
| Bridge → juego | El bridge escribe `Inbox.lua` en addons *LoadOnDemand* (`T3Code_S001…S1200`); el addon carga el siguiente con `LoadAddOn` | `bridge/src/slots.js`, `luaser.js` · `Transport.lua` |
| Aviso "hay datos" | WAVs silenciosos que el bridge rellena; el addon comprueba con `C_Sound.IsPlaying` cuál suena | `slots.js`, `Transport.lua:465-530` |

Ida y vuelta ≈ 1,2 s. Límite: 1200 actualizaciones por sesión de UI (luego `/reload`). Detalle completo en `docs/ARCHITECTURE.md`.

## Cómo hablamos con Orca

**Vía principal: named pipe local, sin cifrar, petición/respuesta.**

- Descubrimiento: `%APPDATA%\orca\orca-runtime.json` → `{ runtimeId, pid, transports:[{kind:'named-pipe', endpoint}], authToken }`. Pipe y token cambian en cada arranque de Orca: releer al reconectar.
- Trama (NDJSON, una por línea): `{"id","authToken","method","params"}` → `{"id","ok":true,"result"}` / `{"id","ok":false,"error":{code,message}}`; `{"_keepalive":true}` cada 10 s en long-polls.
- Límites del servidor: 1 MB por trama, 32 conexiones, 30 s de inactividad. Sin suscripciones → hay que hacer polling.
- Métodos que usaremos:
  - Lectura: `status.get`, `repo.list`, `worktree.ps` (`afterSnapshotId`, `includeAgentWait`), `terminal.list`, `terminal.read` (`screen`, `cursor`), `terminal.agentStatus`.
  - Escritura: `terminal.send` (`agentPrompt:true`, `interrupt`), `agentSession.respondToApproval`, `agentSession.respondToQuestion`, `worktree.set`, `worktree.sleep`, `agent.launch`.
  - Crear worktree + agente: mejor vía CLI `orca.exe worktree create --name X --agent claude --prompt "…" --json` (el CLI ya gestiona los reintentos).
- Unión agente ↔ terminal: `worktree.ps` → `agents[].paneKey` (`<tabId>:<leafId>`) = `tabId`/`leafId` de `terminal.list`.
- Estados: workspace `active|working|permission|done|inactive`; agente `working|blocked|waiting|done`.

**Vía opcional (fase 5): WebSocket de la app móvil** `ws://127.0.0.1:6768`, cifrado NaCl, con emparejamiento (`orca pair`). Da eventos push (`notifications.subscribe`). Ojo: `orca pair` abre el puerto a toda la red.

Ambas APIs son **internas** de Orca: pueden cambiar entre versiones. Lo documentado es el CLI (`--json`) y la API de plugins.

### Correspondencia T3 → Orca

| Concepto en el addon | T3 Code | Orca |
|---|---|---|
| Proyecto | project | repo |
| Hilo | thread | agente dentro de un worktree (`paneKey`) |
| Estado `working` | run activo | agente `working` |
| Estado `input` | runtime request pendiente | agente `blocked`/`waiting` (permiso/pregunta) |
| Estado `open` (terminado sin leer) | run terminado | agente `done` + `unread` |
| Transcripción | mensajes de la proyección | `prompt` + `lastAssistantMessage` + cola del terminal (`terminal.read`) |
| Enviar mensaje | `message.dispatch` | `terminal.send {agentPrompt:true}` |
| Parar | `run.interrupt` | `terminal.send {interrupt:true}` |
| Aprobar / rechazar | `runtime-request.respond` | `agentSession.respondToApproval` o teclas al menú del terminal |
| Settle / archive | `thread.settle` / `thread.archive` | `worktree.set --workspace-status` / `worktree.sleep` |
| Nuevo hilo | `orchestration.launchThread` | `orca worktree create … --agent … --prompt` |
| Modelo / esfuerzo | `thread.model-selection.set` | no aplica (lo decide el agente CLI) → quitar |

## Fases

### Fase 1 — Bridge funcionando en Windows (sin tocar T3)

- [x] `capture.js`: `process.getuid()` y `which()` seguros en Windows (antes rompían la carga del módulo).
- [x] Rutas por plataforma en `src/paths.js`: en Windows todo bajo `%LOCALAPPDATA%\t3code-wow\{config,state,app}`.
- [x] `wow.js` — localizar el juego en Windows: `product.db`, `Battle.net.config`, Program Files y carpetas habituales de cada unidad.
- [x] `wow.js` — detectar `_forever_\Wow.exe` en ejecución con PID + hora de creación (vía el helper). `findWowProcess` pasa a ser async.
- [x] **Backend de captura `windows`**: helper persistente `native/wowhelper.cs` (compilado con el `csc.exe` de .NET Framework 4, que trae Windows) + `src/winhelper.js`. `BitBlt` de la esquina si está descubierta, `PrintWindow(PW_RENDERFULLCONTENT)` si algo la tapa. Probado contra el juego real: 3840×2160 a DPI 144, ~16 ms por captura, píxeles DirectX correctos.
- [x] Captura de pantalla de la ventana para adjuntos (`StripCapture.screenshot`) en Windows (PNG).
- [x] Arranque automático: tarea del Programador de tareas al iniciar sesión (`src/winservice.js`, `conhost --headless`, reinicio si falla, log en `state\bridge.log`).
- [x] Tests en Windows: 52 pasan, 0 fallan, 10 omitidos (Wine/Linux y los que necesitan `lua5.1` en el PATH).
- [x] `install` ya no aborta si no hay T3: avisa y sigue (el backend llega en la fase 2).
- [ ] **Hito:** instalar el addon en el juego, reiniciar WoW y comprobar con `/t3 selftest` la ida y vuelta completa.

### Fase 2 — Cliente Orca de solo lectura ✅

- [x] `bridge/src/orca.js` (`OrcaClient`): conexión NDJSON persistente a la named pipe; relee `orca-runtime.json` en cada conexión; reabre en silencio si Orca cierra por inactividad; backoff de 1 a 15 s; "Orca isn't running" si falta el fichero. El token no aparece nunca en logs.
- [x] Misma interfaz que `Fleet` (T3) y datos con la forma de T3, para que `threadStatus`, `pendingRequest`, `activityLabel`… de `bridge.js` funcionen sin cambios. El bridge usa Orca por defecto; T3 sigue disponible con `"backend": "t3"`.
- [x] Polling de `worktree.ps` con `afterSnapshotId` (2 s si hay actividad, 6 s si no). `terminal.read` solo para el agente que se mira o que está activo.
- [x] Un hilo por agente principal (`paneKey`); proyecto = repo; ids cortos y estables (`o…`/`r…`); `unread` de Orca → no leído en el juego; worktree `completed` → hecho.
- [x] Proyección: último prompt, última respuesta y las últimas 40 líneas del terminal (sin ANSI). Las preguntas y los menús de permiso se leen de la pantalla del terminal, porque la pipe no expone `interactivePrompt`.
- [x] Tests: `test/orca.test.js` (22) con un Orca falso en una named pipe real (`test/support/fake-orca.js`) + `test/orca-bridge.test.js` (bridge completo → snapshot → orden).

### Fase 3 — Órdenes hacia Orca ✅

- [x] `send` → `terminal.send {agentPrompt:true}` como el CLI. Si hay un menú de permiso abierto, error claro ("responde primero a la aprobación").
- [x] `stop` → Esc (como el botón Stop de la app móvil de Orca), no Ctrl+C.
- [x] `approve` → lee el menú de la pantalla y pulsa la opción "Sí" o "Sí, no volver a preguntar"; `decline` → Esc. `answer` → las mismas teclas que usa Orca (`buildAskAnswerKeys`).
- [x] `new` → `worktree.create {startupAgent, startupPrompt}`; devuelve el id del nuevo agente para abrirlo en el juego.
- [x] `settle`/`unsettle` → `worktree.set workspaceStatus completed|in-progress`; `archive` → `worktree.sleep`; `read` → `agentActivity.setRead`.
- [x] Capturas adjuntas: se guardan como PNG en `state\shots` y su ruta se añade al prompt.
- [x] `model` → error explicativo (los agentes de Orca eligen su modelo).

### Fase 4 — Adaptar el addon a Orca ✅

- [x] Modo Orca en el addon según `bridge.backend` del snapshot: textos "Orca"/"agentes", sin selector de modelo/esfuerzo ni pestaña de uso, botones "Marcar hecho" / "Reabrir" / "Dormir worktree" y "Sí" / "Sí, no volver a preguntar" / "No". Smoke test (`tools/smoke.lua`) con ~30 comprobaciones nuevas.
- [x] Renombrado: addon `OrcaWow`, slots `OrcaWow_S###`, `/orca`, CLI `orca-wow`, datos en `%LOCALAPPDATA%\orca-wow`.
- [x] Voz en Windows (SAPI vía PowerShell). Dictado: pendiente.
- [x] `install.ps1`: copia a `%LOCALAPPDATA%\orca-wow\app`, crea `orca-wow.cmd` y ejecuta `orca-wow install`.
- [x] README propio con la atribución.
- [ ] **Hito final:** probarlo en WoW con Orca abierto.
### Fase 4b — Orca remoto y nuevos worktrees ✅

- [x] **Orca remoto** por enlace de acceso (`orca://pair?code=…`, scope *runtime*): WebSocket con E2EE v2 (con fallback a legacy), como el cliente emparejado del CLI de Orca; tweetnacl 1.0.3 incluido en `bridge/vendor/`, verificado contra los vectores de prueba de Orca. `src/orca-remote.js`.
- [x] `src/orca-fleet.js`: el Orca local y N remotos a la vez (ids `e1~…`, etiqueta de ordenador en el juego, órdenes al ordenador correcto). CLI: `orca-wow remote add|list|remove`, `orca-wow local on|off`. Secretos en `config\remotes\<id>.json`.
- [x] Corregido: tras una reconexión, `poll()` mandaba el `afterSnapshotId` antiguo y vaciaba la lista de agentes.
- [x] **Nuevo worktree** desde el juego eligiendo agente, nombre del worktree y rama base (`new <proyecto> <texto> <agente> <nombre> <rama>`; snapshot con `agents`); `/orca new --agent … --name … --base … <texto>`.
- [ ] Probar contra el Orca real del MacBook.

### Fase 5 — Opcional

- [ ] Eventos push por el WebSocket de Orca (emparejamiento + NaCl) en vez de polling.
- [ ] Plugin `trusted-worker` de Orca (API documentada) como alternativa estable a la pipe interna.

## Riesgos

- **Captura en Windows** con el juego en pantalla completa DX12: hay que probar `PrintWindow`/`BitBlt` en esta máquina antes que nada más. Ventana o ventana sin bordes debería funcionar.
- **API interna de Orca**: la pipe y sus esquemas pueden cambiar sin aviso. Aislar todo en `orca.js` y fallar con mensajes claros.
- **Antivirus**: lanzar procesos auxiliares de captura puede levantar sospechas; preferir un único helper persistente.
- **Slots**: 1200 actualizaciones por sesión; el ritmo de publicación (`bridge.js:877-1020`) ya lo gestiona.
- **Licencia**: mantener `LICENSE` y la atribución.

## Estado del entorno (2026-11-10)

- Git 2.56, Node 26.13 y LuaJIT 2.1 (para los tests de Lua) instalados con winget. `user.name`/`user.email` de git sin configurar.
- Orca instalado (`%APPDATA%\orca`, `%LOCALAPPDATA%\Programs\Orca`).
- WoW en `C:\Program Files (x86)\World of Warcraft\` con `_forever_`.
- Tests del bridge en Windows: 0 fallos (los 5 omitidos son de Wine/Linux). Smoke test del addon con LuaJIT: OK.
- Orca no estaba abierto durante el desarrollo: todo lo de Orca está probado contra el Orca falso, construido a partir del código fuente de Orca.
