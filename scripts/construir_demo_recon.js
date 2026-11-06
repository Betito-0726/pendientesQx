'use strict';
// construir_demo_recon.js — Construye los fixtures de demo/ a partir del HTML
// ya capturado en recon/ (NO requiere intranet).
// El servicio se deriva de la columna "Esp" (especialidad), que coincide con el
// servicio real. Los datos personales se anonimizan.
//
// Uso:  node scripts/construir_demo_recon.js

const fs = require('fs');
const path = require('path');
const parser = require('../server/parser');
const censo = require('../server/censo');

const RECON = path.join(__dirname, '..', 'recon');
const DEMO_DIR = path.join(__dirname, '..', 'demo');

// Especialidad (columna "Esp") -> servicio real.
const ESP_SERVICIO = {
  MED: 'MEDICINA INTERNA',
  CIR: 'CIRUGÍA GENERAL',
  TRA: 'TRAUMATOLOGÍA Y ORTOPEDIA',
  GER: 'GERIATRÍA',
  CAR: 'CARDIOLOGÍA',
  URO: 'UROLOGÍA',
  UNI: 'UNIDAD DE CUIDADOS INTENSIVOS',
};

const NOMBRES = [
  'GARCIA LOPEZ ANA MARIA',
  'HERNANDEZ CRUZ JOSE LUIS',
  'MARTINEZ ROJAS PEDRO ANTONIO',
  'LOPEZ DIAZ MARIA DEL CARMEN',
  'RAMIREZ VEGA CARLOS',
  'SANCHEZ ORTIZ ROSA ISELA',
  'GONZALEZ PEREZ JUAN PABLO',
  'RODRIGUEZ FLORES GUADALUPE',
  'PEREZ MARTINEZ FRANCISCO JAVIER',
  'TORRES MENDOZA LAURA',
  'FLORES CASTILLO MIGUEL ANGEL',
  'VARGAS JIMENEZ ELENA',
];

function anonymize(result, area) {
  const prefijo = area === 'hospital' ? '1' : '2';
  const pacientes = result.pacientes.map((p, i) => {
    const c = Object.assign({}, p);
    c.nombre = NOMBRES[i % NOMBRES.length];
    c.nss = prefijo + String(i + 1).padStart(9, '0');  // NSS sin solape entre hospital y urgencias
    if ('agregado' in c) c.agregado = prefijo + 'M0000OR';
    if ('medico' in c) c.medico = 'MEDICO TRATANTE ' + String((i % 20) + 1).padStart(2, '0');
    if ('medico_matricula' in c) c.medico_matricula = String(90000000 + i);
    return c;
  });
  return Object.assign({}, result, {
    pacientes,
    demo: true,
    capturado: new Date().toISOString(),
    titulo: result.titulo + ' (DEMO)',
  });
}

function construir(area, archivo) {
  const html = fs.readFileSync(path.join(RECON, archivo), 'utf8');
  const parsed = parser.parseCenso(html);
  const result = censo.enrich(area, parsed);
  // Servicio desde Esp (especialidad); si no hay, se queda con el area.
  for (const p of result.pacientes) {
    const esp = (p.esp || '').trim().toUpperCase();
    const svc = ESP_SERVICIO[esp] || p.area || p.servicio || '';
    p.servicio = svc;
    p.servicio_real = svc;
    p.servicio_verificado = true;
  }
  result.servicios = [...new Set(result.pacientes.map((p) => p.servicio).filter(Boolean))].sort();
  return anonymize(result, area);
}

(() => {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  const hospital = construir('hospital', '10_censo_hosp.html');
  const urgencias = construir('urgencias', '11_censo_urg.html');
  fs.writeFileSync(path.join(DEMO_DIR, 'hospital.json'), JSON.stringify(hospital, null, 2));
  fs.writeFileSync(path.join(DEMO_DIR, 'urgencias.json'), JSON.stringify(urgencias, null, 2));
  console.log(`hospital.json: ${hospital.pacientes.length} pacientes anonimizados`);
  console.log(`urgencias.json: ${urgencias.pacientes.length} pacientes anonimizados`);
  console.log('Servicios:', hospital.servicios.join(', '));
  console.log('\nListo. Trabaja sin intranet con: node server/server.js --demo');
})();
