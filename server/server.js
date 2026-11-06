'use strict';
// server.js — Servidor local minimo (sin dependencias).
// - Sirve la SPA (web/).
// - Expone API JSON que hace el HTTP contra PHEDS (login + descarga de censos).
// Evita CORS: el navegador solo habla con este server local; el server habla con PHEDS.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PhedsClient, PhedsError } = require('./pheds');
const censo = require('./censo');
const { resolverCie9 } = require('./deepseek');
const cirugias = require('./cirugias');
const expedientes = require('./expedientes');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');

const WEB_DIR = path.join(__dirname, '..', 'web');

// Credenciales por defecto (opcional): config.local.json (gitignored).
let defaultCreds = null;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.local.json'), 'utf8'));
  defaultCreds = cfg.pheds ? { usuario: cfg.pheds.usuario, pass: cfg.pheds.pass } : null;
} catch (_) { /* sin config.local.json */ }

const client = new PhedsClient({
  baseUrl: 'https://pheds.imss.gob.mx/siah',
  unidad: (defaultCreds && process.env.UNIDAD) || '24HD03',
  pausaMs: 1200,
  pausaDetalleMs: 700,
});

// Cola simple para serializar peticiones a PHEDS (sin concurrencia, ritmo humano).
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// ---------- demo (datos ficticios, sin PHEDS) ----------
// Si existen fixtures capturados (scripts/capturar_demo.js), los sirve; si no,
// usa un minimo de datos ficticios.
const DEMO_DIR = path.join(__dirname, '..', 'demo');

function demoCenso(area) {
  const file = path.join(DEMO_DIR, area + '.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* usa fallback */ }
  }
  return demoCensoFallback(area);
}

function demoCensoFallback(area) {
  const columnas = area === 'hospital'
    ? ['No.', 'Área', 'Cama', 'NSS', 'Nombre del Paciente', 'Edad', 'Médico Tratante', 'Esp', 'Diagnóstico', 'Fecha y Hora Ingreso', 'Días de Estancia', 'Fecha y Hora Alta', 'Resolución', 'Fecha y Hora Resolución', 'Días de espera para salir del Hospital']
    : ['No.', 'Área', 'Cama', 'NSS', 'Nombre del Paciente', 'Edad', 'Diagnóstico', 'Fecha y Hora Ingreso', 'Hora de Estancia', 'Fecha y Hora Alta', 'Resolución', 'Fecha y Hora Resolución', 'Horas espera para salir de Urgencias'];
  const pacientes = [
    { no: '1', area: 'CIRUGÍA', cama: '12', nss: '0000000000', agregado: '1M1968OR', nombre: 'PACIENTE DEMOSTRACIÓN UNO', edad: '45', medico: 'MEDICO EJEMPLO', medico_matricula: '00000000', esp: 'CIR', diagnostico: 'K805 - Calculo de conducto biliar sin colangitis ni colecistitis', dx_codigo: 'K805', dx_descripcion: 'Calculo de conducto biliar sin colangitis ni colecistitis', ingreso: '01/11/2026 08:00:00 a. m.', estancia: 'Desde ingreso: 3.12 días.', alta: '', resolucion: 'HOSPITAL', resolucion_fecha: '', espera: '', servicio: 'CIRUGÍA GENERAL', servicio_real: 'CIRUGÍA GENERAL', servicio_abrev: null, servicio_verificado: true },
    { no: '2', area: 'MEDICINA', cama: '5', nss: '1111111111', agregado: '2M1958OR', nombre: 'PACIENTE DEMOSTRACIÓN DOS', edad: '68', medico: 'MEDICO EJEMPLO', medico_matricula: '00000000', esp: 'MED', diagnostico: 'I500 - Insuficiencia cardiaca congestiva', dx_codigo: 'I500', dx_descripcion: 'Insuficiencia cardiaca congestiva', ingreso: '28/10/2026 20:00:00 p. m.', estancia: 'Desde ingreso: 6.45 días.', alta: '', resolucion: 'HOSPITAL', resolucion_fecha: '', espera: '', servicio: 'MEDICINA INTERNA', servicio_real: 'MEDICINA INTERNA', servicio_abrev: null, servicio_verificado: true },
    { no: '3', area: 'RECUPERACIÓN', cama: 'R1', nss: '2222222222', agregado: '3M1987OR', nombre: 'PACIENTE DEMOSTRACIÓN TRES', edad: '39', medico: 'MEDICO EJEMPLO', medico_matricula: '00000000', esp: 'TRA', diagnostico: 'S72.0 - Fractura del cuello del femur', dx_codigo: 'S72.0', dx_descripcion: 'Fractura del cuello del femur', ingreso: '04/11/2026 10:00:00 a. m.', estancia: 'Desde ingreso: 0.5 días.', alta: '', resolucion: 'RECUPERACIÓN', resolucion_fecha: '', espera: '', servicio: 'TRAUMATOLOGÍA Y ORTOPEDIA', servicio_real: 'TRAUMATOLOGÍA Y ORTOPEDIA', servicio_abrev: 'TYO', servicio_verificado: true },
    { no: '4', area: 'UNIDAD DE CUIDADOS INTENSIVOS ADULTOS', cama: 'U1', nss: '3333333333', agregado: '4M1952OR', nombre: 'PACIENTE DEMOSTRACIÓN CUATRO', edad: '72', medico: 'MEDICO EJEMPLO', medico_matricula: '00000000', esp: 'MED', diagnostico: 'I21 - Infarto agudo del miocardio', dx_codigo: 'I21', dx_descripcion: 'Infarto agudo del miocardio', ingreso: '03/11/2026 22:00:00 p. m.', estancia: 'Desde ingreso: 1.2 días.', alta: '', resolucion: 'HOSPITAL', resolucion_fecha: '', espera: '', servicio: 'UNIDAD DE CUIDADOS INTENSIVOS', servicio_real: 'UNIDAD DE CUIDADOS INTENSIVOS', servicio_abrev: 'UCI', servicio_verificado: true },
  ];
  return { area, titulo: `CENSO DE PACIENTES (DEMO ${area === 'hospital' ? 'HOSPITALIZACIÓN' : 'URGENCIAS'})`, fecha: 'DEMO', columnas, pacientes, servicios: ['CIRUGÍA GENERAL', 'MEDICINA INTERNA', 'TRAUMATOLOGÍA Y ORTOPEDIA', 'UNIDAD DE CUIDADOS INTENSIVOS'], resumen: { 'Total de Pacientes': String(pacientes.length) }, totalDeclarado: pacientes.length, validacion: { parseados: pacientes.length, declarados: pacientes.length, ok: true } };
}

// ---------- helpers HTTP ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.replace(/^\//, ''));
  if (rel === '' || rel === '/') rel = 'index.html';
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      chunks.push(c);
      len += c.length;
      if (len > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/estado' && req.method === 'GET') {
    return sendJson(res, 200, { demo: DEMO, loggedIn: client.loggedIn, area: client.areaActual });
  }

  if (p === '/api/login' && req.method === 'POST') {
    try {
      let creds = null;
      try { creds = JSON.parse(await readBody(req)); } catch (_) { creds = null; }
      const usuario = (creds && creds.usuario) || (defaultCreds && defaultCreds.usuario);
      const pass = (creds && creds.pass) || (defaultCreds && defaultCreds.pass);
      if (!usuario || !pass) return sendJson(res, 400, { error: 'Faltan credenciales' });
      const r = await serial(() => client.login(usuario, pass));
      return sendJson(res, 200, { ok: true, area: r.area, usuario });
    } catch (e) {
      return sendJson(res, e.status && e.status >= 400 && e.status < 500 ? e.status : 502, { error: e.message });
    }
  }

  const m = p.match(/^\/api\/censo\/(hospital|urgencias)$/);
  if (m && req.method === 'GET') {
    const area = m[1];
    let result;
    if (DEMO) {
      result = demoCenso(area);
    } else {
      try {
        result = await serial(() => censo.buildCenso(client, area));
      } catch (e) {
        return sendJson(res, e.status && e.status >= 400 && e.status < 500 ? e.status : 502, { error: e.message });
      }
    }
    // Conservación: registrar el rastro de pacientes en expedientes.
    try { expedientes.registrarCenso(area, result.pacientes || []); } catch (e) { console.error('rastro:', e.message); }
    return sendJson(res, 200, result);
  }

  // Resuelve CIE-9-MC desde lenguaje natural (DeepSeek).
  if (p === '/api/cie9' && req.method === 'POST') {
    try {
      let datos = null;
      try { datos = JSON.parse(await readBody(req)); } catch (_) { datos = null; }
      const texto = datos && datos.texto;
      if (!texto) return sendJson(res, 400, { error: 'Falta el texto del procedimiento' });
      const cie9 = await resolverCie9(texto);
      return sendJson(res, 200, { cie9 });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // Cirugías solicitadas (QX PENDIENTE).
  if (p === '/api/cirugias' && req.method === 'GET') {
    return sendJson(res, 200, cirugias.listarPendientes());
  }
  if (p === '/api/cirugias' && req.method === 'POST') {
    try {
      const datos = JSON.parse(await readBody(req));
      if (!datos || !datos.nss) return sendJson(res, 400, { error: 'Falta el NSS' });
      const r = cirugias.crear(datos);
      return sendJson(res, 200, { ok: true, registro: r });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Marcar cirugía como realizada.
  const rm = p.match(/^\/api\/cirugias\/([^/]+)\/realizado$/);
  if (rm && req.method === 'POST') {
    try {
      const nss = decodeURIComponent(rm[1]);
      let datos = {};
      try { datos = JSON.parse(await readBody(req)); } catch (_) { datos = {}; }
      const r = cirugias.marcarRealizada(nss, datos);
      if (!r) return sendJson(res, 404, { error: 'Registro no encontrado' });
      // Vincular la cirugía realizada al internamiento del expediente.
      try { expedientes.registrarCirugiaRealizada(nss, r); } catch (e) { console.error('vinculo cirugia:', e.message); }
      return sendJson(res, 200, { ok: true, registro: r });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Cancelar una cirugía (se conserva como historial).
  const ca = p.match(/^\/api\/cirugias\/([^/]+)\/cancelar$/);
  if (ca && req.method === 'POST') {
    try {
      const nss = decodeURIComponent(ca[1]);
      const r = cirugias.cancelar(nss);
      if (!r) return sendJson(res, 404, { error: 'Registro no encontrado' });
      return sendJson(res, 200, { ok: true, registro: r });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Editar los detalles de una cirugía solicitada.
  const ed = p.match(/^\/api\/cirugias\/([^/]+)$/);
  if (ed && req.method === 'POST') {
    try {
      const nss = decodeURIComponent(ed[1]);
      const datos = JSON.parse(await readBody(req));
      const r = cirugias.editar(nss, datos);
      if (!r) return sendJson(res, 404, { error: 'Registro no encontrado' });
      return sendJson(res, 200, { ok: true, registro: r });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada' });
}

// ---------- servidor ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => sendJson(res, 500, { error: e.message }));
  } else if (req.method === 'GET') {
    serveStatic(res, url.pathname);
  } else {
    res.writeHead(405); res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PHEDS Censo — servidor local en http://${HOST}:${PORT}${DEMO ? ' (MODO DEMO)' : ''}`);
  if (HOST === '127.0.0.1') console.log('  (solo accesible en esta maquina; para LAN usa HOST=0.0.0.0)');
});
