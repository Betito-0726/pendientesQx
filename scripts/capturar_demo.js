'use strict';
// capturar_demo.js — Descarga ambos censos reales y los guarda ANONIMIZADOS en demo/.
// Sirve para trabajar el CSS sin intranet: el modo --demo carga estos fixtures.
// Los datos personales (nombre, NSS, agregado, medico, matricula) se reemplazan por
// valores ficticios; se conservan servicio, cama, edad, diagnostico y fechas.
//
// Uso (requiere intranet + config.local.json):
//   node scripts/capturar_demo.js

const fs = require('fs');
const path = require('path');
const { PhedsClient } = require('../server/pheds');
const censo = require('../server/censo');

const cfgPath = path.join(__dirname, '..', 'config.local.json');
if (!fs.existsSync(cfgPath)) { console.error('Falta config.local.json'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pheds;
const DEMO_DIR = path.join(__dirname, '..', 'demo');

// Nombres ficticios de longitud variada (para probar el ajuste del CSS).
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

(async () => {
  const client = new PhedsClient({ baseUrl: cfg.baseUrl, unidad: cfg.unidad, pausaMs: 1000, pausaDetalleMs: 700 });
  await client.login(cfg.usuario, cfg.pass);
  console.log('Login OK');

  fs.mkdirSync(DEMO_DIR, { recursive: true });

  for (const area of ['hospital', 'urgencias']) {
    console.log(`Descargando ${area}...`);
    const r = await censo.buildCenso(client, area);
    const out = anonymize(r, area);
    const file = path.join(DEMO_DIR, area + '.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`  -> ${area}.json (${out.pacientes.length} pacientes anonimizados)`);
  }

  console.log('\nListo. Ahora puedes trabajar sin intranet con: node server/server.js --demo');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
