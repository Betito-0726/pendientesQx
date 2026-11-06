'use strict';
// expedientes.js — Expedientes (por NSS) con internamientos y su rastro por fases.
// La fuente primaria son los censos; este módulo conserva el rastro del paciente
// (urgencias -> hospital -> quirófano -> recuperación/UCI -> alta) entre cada descarga.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EXPEDIENTES_FILE = path.join(DATA_DIR, 'expedientes.json');
const CENSO_ACTIVO_FILE = path.join(DATA_DIR, 'censo_activo.json');

function cargarExpedientes() {
  try {
    const a = JSON.parse(fs.readFileSync(EXPEDIENTES_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}

function guardarExpedientes(expedientes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(EXPEDIENTES_FILE, JSON.stringify(expedientes, null, 2));
}

function cargarCensoActivo() {
  try {
    return JSON.parse(fs.readFileSync(CENSO_ACTIVO_FILE, 'utf8'));
  } catch (_) {
    return { fecha: null, porNss: {} };
  }
}

function guardarCensoActivo(activo) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CENSO_ACTIVO_FILE, JSON.stringify(activo, null, 2));
}

// Determina la fase del internamiento según el área física y la fuente.
function faseDe(area, fuente) {
  if (fuente === 'urgencias') return 'urgencias';
  if (/recuperaci/i.test(area || '')) return 'recuperacion';
  if (/cuidados intensivos/i.test(area || '')) return 'uci';
  return 'hospital';
}

const FASES = ['urgencias', 'hospital', 'recuperacion', 'uci'];

function nuevoInternamiento(nss, ahora) {
  return {
    id: `${nss}:${ahora}`,
    abierto: true,
    fecha_inicio: ahora,
    fecha_cierre: null,
    urgencias: { entrada: null, salida: null, diagnostico: null, especialidad_ingreso: null },
    hospital: { entrada: null, salida: null, servicio: null, cama: null, medico: null, medico_matricula: null, diagnostico: null },
    recuperacion: { entrada: null, salida: null },
    uci: { entrada: null, salida: null },
    cirugias: [],
    alta: { fecha: null, tipo: null, resolucion: null },
  };
}

function registrarFase(int, fase, p, ahora) {
  const f = int[fase];
  if (!f) return;
  if (f.entrada == null) f.entrada = ahora;
  if (fase === 'urgencias') {
    if (p.diagnostico) f.diagnostico = p.diagnostico;
    if (p.especialidad_ingreso) f.especialidad_ingreso = p.especialidad_ingreso;
  } else if (fase === 'hospital') {
    f.servicio = p.servicio || f.servicio;
    f.cama = p.cama || f.cama;
    f.medico = p.medico || f.medico;
    f.medico_matricula = p.medico_matricula || f.medico_matricula;
    f.diagnostico = p.diagnostico || f.diagnostico;
  }
}

function cerrarFase(int, fase, ahora) {
  const f = int[fase];
  if (f && f.salida == null) f.salida = ahora;
}

function tipoAltaDeResolucion(resolucion) {
  if (!resolucion) return 'desconocido';
  if (/defunci|fallec/i.test(resolucion)) return 'defuncion';
  if (/traslad/i.test(resolucion)) return 'traslado';
  if (/domicilio|alta/i.test(resolucion)) return 'domicilio';
  return 'desconocido';
}

// Registra el rastro a partir de una descarga de censo.
// fuente: 'hospital' | 'urgencias'.
// pacientes: array de objetos ya enriquecidos (nss, area, servicio, cama, medico, ...).
function registrarCenso(fuente, pacientes) {
  const activo = cargarCensoActivo();
  const expedientes = cargarExpedientes();
  const porNss = new Map(expedientes.map((e) => [e.nss, e]));
  const ahora = new Date().toISOString();

  const nuevos = new Map();
  for (const p of pacientes) {
    if (!p.nss) continue;
    const fase = faseDe(p.area, fuente);
    nuevos.set(p.nss, Object.assign({}, p, { fase, fuente }));
  }

  // 1. Pacientes presentes en la nueva foto.
  for (const [nss, p] of nuevos) {
    let exp = porNss.get(nss);
    if (!exp) {
      exp = { nss, agregado: p.agregado || null, nombre: p.nombre || null, internamientos: [] };
      porNss.set(nss, exp);
      expedientes.push(exp);
    }
    if (p.agregado) exp.agregado = p.agregado;
    if (p.nombre) exp.nombre = p.nombre;

    let int = exp.internamientos.find((i) => i.abierto);
    if (!int) {
      int = nuevoInternamiento(nss, ahora);
      exp.internamientos.push(int);
    }
    const prev = activo.porNss[nss];
    if (prev && prev.fase && prev.fase !== p.fase) cerrarFase(int, prev.fase, ahora);
    registrarFase(int, p.fase, p, ahora);
  }

  // 2. Desaparecidos de la fuente descargada → cerrar fase e internamiento.
  for (const [nss, prev] of Object.entries(activo.porNss)) {
    if (prev.fuente !== fuente || nuevos.has(nss)) continue;
    const exp = porNss.get(nss);
    if (!exp) continue;
    const int = exp.internamientos.find((i) => i.abierto);
    if (!int) continue;
    cerrarFase(int, prev.fase, ahora);
    const sigueEnOtraFase = FASES.some((f) => int[f] && int[f].entrada != null && int[f].salida == null);
    if (!sigueEnOtraFase) {
      int.abierto = false;
      int.fecha_cierre = ahora;
      int.alta.fecha = ahora;
      int.alta.tipo = tipoAltaDeResolucion(prev.resolucion);
      int.alta.resolucion = prev.resolucion || null;
    }
  }

  // 3. Actualizar censo_activo (foto combinada).
  const nuevaFoto = { fecha: ahora, porNss: Object.assign({}, activo.porNss) };
  for (const [nss, p] of nuevos) nuevaFoto.porNss[nss] = p;
  guardarCensoActivo(nuevaFoto);

  guardarExpedientes(expedientes);
  return expedientes;
}

// Registra una cirugía realizada dentro del internamiento abierto del paciente.
function registrarCirugiaRealizada(nss, cirugia) {
  const expedientes = cargarExpedientes();
  const exp = expedientes.find((e) => e.nss === nss);
  if (!exp) return;
  const int = exp.internamientos.find((i) => i.abierto);
  if (!int) return;
  int.cirugias.push({
    fecha: cirugia.fecha_realizacion || new Date().toISOString(),
    cie9: cirugia.cie9 || null,
    cirugia: cirugia.cirugia_realizada || cirugia.cirugia_natural || null,
    cirujano: cirugia.cirujano || null,
    tiempo_quirurgico: cirugia.tiempo_quirurgico || null,
    hallazgos: cirugia.hallazgos || null,
  });
  guardarExpedientes(expedientes);
}

module.exports = { registrarCenso, registrarCirugiaRealizada, cargarExpedientes };
