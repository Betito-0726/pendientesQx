'use strict';
// cirugias.js — Registro de cirugías (independiente, referencia a expedientes por NSS).
// Estados: "solicitada" (QX PENDIENTE), "realizada", "cancelada".
// Las realizadas y canceladas se conservan como historial (no se borran).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'cirugias.json');

function cargar() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function guardar(registros) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(registros, null, 2));
}

// Solo las solicitadas (pendientes de quirófano).
function listarPendientes() {
  return cargar().filter((r) => r.estado === 'solicitada');
}

function crear(datos) {
  const registros = cargar();
  // Reemplaza cualquier solicitud pendiente previa del mismo NSS.
  const resto = registros.filter((r) => !(r.nss === datos.nss && r.estado === 'solicitada'));
  const maxId = registros.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  const nuevo = Object.assign({}, datos, {
    id: String(maxId + 1),
    fecha_solicitud: new Date().toISOString(),
    estado: 'solicitada',
  });
  resto.push(nuevo);
  guardar(resto);
  return nuevo;
}

function marcarRealizada(nss, datos) {
  const registros = cargar();
  const r = registros.find((x) => x.nss === nss && x.estado === 'solicitada');
  if (!r) return null;
  Object.assign(r, {
    estado: 'realizada',
    fecha_realizacion: new Date().toISOString(),
    cirugia_realizada: datos.cirugia_realizada || '',
    hallazgos: datos.hallazgos || '',
    tiempo_quirurgico: datos.tiempo_quirurgico || '',
    cirujano: datos.cirujano || '',
  });
  guardar(registros);
  return r;
}

function editar(nss, datos) {
  const registros = cargar();
  const r = registros.find((x) => x.nss === nss && x.estado === 'solicitada');
  if (!r) return null;
  if (datos.cirugia_natural !== undefined) r.cirugia_natural = datos.cirugia_natural;
  if (datos.cie9 !== undefined) r.cie9 = datos.cie9;
  if (datos.observaciones !== undefined) r.observaciones = datos.observaciones;
  guardar(registros);
  return r;
}

// Cancela una cirugía (se conserva como historial con estado "cancelada").
function cancelar(nss) {
  const registros = cargar();
  const r = registros.find((x) => x.nss === nss && x.estado === 'solicitada');
  if (!r) return null;
  r.estado = 'cancelada';
  r.fecha_cancelacion = new Date().toISOString();
  guardar(registros);
  return r;
}

module.exports = { listarPendientes, crear, marcarRealizada, editar, cancelar };
