# Guía de usuario de CodeScope

Esta guía explica el flujo público admitido.

## 1. Configurar repositorios

Instala `codescope` en la carpeta del proyecto actual con npm:

```sh
npm install @ellugia/codescope
```

Después, ejecuta la configuración guiada:

```sh
codescope setup
```

Añade cada repositorio con un alias corto, su carpeta y `read_only: true`. El
alias es el único selector de repositorio que aceptan las llamadas MCP. El
puente rechaza una raíz o un proyecto enviados como ruta libre. El setup
también ofrece registrar CodeScope en Codex y nunca sustituye una entrada
`codescope` existente.

Usa `--config <archivo>` o `CODESCOPE_CONFIG` si necesitas un archivo de configuración personalizado. Mantén ese archivo privado cuando contenga ajustes propios de tu máquina.

La TUI puede desactivar un repositorio con `enabled: false` y conservar su entrada para volver a activarlo. El puente solo expone las entradas activas y siempre exige `read_only: true`.

## 2. Arrancar el puente

La instalación normal de npm es local. Para los comandos manuales de esta
guía, usa desde la carpeta de instalación la entrada del paquete:

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs <comando>
```

Si `codescope` ya está en tu `PATH`, la forma abreviada es equivalente.

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs serve
```

El servidor usa stdio. Conéctalo desde un cliente MCP que pueda arrancar servidores stdio locales. No añadas un listener HTTP público para solucionar una limitación del cliente.

Para una preparación basada en scripts y sin TUI, la CLI de npm también ofrece:

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs init
node node_modules/@ellugia/codescope/bin/codescope.mjs serve
```

El modo local funciona sin un servicio adicional ni credenciales de API. El paquete incluye directamente la CLI de Node y la TUI admitidas.

La CLI de Node y la TUI de terminal son la interfaz admitida en Windows, Linux y macOS. Con la instalación local normal, usa `node node_modules/@ellugia/codescope/bin/codescope.mjs <comando>` para la configuración, el servidor, el diagnóstico y el descubrimiento de repositorios de Codex. La forma abreviada `codescope <comando>` es equivalente cuando el bin está en tu `PATH`.

Para la configuración y el diagnóstico locales interactivos, ejecuta:

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs ui
```

La UI gestiona la preparación y el diagnóstico locales; `serve` sigue siendo el puente MCP por stdio.
La UI también puede ejecutar `serve` en primer plano para una comprobación local; pulsa `Ctrl+C` para detenerlo. Normalmente el propio cliente MCP es quien arranca `serve`.

## 3. Importar candidatos desde Codex

`node node_modules/@ellugia/codescope/bin/codescope.mjs codex-repositories` lee la configuración de Codex, extrae sus proyectos y muestra carpetas candidatas. Es solo una lista de descubrimiento: el usuario debe elegir los candidatos y copiarlos a la configuración propia de CodeScope. CodeScope nunca convierte por sí solo la lista de proyectos de Codex en autorización.

## 4. Seleccionar el repositorio de una conversación

Si la selección por sesión está activa, el agente llama a `bridge_access_status`, muestra en el chat los alias configurados y pregunta cuál quiere usar el usuario. Después llama a `bridge_access_select` para ese alias. Cada llamada de repositorio incluye el alias seleccionado. Cuando cambia la selección, el agente debe mostrar un aviso breve: la conversación solo puede leer el repositorio configurado, seleccionado y de solo lectura hasta liberarlo o hasta que caduque la sesión.

Si el agente no tiene metadatos de sesión o el usuario no ha seleccionado un alias, el puente debe cerrarse. No debe adivinarlo a partir de una ruta mencionada en la conversación.

## 5. Usar las herramientas base

Usa las herramientas de filesystem para lecturas y búsquedas acotadas. Usa Git para estado, referencias inmutables, historial y diffs. Usa `design_guidance` cuando el usuario pida la política advisory de diseño del proyecto.

Trata `truncated: true`, un cursor de continuación, un contador de redacciones o una denegación como parte de la respuesta. No presentes un resultado parcial como si fuese una lectura completa.

## 6. Usar backends opcionales

Codebase Memory y Context Mode son opt-in por repositorio. Deben estar configurados con raíces coincidentes, flags de solo lectura, rutas de fuente/corpus acotadas y una instalación validada. El autodescubrimiento es una comprobación de lectura y no crea un vínculo. Si falta la instalación o el vínculo no está listo, explica que ese contexto opcional no está disponible y continúa con filesystem/Git cuando corresponda.

Las instrucciones de Ponytail son advisory y opcionales. Su ausencia no debe desactivar el puente base ni las instrucciones de diseño.

## 7. Reglas de seguridad para el agente

- Nunca pidas leer fuera de un repositorio configurado ni `.git`, archivos de entorno, credenciales, claves privadas, certificados o archivos de tokens.
- Nunca solicites escrituras, commits, checkout, reset, cambios del índice, reindexado u operaciones de administración de backends.
- Nunca inventes un alias, ID de sesión, nombre de proyecto, raíz, revisión o vínculo de backend opcional.
- No muestres en la respuesta ubicaciones del sistema, PIDs, credenciales ni artefactos de pruebas.
- Separa los datos observados por las herramientas, las inferencias y lo bloqueado o no probado.
- Mantén la conversación en el idioma del usuario. Estas instrucciones en inglés no cambian el idioma del usuario.

## 8. Diagnóstico

- `config_missing`: ejecuta `codescope setup`. También puedes pasar `--config` o definir `CODESCOPE_CONFIG`. Se sigue admitiendo por compatibilidad un `config.json` existente en el directorio de trabajo actual.
- `repository_access_required` o `session_required`: selecciona un alias configurado en la sesión actual.
- `path_denied` o `secret_denied`: la ruta o el contenido pedido queda fuera de la política de lectura pública.
- `backend_unavailable`: el backend opcional falta, está desactivado o no está vinculado a este repositorio.
