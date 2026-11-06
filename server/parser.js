'use strict';
// parser.js — Parseo del HTML de los censos de PHEDS.
// Devuelve estructura JSON limpia (columnas + filas + resumen + validacion).
// NO imprime datos de pacientes: este modulo solo transforma texto.

// ---- Decodificacion de entidades HTML (las usadas por PHEDS/ASP) ----
const NAMED_ENTITIES = {
  nbsp: '\u00A0',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  Aacute: '\u00C1', aacute: '\u00E1',
  Eacute: '\u00C9', eacute: '\u00E9',
  Iacute: '\u00CD', iacute: '\u00ED',
  Oacute: '\u00D3', oacute: '\u00F3',
  Uacute: '\u00DA', uacute: '\u00FA',
  Ntilde: '\u00D1', ntilde: '\u00F1',
  Uuml: '\u00DC', uuml: '\u00FC',
  iexcl: '\u00A1', iquest: '\u00BF',
  laquo: '\u00AB', raquo: '\u00BB',
  deg: '\u00B0', middot: '\u00B7', mdash: '\u2014', ndash: '\u2013',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

// Quita acentos para comparar/normalizar encabezados.
function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeHeader(label) {
  const noAcc = stripAccents(label)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return noAcc;
}

// Mapea un encabezado de columna (hospital o urgencias) a una clave canonica.
// Ambas areas comparten claves, lo que simplifica la GUI.
function mapHeader(label) {
  const n = stripAccents(label).toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^no\.?$/.test(n)) return 'no';
  if (/^area$/.test(n) || /^servicio$/.test(n)) return 'area';
  if (/^cama$/.test(n)) return 'cama';
  if (/^nss$/.test(n)) return 'nss';
  if (n.includes('nombre')) return 'nombre';
  if (/^edad$/.test(n)) return 'edad';
  if (n.includes('medico')) return 'medico';
  if (/^esp$/.test(n)) return 'esp';
  if (n.includes('diagnostico')) return 'diagnostico';
  if (n.includes('ingreso')) return 'ingreso';
  if (n.includes('resolucion') && n.includes('fecha')) return 'resolucion_fecha';
  if (n.includes('resolucion')) return 'resolucion';
  if (n.includes('estancia')) return 'estancia';
  if (n.includes('alta')) return 'alta';
  if (n.includes('espera')) return 'espera';
  return null;
}

// ---- Extraccion de texto de una celda (preserva saltos de <br>) ----
function cellText(html) {
  let s = html.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\r\f\v\u00A0]+/g, ' ').trim();
  s = s.replace(/\n\s*\n+/g, '\n');
  s = s.replace(/ *\n */g, '\n');
  return s.trim();
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

// ---- Extraccion de la URL del censo desde la respuesta de rpt_menu.asp ----
// El JS declara variables (cvehos="24HD03", area="0", ...) y concatena en window.open(...).
// Evaluamos la concatenacion sustituyendo los valores declarados.
function extractCensoUrl(html) {
  const txt = html.toString('utf8');
  const scripts = txt.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const js = scripts.map((m) => m.replace(/<script[^>]*>|<\/script>/gi, '')).join('\n');

  // Declaraciones como sentencias completas "nombre = \"valor\";" (evita matchear dentro de window.open).
  const vars = {};
  for (const stmt of js.split(';')) {
    const m = stmt.match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*("([^"]*)"|'([^']*)')\s*$/);
    if (m) vars[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }

  const wo = js.match(/window\.open\s*\(\s*([^)]*?)\s*\)/);
  if (!wo) throw new Error('window.open no encontrado en rpt_menu.asp');

  const tokens = wo[1].split('+').map((t) => t.trim());
  let url = '';
  for (let tok of tokens) {
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      url += tok.slice(1, -1);
    } else if (/^[A-Za-z_$][\w$]*$/.test(tok)) {
      url += (vars[tok] ?? '');
    } else {
      url += tok;
    }
  }

  // Guarda: debe ser una URL relativa a un censo conocido, no un literal mal formado.
  if (!/^rpt_censo(H)?\.asp\?/.test(url)) {
    throw new Error(`URL de censo no reconocida: ${url}`);
  }
  return url;
}

// ---- Identifica la tabla principal de datos ----
function findDataTable(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    if (/Nombre del Paciente/i.test(t) && /NSS/i.test(t)) return t;
  }
  throw new Error('No se encontro la tabla de datos del censo');
}

// ---- Parseo del RESUMEN (Total de Pacientes, ocupacion, etc.) ----
function parseResumen(html) {
  const resumen = {};
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let resumenTable = null;
  for (const t of tables) {
    if (/RESUMEN/i.test(t)) { resumenTable = t; break; }
  }
  if (resumenTable) {
    const rows = resumenTable.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      if (cells.length >= 2) {
        const k = stripTags(cells[0]).replace(/\s+/g, ' ').trim();
        const v = stripTags(cells[1]).replace(/\s+/g, ' ').trim();
        if (k) resumen[k] = v;
      }
    }
  }
  return resumen;
}

// ---- Parseo principal ----
// Devuelve { titulo, fecha, columnas, filas, resumen, totalDeclarado, validacion }
function parseCenso(html) {
  const text = html.toString('utf8');
  const table = findDataTable(text);

  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  // Localizar la fila de encabezados de columna (la que tiene "Nombre del Paciente").
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (/Nombre del Paciente/i.test(rows[i]) && /NSS/i.test(rows[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('No se encontro la fila de encabezados de columna');

  const headerCells = rows[headerIdx].match(/<td[\s\S]*?<\/td>/gi) || [];
  const columnas = headerCells.map((c) => stripTags(c).replace(/\s+/g, ' ').trim());
  const nCols = columnas.length;

  // Filas de datos: posteriores al encabezado y con el mismo numero de celdas.
  const filas = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i].match(/<td[\s\S]*?<\/td>/gi);
    if (!cells) continue;
    if (cells.length === nCols) {
      const valores = cells.map((c) => cellText(c));
      // Ignorar filas vacias (todas las celdas en blanco).
      if (valores.some((v) => v !== '')) filas.push(valores);
    }
  }

  // Resumen y total declarado.
  const resumen = parseResumen(text);
  let totalDeclarado = null;
  for (const k of Object.keys(resumen)) {
    if (/Total de Pacientes/i.test(k)) {
      const n = parseInt(resumen[k], 10);
      if (!Number.isNaN(n)) totalDeclarado = n;
    }
  }

  // Titulo y fecha.
  const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
  const titulo = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const fechaMatch = text.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*[ap]\.?\s*m\.?)/i);
  const fecha = fechaMatch ? fechaMatch[1].trim() : '';

  const parseados = filas.length;
  const ok = totalDeclarado === null ? null : (parseados === totalDeclarado);

  return { titulo, fecha, columnas, filas, resumen, totalDeclarado, validacion: { parseados, declarados: totalDeclarado, ok } };
}

// ---- Centrales de enfermeria (desde resumen.asp "Distribucion de Camas") ----
// Devuelve [{ central, nombre }].
function parseCentrales(resumenHtml) {
  const txt = resumenHtml.toString('utf8');
  const out = [];
  const seen = new Set();
  for (const m of txt.matchAll(/Camas\.asp\?central=(\d+)"[^>]*>([^<]*)<\/a>/gi)) {
    const central = m[1];
    const nombre = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (central && nombre && !seen.has(central)) {
      seen.add(central);
      out.push({ central, nombre });
    }
  }
  return out;
}

// ---- Mapa de camas (desde Camasmanejo.asp?central=X) ----
// Cada cama tiene: <strong>N</strong>, paciente.asp?folio=X&anio=Y&central=Z,
// y los inputs ocultos hd_nss / hd_amedico (NSS y agregado del ocupante).
// Devuelve [{ cama, folio, anio, central, nss, agregado }] (solo camas ocupadas con folio).
function parseCamaFolios(html, central) {
  const txt = html.toString('utf8');
  const out = [];
  const parts = txt.split(/<strong>/);
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    // Etiqueta de cama: numerica ("1") o alfanumerica ("CA05", "U01", ...).
    const camaM = seg.match(/^([^<]+)<\/strong>/);
    if (!camaM) continue; // encabezados con <br /> u otros
    const cama = camaM[1].trim();
    if (!cama) continue;
    const folioM = seg.match(/paciente\.asp\?folio=(\d+)/);
    if (!folioM) continue; // cama vacia (usa mensajeCama.asp)
    const anioM = seg.match(/anio=(\d+)/);
    const nssM = seg.match(/hd_nss\w*"[^>]*?value="([^"]*)"/i);
    const agregadoM = seg.match(/hd_amedico\w*"[^>]*?value="([^"]*)"/i);
    out.push({
      cama,
      folio: folioM[1],
      anio: anioM ? anioM[1] : '26',
      central: central ? String(central) : undefined,
      nss: nssM ? nssM[1].trim() : '',
      agregado: agregadoM ? agregadoM[1].trim() : '',
    });
  }
  return out;
}

// ---- Servicio real (desde paciente.asp?folio=X) ----
// Extrae el valor del campo "Servicio" (DATOS DE INGRESO).
function extractServicio(html) {
  const txt = html.toString('utf8');
  const m = txt.match(/Servicio\s*<\/span>\s*(?:<br\s*\/?\s*>)?\s*<span[^>]*>\s*([^<]*?)\s*<\/span>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

module.exports = {
  decodeEntities,
  stripAccents,
  normalizeHeader,
  mapHeader,
  extractCensoUrl,
  parseCenso,
  parseCentrales,
  parseCamaFolios,
  extractServicio,
};
