# PHEDS — Censos (Etapa 1)

Prototipo web para iniciar sesión en **PHEDS** (Sistema de Hospitalización del
IMSS) y desplegar los **censos de hospitalización** y **urgencias** de una
unidad en una interfaz web. Corresponde a la **Etapa 1** del proyecto
(`PROMPT_ETAPA1_PHEDS.md`).

> **Sin Capacitor por ahora.** El objetivo de esta etapa es validar la lógica de
> login y descarga/parseo contra el portal real, desplegada como web. En una etapa
> posterior este mismo cliente se empaqueta con Capacitor (HTTP nativo desde el
> teléfono) reutilizando `server/pheds.js` y `server/parser.js`.

## Estado de verificación (contra PHEDS real)

| Censo | Columnas | Parseados | Declarados por el portal | Resultado |
|-------|---------:|----------:|--------------------------:|-----------|
| Hospitalización | 15 | 64 | 64 | ✅ coinciden |
| Urgencias | 13 | 68 | 68 | ✅ coinciden |

La validación del número de pacientes parseados contra el total del RESUMEN del
portal **cuadra en ambos censos**.

## Requisitos

- Node.js ≥ 18 (no se necesitan dependencias de npm).
- Estar en la **intranet del IMSS** (o VPN) para alcanzar `pheds.imss.gob.mx`.
- Credenciales legítimas del médico.

## Puesta en marcha

1. Crea `config.local.json` (ya está en `.gitignore`, **nunca se versiona**):

   ```json
   {
     "pheds": {
       "baseUrl": "https://pheds.imss.gob.mx/siah",
       "unidad": "24HD03",
       "usuario": "TU_MATRICULA",
       "pass": "TU_CONTRASENA"
     }
   }
   ```

2. Arranca el servidor local:

   ```bash
   node server/server.js
   ```

3. Abre **http://127.0.0.1:8080** en el navegador.

El servidor usa las credenciales de `config.local.json` para el auto-login; si
no existen, la web muestra un formulario para ingresarlas una vez (se conservan
solo en la memoria del servidor durante la sesión).

### Modo demo (sin PHEDS)

Para trabajar la interfaz/CSS **sin conexión a la intranet**, se usa un snapshot
anonimizado de los censos (nombres, NSS, agregado, médico y matrícula ficticios;
se conservan servicio, cama, edad, diagnóstico y fechas):

```bash
node server/server.js --demo
```

El snapshot se genera con cualquiera de estos dos scripts (escriben `demo/*.json`,
que el modo `--demo` carga automáticamente):

```bash
node scripts/capturar_demo.js       # CON intranet: descarga real + servicio desde paciente.asp
node scripts/construir_demo_recon.js # SIN intranet: reconstruye desde recon/ (servicio = Esp)
```

> `demo/` está en `.gitignore` (contiene datos clínicos, aunque anonimizados).

### Verificación de punta a punta

```bash
node test/smoke.js      # login + descarga + parseo + totales (ambos censos)
node test/servicio.js   # extracción del servicio real por paciente (hospital)
```

Hacen login, descargan y parsean, e imprimen conteos, columnas, servicios y si
el total cuadra con el RESUMEN (sin exponer datos de pacientes).

## Arquitectura

```
web/               SPA autocontenida (HTML/CSS/JS). Habla solo con /api/.
server/
  server.js        Servidor local: sirve la SPA + API JSON (evita CORS).
  censo.js         Construcción del censo enriquecido (parseo + servicio real).
  pheds.js         Cliente HTTP de PHEDS (sesión/cookies, login, área, censo, servicio).
  parser.js        Parseo del HTML de censos + window.open() + mapa de camas + servicio.
scripts/
  capturar_demo.js       Genera demo/*.json desde PHEDS (intranet).
  construir_demo_recon.js Genera demo/*.json desde recon/ (offline).
test/
  smoke.js         Verificación de punta a punta (login + censos + totales).
  servicio.js      Verificación de la extracción del servicio real por paciente.
config.local.json  Credenciales (gitignored).
```

Flujo: **navegador → servidor local → PHEDS**. El navegador no puede llamar a
PHEDS directamente (CORS + origen), por eso el servidor local actúa de puente.
En la versión Capacitor, el "puente" será el HTTP nativo del teléfono (misma
lógica de `pheds.js`).

## Detalle técnico implementado (verificado contra capturas reales)

- **Login en 3 pasos**: `GET login.html` → `POST loginBD.asp` → `GET derechos.asp`
  → `GET principal.asp`. El éxito se valida por marcadores de texto
  (`SIMBOLOGIA CAMAS`, `LogOut.asp`, `iFrameprincipal`), **no** por HTTP 200.
- **Dos áreas**: se conmutan con `GET CambioUsuario.asp` (toggle). El área activa
  se lee del rótulo `AREA DE HOSPITALIZACION` / `AREA DE URGENCIAS` (normalizando
  espacios en blanco, porque en el HTML viene partido en líneas). Regla
  **quien conmuta, restaura**.
- **Censos en dos pasos**: `POST rpt_menu.asp` (hospital `lst_reporte=33`,
  urgencias `=7`) y luego un `GET` a la URL del censo.
- **La trampa del `window.open()`**: la URL **no es un literal**; el JS declara
  variables (`cvehos="24HD03"`, `area="0"`, …) y las concatena. El parser extrae
  las declaraciones y **evalúa la concatenación** (`extractCensoUrl`). Tomar solo
  el primer literal produce una URL sin `cvehos` → censo vacío (bug real).
- **Validación del total**: el nº de pacientes parseados se compara con
  "Total de Pacientes" del RESUMEN.
- **Servicio real por paciente** (ver abajo): la columna **Área** del censo es
  imprecisa (asume camas 1–40 = cirugía, 41–61 = medicina interna). El servicio
  correcto se lee del panel `paciente.asp` de cada paciente.

### Servicio real por paciente

La columna "Área" del censo de hospitalización agrupa por *central de
enfermería* (camas → central), que **no** refleja el servicio médico real. Para
obtenerlo se hace, por cada paciente:

1. `resumen.asp` → lista de centrales (`Camas.asp?central=X`).
2. `Camasmanejo.asp?central=X` → mapa de camas con el `folio` de cada ocupante
   (y su NSS/CURP en inputs ocultos `hd_nss`/`hd_amedico`).
3. `paciente.asp?folio=X&anio=Y&central=Z` → campo **"Servicio"** (DATOS DE
   INGRESO), que es el servicio médico real (p. ej. `MEDICINA INTERNA`).

El folio se resuelve por NSS (único) y el servicio se cachea por folio, así que
las recargas posteriores son mucho más rápidas. La primera carga descarga ~64
paneles (≈80 s a ritmo humano); luego solo se consultan los folios nuevos.

Pestañas y abreviaturas del servicio:

| Pestaña | Pacientes | Servicio mostrado |
|---------|-----------|-------------------|
| Hospitalización | todos los de hospital | nombre completo (MEDICINA INTERNA, CIRUGÍA GENERAL, …) |
| Recuperación | área física RECUPERACIÓN | `CG`, `TYO`, `ORL`, `OFT`, `URO` |
| UCI | área física UNIDAD DE CUIDADOS INTENSIVOS | `UCI` |
| Urgencias | urgencias | área (CORTA ESTANCIA, OBSERVACIÓN ADULTOS) |

### Reglas transversales respetadas

- Solo `GET` y una **lista blanca cerrada de POST** (`loginBD.asp`,
  `rpt_menu.asp`). Nada de endpoints de escritura.
- **Ritmo humano**: pausa de ~1.2 s entre peticiones de control y ~0.7 s en las
  descargas masivas (folios/servicios); cola que serializa (sin concurrencia) y
  un reintento ante fallos puntuales.
- **HTTP 200 miente**: se valida por marcadores de texto en cada paso.
- Se **detiene y avisa** ante 403/429/5xx o redirección a login a media sesión.

## Seguridad y datos

- Las credenciales viven **solo** en `config.local.json` (gitignored) y en la
  memoria del servidor durante la sesión. Nunca en código ni en logs.
- El servidor escucha en `127.0.0.1` por defecto (solo la máquina local).
- Los censos contienen NSS/CURP/nombres reales: **no versionar** `recon/`, **no
  subir** a servicios públicos, **no registrar** en logs (el código no imprime
  datos de pacientes).

## Limitaciones conocidas

- **Certificado**: PHEDS presenta una cadena de confianza que el cliente estándar
  rechaza; el cliente usa `rejectUnauthorized: false`. Ver nota abajo.
- **Encoding de datos corrupto en origen**: algunos nombres llegan con acentos
  rotos desde PHEDS (p. ej. `MUÑOZ` aparece como `MU&OZ`, `GARCÍA` como `GARCIA`).
  Es un problema de datos del portal, no del parser; se muestran tal cual.
- Es un prototipo de escritorio/web; la persistencia segura de credenciales
  (Keychain/Keystore) y el HTTP nativo del teléfono llegan en la etapa Capacitor.

### Nota sobre el certificado

`rejectUnauthorized: false` desactiva la verificación de la cadena para poder
conectarse. **No es lo ideal**: lo correcto es fijar (pin) el certificado o
instalar la CA del IMSS en el almacén de confianza. Para este prototipo local se
acepta el riesgo; en la versión de producción (Capacitor) debe manejarse el
certificado explícitamente.

## Próximas etapas (fuera del alcance de esta)

- Documentos de pacientes, laboratorio, gestión de wifi, sincronización.
- Empaquetado Capacitor (Android/iOS) con HTTP nativo y almacenamiento seguro.
- Hosting público (la SPA ya es autocontenida para facilitarlo).
