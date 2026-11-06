'use strict';
// censo.js — Construccion del censo enriquecido (parseo + servicio real).
// Reutilizado por server.js (API) y por scripts/capturar_demo.js (fixtures offline).
const parser = require('./parser');

// Mapea las filas crudas del censo a objetos con claves canonicas.
function enrich(area, parsed) {
  const pacientes = parsed.filas.map((vals, idx) => {
    const p = { _id: `p${idx + 1}` };
    vals.forEach((v, i) => {
      const key = parser.mapHeader(parsed.columnas[i]);
      if (key) p[key] = v;
    });
    // La columna "area" del censo es la central (imprecisa); se corrige luego.
    if (p.area) p.servicio = p.area;
    // NSS + Agregado (vienen en dos lineas; el agregado NO es el CURP).
    if (typeof p.nss === 'string' && p.nss.includes('\n')) {
      const [nss, agregado] = p.nss.split('\n').map((s) => s.trim());
      p.nss = nss; p.agregado = agregado || '';
    }
    // Medico tratante "NOMBRE/MATRICULA".
    if (typeof p.medico === 'string' && p.medico.includes('/')) {
      const [nombre, matricula] = p.medico.split('/').map((s) => s.trim());
      p.medico = nombre; p.medico_matricula = matricula || '';
    }
    // Diagnostico "CODIGO - descripcion".
    if (typeof p.diagnostico === 'string') {
      const i = p.diagnostico.indexOf('-');
      if (i > 0) { p.dx_codigo = p.diagnostico.slice(0, i).trim(); p.dx_descripcion = p.diagnostico.slice(i + 1).trim(); }
    }
    // Especialidad de ingreso a piso (urgencias): "HOSPITAL [INGRESO A PISO] / X".
    if (typeof p.resolucion === 'string') {
      const m = p.resolucion.match(/HOSPITAL\s*\[\s*INGRESO\s+A\s+PISO\s*\]\s*\/\s*([^\n]+)/i);
      p.especialidad_ingreso = m ? m[1].trim() : null;
    }
    return p;
  });
  const servicios = [...new Set(pacientes.map((p) => p.servicio).filter(Boolean))].sort();
  return { area, titulo: parsed.titulo, fecha: parsed.fecha, columnas: parsed.columnas, pacientes, servicios, resumen: parsed.resumen, totalDeclarado: parsed.totalDeclarado, validacion: parsed.validacion };
}

// Abreviatura del servicio segun el area fisica del paciente.
function abreviarServicio(servicio, area) {
  const s = parser.stripAccents(servicio).toUpperCase().replace(/\s+/g, ' ').trim();
  const a = parser.stripAccents(area).toUpperCase().replace(/\s+/g, ' ').trim();
  if (/UNIDAD DE CUIDADOS INTENSIVOS/.test(a)) return 'UCI';
  if (/RECUPERACION/.test(a)) {
    if (/CIRUGIA GENERAL/.test(s)) return 'CG';
    if (/TRAUMATOLOGIA|ORTOPEDIA/.test(s)) return 'TYO';
    if (/OTORRINO/.test(s)) return 'ORL';
    if (/OFTALMO/.test(s)) return 'OFT';
    if (/UROLOGI/.test(s)) return 'URO';
    return null;
  }
  return null;
}

// Adjunta el servicio REAL (desde paciente.asp) a cada paciente de hospitalizacion.
async function adjuntarServicios(client, result) {
  // 1. Mapa NSS -> { folio, anio, central } desde el mapa de camas (por central).
  const centrales = await client.getCentrales();
  const folioMap = new Map();
  for (const c of centrales) {
    let folios;
    try { folios = await client.getCamaFolios(c.central); }
    catch (e) { continue; } // una central sin camas/no disponible no debe tumbar todo
    for (const f of folios) if (f.nss) folioMap.set(f.nss, f);
  }

  // 2. Para cada paciente, resolver folio por NSS y leer el servicio real.
  for (const p of result.pacientes) {
    const f = folioMap.get(p.nss);
    if (!f) {
      p.servicio_real = null;
      p.servicio_abrev = null;
      p.servicio_verificado = false;
      continue;
    }
    let s = '';
    try { s = await client.getPacienteServicio(f.folio, f.anio, f.central); }
    catch (e) { s = ''; }
    if (s) {
      p.servicio_real = s;
      p.servicio = s; // reemplaza el area imprecisa por el servicio real
      p.servicio_abrev = abreviarServicio(s, p.area);
      p.servicio_verificado = true;
    } else {
      p.servicio_real = null;
      p.servicio_abrev = abreviarServicio(p.area, p.area) || null;
      p.servicio_verificado = false;
    }
  }

  // 3. Recalcular la lista de servicios (ahora con los reales).
  result.servicios = [...new Set(result.pacientes.map((p) => p.servicio).filter(Boolean))].sort();
}

// Descarga, parsea y enriquece un censo (hospital incluye el servicio real).
async function buildCenso(client, area) {
  const html = await client.downloadCenso(area);
  const parsed = parser.parseCenso(html);
  const r = enrich(area, parsed);
  if (area === 'hospital') await adjuntarServicios(client, r);
  return r;
}

module.exports = { enrich, abreviarServicio, adjuntarServicios, buildCenso };
