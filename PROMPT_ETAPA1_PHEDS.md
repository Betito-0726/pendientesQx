# Traspaso para el agente — Etapa 1: Login y censos PHEDS

Eres un agente que inicia un proyecto NUEVO (workspace limpio, sin contexto
previo). Tu trabajo en esta primera etapa es implementar una app que haga
**login a PHEDS** y **descargue los censos de urgencias y de hospitalización**,
mostrándolos en una **GUI web**. Este documento está escrito para que no repitas
errores que ya costaron días de reconocimiento en el proyecto anterior.

## Contexto

- Usuario: un médico adscrito del IMSS, con credenciales legítimas. Consulta los
  censos de SU unidad (`24HD03`) desde su celular, dentro de la intranet del IMSS.
- Portal: `https://pheds.imss.gob.mx/siah` (ASP clásico).
- Es un sistema EN PRODUCCIÓN con datos reales de pacientes. No es un entorno
  de pruebas.

## Alcance de ESTA etapa (nada más)

1. Login a PHEDS.
2. Descargar el censo de **HOSPITALIZACIÓN** (15 columnas, incluye médico
   tratante) y el de **URGENCIAS** (13 columnas, sin médico tratante).
3. Mostrar ambos censos en una GUI web: selector hospital/urgencias y una lista
   de pacientes con sus campos (NSS, nombre, cama, diagnóstico, médico...).

Fuera de alcance (etapas futuras): documentos de pacientes, laboratorio,
gestión de wifi, hosting público, sincronización. No los construyas ahora, pero
**no pintes la arquitectura en una esquina** que los impida.

## Arquitectura objetivo (recomendada)

- App híbrida con **Capacitor** (HTML/JS/TS + contenedor nativo iOS/Android):
  el MISMO código corre en Android y en iPhone. El usuario NO usa Termux.
- **El teléfono hace el HTTP** directamente contra PHEDS (está en la intranet).
  No hay servidor intermedio.
- La GUI (frontend) debe ser una **SPA de HTML/CSS/JS** autocontenida, para que
  más adelante pueda desplegarse en un hosting público sin depender de un
  backend propio.
- Credenciales SOLO en el dispositivo (almacenamiento seguro: Keychain en iOS /
  Keystore en Android). Nunca en código, nunca en un hosting, nunca en logs.

## Detalle técnico de PHEDS (cuesta caro — no lo reinventes)

### Login (3 pasos)

1. `POST loginBD.asp` con `{usuario, pass, Submit=Entrar}` y Referer `login.html`.
2. `GET derechos.asp`.
3. `GET principal.asp` ← aquí se **valida** el éxito por marcadores de texto
   (`SIMBOLOGIA CAMAS`, `LogOut.asp`, `iFrameprincipal`), NO por HTTP 200.

Mantén las cookies en la misma sesión HTTP (equivalente a `requests.Session`).

### Dos universos: hospital y urgencias

- Los MISMOS endpoints sirven ambas áreas; lo que cambia es el **área activa**
  de la sesión, que se conmuta con `GET CambioUsuario.asp`.
- Verifica el área leyendo el rótulo del menú: `AREA DE HOSPITALIZACION` /
  `AREA DE URGENCIAS`.
- Regla: **quien conmuta, restaura**.

### Censos — la trampa que más costó

Dos pasos: `POST rpt_menu.asp` (prepara el reporte) y luego un `GET` al endpoint
del censo.

- El POST se hace con:
  - `lst_reporte` = `"33"` (hospital) o `"7"` (urgencias).
  - `lst_hosp` = `"24HD03"`, `lst_area` = `"0"`, `division` = `"0"`, `tFormato` = `"P"`.
  - Referer `principal.asp`.
- La respuesta de `rpt_menu.asp` trae un `window.open("...")` en JavaScript, y
  la URL **no es un literal**: el JS declara variables (`cvehos="24HD03"`,
  `area="0"`, ...) y las concatena. Captura las declaraciones de variables y
  **evalúa la concatenación** sustituyéndolas. Si tomas solo el primer literal
  te queda una URL sin `cvehos` y el censo sale vacío con HTTP 200 (bug real).
- Hospital → `rpt_censoH.asp`. Urgencias → `rpt_censo.asp`.
- Valida que el nº de pacientes parseados **cuadre** con el total que declara el
  portal (tabla RESUMEN).

### Reglas transversales

- Solo GET + una lista blanca cerrada de POST (login, `rpt_menu.asp` y los de
  búsqueda). Nunca endpoints cuyo nombre sugiera escritura (Guardar, Alta, Baja...).
- Ritmo humano: pausa de 1–2 s entre peticiones, sin concurrencia.
- HTTP 200 miente: valida HTML por marcadores de texto.
- Encoding mixto: `login.html` es ISO-8859-1; `principal.asp`/censo son UTF-8.
  No confíes en `apparent_encoding` a ciegas.
- Detente y avisa ante 403/429/5xx o redirección a login a media sesión.

## Gotchas de Capacitor / móvil

- El WebView de Capacitor no puede hacer `fetch` contra PHEDS (CORS + origen
  `capacitor://`). Usa **HTTP nativo**: el plugin HTTP de Capacitor o un puente
  nativo.
- PHEDS es HTTPS. Verifica la cadena de confianza; si el certificado da
  problemas, manéjalo explícitamente (no desactives la verificación a ciegas).

## Seguridad y datos

- Todo lo que se descarga lleva NSS/CURP/nombres reales. No versionarlo, no
  subirlo a servicios públicos, no imprimirlo en logs.
- En cualquier informe, refiérete a los pacientes por identificador ficticio.
- Credenciales: se piden una vez, se guardan en almacenamiento seguro del
  dispositivo.

## Entregable de esta etapa

- App Capacitor (Android + iOS) que:
  1. Pide credenciales una vez y las guarda seguras.
  2. Hace login.
  3. Descarga y parsea ambos censos.
  4. Los muestra en una GUI web (selector hospital/urgencias + lista de pacientes).
- Verificación de que el parser cuadra con el total declarado por el portal.

## Cómo trabajar

- **Reconoce antes de programar**: verifica contra capturas reales, no describas
  de memoria.
- **No sobreafirmes**: distingue "el endpoint existe" de "descargué y validé el
  documento".
- Commits pequeños; sin credenciales ni datos de pacientes en git.
