# Guía de usuario de CodeScope

Esta guía describe el flujo público. Los recibos de validación ligados a una máquina y los perfiles locales gestionados son material de mantenimiento y no forman parte de esta guía.

## 1. Configurar repositorios

Copia `config.example.json` como `config.json` y asigna a cada repositorio un alias corto, una raíz absoluta y `read_only: true`. El alias es el único selector de repositorio que aceptan las llamadas MCP. El puente rechaza una raíz o un proyecto enviados como ruta libre.

Mantén `config.json` fuera del control de versiones si contiene rutas locales. Define `CODESCOPE_CONFIG` con su ruta absoluta antes de arrancar el servidor.

## 2. Arrancar el puente

```powershell
$env:CODESCOPE_CONFIG = 'C:\ruta\a\codescope\config.json'
node .\src\server.mjs
```

El servidor usa stdio. Conéctalo desde un cliente MCP que pueda arrancar servidores stdio locales. No añadas un listener HTTP público para solucionar una limitación del cliente.

En Windows, la TUI opcional puede gestionar el perfil local y el ciclo de vida del túnel. No cambia la política de solo lectura del puente. El túnel solo debe iniciarse después de revisar su perfil y la credencial de runtime.

## 3. Seleccionar el repositorio de una conversación

Si la selección por sesión está activa, el agente llama a `bridge_access_status`, muestra en el chat los alias configurados y pregunta cuál quiere usar el usuario. Después llama a `bridge_access_select` para ese alias. Cada llamada de repositorio incluye el alias seleccionado. Cuando cambia la selección, el agente debe mostrar un aviso breve: la conversación solo puede leer el repositorio configurado, seleccionado y de solo lectura hasta liberarlo o hasta que caduque la sesión.

Si el agente no tiene metadatos de sesión o el usuario no ha seleccionado un alias, el puente debe cerrarse. No debe adivinarlo a partir de una ruta mencionada en la conversación.

## 4. Usar las herramientas base

Usa las herramientas de filesystem para lecturas y búsquedas acotadas. Usa Git para estado, referencias inmutables, historial y diffs. Usa `design_guidance` cuando el usuario pida la política advisory de diseño del proyecto.

Trata `truncated: true`, un cursor de continuación, un contador de redacciones o una denegación como parte de la respuesta. No presentes un resultado parcial como si fuese una lectura completa.

## 5. Usar backends opcionales

Codebase Memory y Context Mode son opt-in por repositorio. Deben estar configurados con raíces coincidentes, flags de solo lectura, rutas de fuente/corpus acotadas y una instalación validada. El autodescubrimiento es una comprobación de lectura y no crea un vínculo. Si falta la instalación o el vínculo no está listo, explica que ese contexto opcional no está disponible y continúa con filesystem/Git cuando corresponda.

Las instrucciones de Ponytail son advisory y opcionales. Su ausencia no debe desactivar el puente base ni las instrucciones de diseño.

## 6. Reglas de seguridad para el agente

- Nunca pidas leer la raíz del repositorio, una ruta absoluta, `.git`, un archivo de entorno, credenciales, claves privadas, certificados o archivos de tokens.
- Nunca solicites escrituras, commits, checkout, reset, cambios del índice, reindexado u operaciones de administración de backends.
- Nunca inventes un alias, ID de sesión, nombre de proyecto, raíz, revisión o vínculo de backend opcional.
- No muestres en la respuesta rutas absolutas locales, PIDs, credenciales, identificadores de túnel ni artefactos internos de validación.
- Separa los datos observados por las herramientas, las inferencias y lo bloqueado o no probado.
- Mantén la conversación en el idioma del usuario. Estas instrucciones en inglés no cambian el idioma del usuario.

## 7. Diagnóstico

- `config_missing`: define `CODESCOPE_CONFIG` o coloca un `config.json` local junto al entrypoint del servidor.
- `repository_access_required` o `session_required`: selecciona un alias configurado en la sesión actual.
- `path_denied` o `secret_denied`: la ruta o el contenido pedido queda fuera de la política de lectura pública.
- `backend_unavailable`: el backend opcional falta, está desactivado o no está vinculado a este repositorio.
- Si una prueba indica que falta `BRIDGE_COMMAND`, es un problema de configuración del harness; no demuestra que la prueba de seguridad del puente haya pasado.
