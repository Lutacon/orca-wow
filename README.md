# Orca for World of Warcraft

Mira y maneja los agentes de [Orca](https://github.com/stablyai/orca) (Claude Code, Codex… cada uno en su worktree) sin salir de **World of Warcraft: Forever**, en Windows.

Fork de [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow), que hacía lo mismo con T3 Code en Linux y macOS. Este fork añade Windows y un backend para Orca. El de T3 sigue disponible con `"backend": "t3"`. El plan de trabajo y su estado están en [PLAN.md](PLAN.md).

> Experimental. Las APIs que usa de Orca (la named pipe local) son internas y pueden cambiar entre versiones.

## Qué hace

- Una ventana en el juego (`/orca`) con tus agentes de Orca agrupados por estado: trabajando, te necesitan o terminados. Cada uno muestra su último prompt, su última respuesta y el final de su terminal.
- **Escribirle** a un agente, **pararlo** (Esc) y **responder sus permisos**: Sí, "Sí, no volver a preguntar" o No. También responder a sus preguntas de opciones.
- **Abrir un worktree nuevo** en cualquier repo de Orca, eligiendo el agente (Claude, Codex, OpenCode…), el nombre del worktree y la rama base, con tu prompt. **Marcar como hecho** o **dormir** su worktree.
- **Varios Orca a la vez**: el de este PC y los de otros ordenadores de tu red, como un MacBook. Ver más abajo.
- Avisos cuando un agente termina o pide algo: toast, sonido, línea en el chat y una sección en el tracker de objetivos. Se aplazan en combate.
- Lectura en voz alta con la voz de Windows. Mando compatible.

## Requisitos

- Windows 10/11 con **World of Warcraft: Forever** instalado desde Battle.net. Funciona en ventana o en pantalla completa sin bordes.
- **Orca** abierto en este ordenador o en otro de tu red (ver "Orca en otro ordenador").
- **Node.js 22+**: `winget install OpenJS.NodeJS.LTS`.
- Nada más. El ayudante de captura se compila con el compilador de C# que ya trae Windows (.NET Framework 4).

## Instalar

Con el juego **cerrado**, desde una copia del repo, en una terminal tuya (no hace falta ser administrador):

```bash
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

El instalador hace esto:

1. Copia el bridge y el addon a `%LOCALAPPDATA%\orca-wow\app`.
2. Instala el addon y sus 1200 carpetas de actualización (`OrcaWow_S###`) en `_forever_\Interface\AddOns`.
3. Registra el bridge como tarea al iniciar sesión, sin ventana y reiniciándolo si falla. Su log va a `%LOCALAPPDATA%\orca-wow\state\bridge.log`.
4. Espera a que entres al juego.

Opciones: `--wow "D:\Juegos\World of Warcraft"`, `--slots N` y `--no-service` (en ese caso lo arrancas tú con `orca-wow run`).

**Actualizar:** vuelve a ejecutar `install.ps1`. Si solo ha cambiado el código del addon, basta con `/reload`. Si hay carpetas o sonidos nuevos, hay que reiniciar el juego.

**Desinstalar:** `%LOCALAPPDATA%\orca-wow\orca-wow.cmd uninstall`.

## Orca en otro ordenador (p. ej. un MacBook)

El bridge puede mostrar los agentes de uno o varios Orca de otros ordenadores de tu red (o de tu Tailscale), además del Orca de este PC o en lugar de él. Usa el mismo canal cifrado de extremo a extremo que la app móvil de Orca.

1. En el Mac, en Orca, ve a **Settings → Remote Orca Servers → Advertise this app as a server → New Link**. En **Connection address** elige la IP de red local del Mac (no `127.0.0.1`) y pulsa **Generate Access Link**. Copia el enlace `orca://pair?code=…` que aparece en "Pair another Orca client".
   - Alternativa desde la terminal del Mac: `orca pair --address <ip-del-mac>`. Hace falta un enlace de **escritorio**: los de móvil (`--mobile`) no sirven.
2. En el PC:
   ```bash
   %LOCALAPPDATA%\orca-wow\orca-wow.cmd remote add MacBook "orca://pair?code=..."
   ```
   Comprueba la conexión antes de guardarla y reinicia el bridge.
3. Si el Mac tiene el cortafuegos activado, permite que Orca acepte conexiones entrantes. Por defecto usa el puerto 6768.

Otros comandos:
- `orca-wow remote list` muestra los Orca remotos y si responden.
- `orca-wow remote remove MacBook` quita uno. Para revocar el acceso en el Mac, usa Settings → Remote Orca Servers → Shared Server Access.
- `orca-wow local off` deja de mostrar el Orca de este PC.

En el juego, los agentes de cada ordenador llevan su nombre y se pueden filtrar por ordenador. Los secretos del enlace (token del dispositivo y clave del Mac) se guardan aparte, en `%LOCALAPPDATA%\orca-wow\config\remotes\`, nunca en `config.json` ni en los logs.

## Usarlo

| En el juego | |
|---|---|
| `/orca` | abrir o cerrar la ventana (también con el botón del minimapa) |
| `/orca new <texto>` | lanzar un agente nuevo (opciones: `--agent codex --name mi-rama --base develop`) |
| `/orca selftest` | comprobar el enlace paso a paso, con el tiempo de ida y vuelta |
| `/orca status` | estado del bridge y de Orca |

| En el ordenador | |
|---|---|
| `orca-wow status [--log]` | lo que ve el bridge (Orca, juego, captura, addon) |
| `orca-wow probe` | captura la esquina del juego e intenta leer la franja |
| `orca-wow run --verbose` | el bridge en primer plano |

## Cómo funciona

Un addon de WoW no puede usar la red ni leer ficheros. El bridge hace de puente así:

- **Del juego al bridge:** el addon pinta una franja de celdas de color, cifrada, en la esquina superior izquierda. Un ayudante nativo (`bridge/native/wowhelper.cs`) la copia de la pantalla en unos 16 ms. Si otra ventana la tapa, usa `PrintWindow`.
- **Del bridge al juego:** el bridge escribe los datos en addons *LoadOnDemand* (`OrcaWow_S###`) y el addon carga el siguiente cuando un archivo de sonido silencioso "suena".
- **Del bridge a Orca:** usa la named pipe local de Orca (`%APPDATA%\orca\orca-runtime.json` da la ruta y el token). Consulta `worktree.ps` cada 2–6 s, lee los terminales con `terminal.read` y escribe en ellos con `terminal.send`, como hacen el CLI y la app móvil de Orca.

Los detalles del enlace con el juego están en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitaciones

- La ventana del juego tiene que estar en pantalla (no minimizada) para que el bridge lea la franja.
- Hay 1200 actualizaciones por sesión de interfaz. Cuando se acaban, haz `/reload`.
- Los mensajes van limitados a unos 2000 caracteres. El historial se reduce al último prompt, la última respuesta y el final del terminal.
- Las preguntas y los menús de permisos se leen de la pantalla del terminal del agente. Los agentes en modo chat de Orca son solo de lectura.
- "Marcar hecho", "Reabrir" y "Dormir" afectan al worktree entero.
- El dictado por voz aún no está disponible en Windows.

## Créditos

- [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow) (MIT, © 2026 Ryan Hughes): el addon, el enlace por franja, slots y campanas, y el bridge del que parte este fork.
- [DSilence/t3wow](https://github.com/DSilence/t3wow): referencia para Windows.
- El logo de los iconos es el de [Orca](https://github.com/stablyai/orca) (MIT, `resources/logo.svg`). `tools/make-icons.mjs` genera los iconos a partir de él.
- [wow-ai](https://github.com/chelinho139/wow-ai) y [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex), cuyas mediciones del cliente Forever sostienen la técnica de franja y slots.

## Licencia

[MIT](LICENSE). Proyecto de fans, sin relación con Blizzard Entertainment, Stably (Orca) ni T3. World of Warcraft es una marca de Blizzard Entertainment.
