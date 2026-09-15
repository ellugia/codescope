# CodeScope

CodeScope es un puente MCP local y de solo lectura para inspeccionar repositorios configurados de forma explícita. Ofrece al agente lecturas acotadas del sistema de archivos y de Git sin aceptar rutas arbitrarias, raíces libres ni operaciones de escritura desde la conversación.

[Read this in English](README.md) · [Guía de usuario](docs/user-guide.es.md) · [User guide](docs/user-guide.en.md)

## Qué hace

- relaciona alias cortos con raíces absolutas locales;
- lee archivos UTF-8 y listados de directorios acotados mediante una lista permitida;
- lee estado, historial, referencias y diffs limitados de Git sin ejecutar helpers externos;
- mantiene explícitas la selección de repositorio y la sesión cuando se activa ese modo;
- ofrece instrucciones de diseño advisory y versionadas;
- puede añadir Codebase Memory o Context Mode solo cuando existe un vínculo por repositorio, de solo lectura, validado;
- funciona por stdio local. El modo local es el único transporte incluido en esta versión.

El puente no es un servidor de sistema de archivos general, no ofrece una API de escritura de Git, no es un proxy MCP arbitrario y no abre un listener HTTP público por defecto.

## Requisitos

- Node.js 24.19 o posterior;
- Git disponible como `git` o configurado mediante la ruta absoluta de su ejecutable;
- un archivo de configuración local con una o más entradas de repositorio de solo lectura.

## Inicio rápido

Desde un paquete npm instalado:

```sh
npm install codescope-bridge
npx codescope init --config ./config.json
```

Edita `config.json` y sustituye la raíz de ejemplo por una ruta absoluta de la máquina local. Todos los repositorios deben conservar `read_only` a `true`:

```json
{
  "git_binary": "git",
  "default_repository": "main",
  "repositories": {
    "main": {
      "root": "C:/ruta/al/repositorio",
      "read_only": true
    }
  },
  "optional_backends": {
    "auto_discover": false,
    "bindings": {}
  }
}
```

La TUI puede marcar un repositorio configurado con `enabled: false` sin borrarlo. Las entradas desactivadas permanecen en el archivo local, pero el puente no las expone. La UI también conserva y activa o desactiva bindings configuradas de solo lectura para Codebase Memory y Context Mode; no inventa rutas de backend.

Arranca el servidor local por stdio:

```sh
npx codescope serve --config ./config.json
```

El proceso lee peticiones desde stdio y escribe las respuestas del protocolo en stdout. Los logs operativos van a stderr. El modo local no inicia un túnel, no abre un listener de red y no necesita una API key de OpenAI.

## Comando npm

El paquete incluye una pequeña CLI de Node. Desde un checkout, o después de instalar el paquete en la carpeta de una aplicación local:

```sh
npm install .
npx codescope init --config ./config.json
npx codescope serve --config ./config.json
```

`init` solo crea una plantilla local y se niega a sustituir un archivo existente salvo que se indique `--force`. `serve` inicia el mismo puente stdio que `node src/server.mjs`.

Para la configuración y el diagnóstico locales interactivos, ejecuta `npx codescope ui --config ./config.json`. La UI gestiona la preparación local; `serve` sigue siendo el puente MCP por stdio.
La UI también puede ejecutar `serve` en primer plano para una comprobación local; pulsa `Ctrl+C` para detenerlo. Normalmente el propio cliente MCP es quien arranca `serve`.

El paquete npm excluye deliberadamente `deps/`, perfiles gestionados, cachés, evidencias de pruebas, launchers de Windows y contenido real de repositorios.

`codex-repositories` es una ayuda de importación para la configuración local:

```sh
npx codescope codex-repositories
```

Lee únicamente `CODEX_HOME/config.toml`. Si `CODEX_HOME` no está definido, comprueba `~/.codex/config.toml` en Linux y macOS, y el `.codex/config.toml` equivalente del directorio de usuario en Windows. Extrae las secciones `[projects.'...']` y `[projects."..."]` como candidatos. El usuario debe elegir qué candidatos copiar a la configuración propia de CodeScope; una entrada de proyecto de Codex nunca concede acceso por sí sola.

## Acceso al repositorio y a la sesión

Las rutas nunca llegan desde una llamada MCP. La llamada usa un alias, por ejemplo `main`, y la configuración resuelve ese alias a la raíz aprobada. Cuando `session_access.mode` es `session_select`, el cliente debe mostrar primero los alias disponibles con `bridge_access_status` y después seleccionar uno explícitamente con `bridge_access_select`. La sesión puede liberar un alias o restablecer todas las selecciones.

Las instrucciones destinadas al modelo en [`chatgpt/`](chatgpt/) están escritas en inglés para que sean portables entre máquinas. Exigen de forma explícita que la conversación visible conserve el idioma del usuario.

## Herramientas disponibles

El catálogo base contiene herramientas de filesystem y Git de solo lectura, además de `design_guidance`. El catálogo exacto se devuelve mediante `tools/list` para la configuración activa. Las herramientas opcionales solo se anuncian cuando su vínculo por repositorio ha pasado la validación.

| Área | Ejemplos |
| --- | --- |
| Filesystem | `fs_read_text`, `fs_list`, `fs_find`, `fs_search_content` |
| Git | `git_status`, `git_head`, `git_ref`, `git_log`, `git_diff`, `git_diff_staged`, `git_diff_unstaged` |
| Diseño | `design_guidance` |
| Opcionales, opt-in | `cbm_status`, `cbm_search`, `cbm_trace`, `cbm_snippet`, `context_mode_search` |

Todos los resultados tienen límites de bytes, entradas, líneas, coincidencias, profundidad, tiempo y concurrencia. Las lecturas y diffs grandes usan cursores firmados de continuación. Las herramientas desconocidas, las escrituras ocultas, los recursos, los prompts, el sampling y la elicitation se rechazan.

## Integraciones opcionales

Codebase Memory y Context Mode son opcionales. El autodescubrimiento solo comprueba rutas locales conocidas; no inicia procesos, no indexa repositorios, no lee credenciales ni crea vínculos. Para exponer un backend opcional hay que configurarlo para un alias concreto, marcarlo como de solo lectura y limitar sus proyectos, raíces, corpus y almacenes a ese repositorio. Si el vínculo no está listo, la herramienta opcional permanece cerrada y el filesystem y Git base siguen disponibles.

Las instrucciones de Ponytail también son opcionales y solo se anuncian tras validar los marcadores de la instalación local. Las instrucciones de diseño siguen disponibles sin Ponytail.

## Frontera de seguridad

- las raíces son absolutas, se configuran localmente y se vuelven a comprobar antes de cada acceso;
- se rechazan traversal, sintaxis de raíz alternativa, symlinks, reparse points, hardlinks y rutas protegidas;
- se bloquean o redactan `.git`, archivos de entorno, credenciales, claves privadas, certificados y contenido que coincida con secretos;
- Git se ejecuta sin shell, prompts de terminal, helpers de diff ni convertidores de texto, y limita `safe.directory` a la raíz canónica seleccionada;
- no se expone ninguna operación de escritura del repositorio;
- el puente no hace conexiones de red en modo local; el acceso a los repositorios sale únicamente de su configuración local.

Estos controles los aplica el puente. Las anotaciones MCP como `readOnlyHint` son metadatos descriptivos y no funcionan como autorización.

## Comprobaciones

```sh
npm run check
npm run doctor
```

`npm run check` crea y elimina datos de prueba desechables y comprueba filesystem, Git, cursores, límites, secretos y superficie MCP. `npm run doctor` revisa los repositorios configurados sin iniciar otro servicio. Las pruebas que arrancan un bridge aparte requieren `BRIDGE_COMMAND` y `BRIDGE_ARGS_JSON`; si falta el harness se informa como bloqueado, no como un falso verde.

## Superficie de comandos local

La CLI de Node y la TUI de terminal son la superficie local soportada en Windows, Linux y macOS. Usa `npx codescope ...` para la configuración, el servidor, el diagnóstico y el descubrimiento de repositorios de Codex. Los launchers de PowerShell, los scripts de túnel y la autenticación remota quedan fuera de esta release.

## Estado del proyecto

El alcance de la release es únicamente local. Antes de publicar hay que elegir la licencia del proyecto, ejecutar `npm pack --dry-run` y completar un canario local por stdio en los sistemas operativos soportados. El túnel y la autenticación remota quedan fuera de esta release.
