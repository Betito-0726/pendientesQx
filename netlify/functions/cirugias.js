'use strict';
// Netlify Function: API de cirugías (solo lectura/escritura vía Netlify Blobs).
// Reemplaza el data/cirugias.json del servidor local cuando la app corre en Netlify.
const { getStore } = require('@netlify/blobs');

const store = getStore('cirugias');
const KEY = 'registros';

async function cargar() {
  try {
    const raw = await store.get(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

async function guardar(arr) {
  await store.set(KEY, JSON.stringify(arr));
}

function listarPendientes(arr) {
  return arr.filter((r) => r.estado === 'solicitada');
}

// Extrae los segmentos tras "cirugias" del path (tolerante al prefijo de la función).
function segmentos(path) {
  const segs = (path || '').split('/').filter(Boolean);
  const idx = segs.lastIndexOf('cirugias');
  if (idx < 0) return null;
  return segs.slice(idx + 1);
}

function ok(obj) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ ok: true }, obj)) };
}
function err(code, msg) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const segs = segmentos(event.path);
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }

  try {
    const registros = await cargar();

    // GET /api/cirugias → pendientes (array directo, igual que el servidor local)
    if (method === 'GET' && segs && segs.length === 0) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(listarPendientes(registros)) };
    }

    // POST /api/cirugias → crear
    if (method === 'POST' && segs && segs.length === 0) {
      if (!body.nss) return err(400, 'Falta el NSS');
      const resto = registros.filter((r) => !(r.nss === body.nss && r.estado === 'solicitada'));
      const maxId = registros.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
      const nuevo = Object.assign({}, body, {
        id: String(maxId + 1),
        fecha_solicitud: new Date().toISOString(),
        estado: 'solicitada',
      });
      resto.push(nuevo);
      await guardar(resto);
      return ok({ registro: nuevo });
    }

    // POST /api/cirugias/:nss/realizado
    if (method === 'POST' && segs && segs.length === 2 && segs[1] === 'realizado') {
      const nss = decodeURIComponent(segs[0]);
      const r = registros.find((x) => x.nss === nss && x.estado === 'solicitada');
      if (!r) return err(404, 'Registro no encontrado');
      Object.assign(r, {
        estado: 'realizada',
        fecha_realizacion: new Date().toISOString(),
        cirugia_realizada: body.cirugia_realizada || '',
        hallazgos: body.hallazgos || '',
        tiempo_quirurgico: body.tiempo_quirurgico || '',
        cirujano: body.cirujano || '',
      });
      await guardar(registros);
      return ok({ registro: r });
    }

    // POST /api/cirugias/:nss/cancelar
    if (method === 'POST' && segs && segs.length === 2 && segs[1] === 'cancelar') {
      const nss = decodeURIComponent(segs[0]);
      const r = registros.find((x) => x.nss === nss && x.estado === 'solicitada');
      if (!r) return err(404, 'Registro no encontrado');
      r.estado = 'cancelada';
      r.fecha_cancelacion = new Date().toISOString();
      await guardar(registros);
      return ok({ registro: r });
    }

    // POST /api/cirugias/:nss → editar
    if (method === 'POST' && segs && segs.length === 1) {
      const nss = decodeURIComponent(segs[0]);
      const r = registros.find((x) => x.nss === nss && x.estado === 'solicitada');
      if (!r) return err(404, 'Registro no encontrado');
      if (body.cirugia_natural !== undefined) r.cirugia_natural = body.cirugia_natural;
      if (body.cie9 !== undefined) r.cie9 = body.cie9;
      if (body.observaciones !== undefined) r.observaciones = body.observaciones;
      await guardar(registros);
      return ok({ registro: r });
    }

    return err(404, 'Ruta no encontrada');
  } catch (e) {
    return err(500, e.message);
  }
};
