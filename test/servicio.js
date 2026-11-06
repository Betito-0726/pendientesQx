'use strict';
// servicio.js — Verifica la extraccion del servicio REAL por paciente (hospital).
// Requiere intranet + config.local.json. NO imprime nombres/NSS/CURP de pacientes.
const fs = require('fs');
const path = require('path');
const { PhedsClient } = require('../server/pheds');
const parser = require('../server/parser');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.local.json'), 'utf8')).pheds;

(async () => {
  const client = new PhedsClient({ baseUrl: cfg.baseUrl, unidad: cfg.unidad, pausaMs: 1000, pausaDetalleMs: 700 });
  await client.login(cfg.usuario, cfg.pass);
  console.log('Login OK');

  const html = await client.downloadCenso('hospital');
  const parsed = parser.parseCenso(html);
  console.log('Censo hospital parseado:', parsed.validacion.parseados, 'pacientes');

  // Mapa a objetos (nss, area, cama, ...)
  const pacientes = parsed.filas.map((vals, idx) => {
    const p = { _id: idx };
    vals.forEach((v, i) => { const k = parser.mapHeader(parsed.columnas[i]); if (k) p[k] = v; });
    if (p.nss && p.nss.includes('\n')) { const [nss, curp] = p.nss.split('\n').map((s) => s.trim()); p.nss = nss; p.curp = curp || ''; }
    return p;
  });

  // Mapa NSS -> folio
  const centrales = await client.getCentrales();
  console.log('Centrales:', centrales.map((c) => `${c.nombre}(${c.central})`).join(', '));
  const folioMap = new Map();
  for (const c of centrales) {
    const folios = await client.getCamaFolios(c.central);
    for (const f of folios) if (f.nss) folioMap.set(f.nss, f);
  }
  console.log('Camas con folio:', folioMap.size);

  // Servicio real por paciente
  const dist = {};
  let sinFolio = 0;
  let sinServicio = 0;
  const recuperacion = {};
  const uci = {};
  let cama1Servicio = null;
  for (const p of pacientes) {
    const f = folioMap.get(p.nss);
    if (!f) { sinFolio++; continue; }
    let s;
    try { s = await client.getPacienteServicio(f.folio, f.anio, f.central); }
    catch (e) { s = ''; }
    if (!s) { sinServicio++; continue; }
    dist[s] = (dist[s] || 0) + 1;
    if (/recuperaci/i.test(p.area || '')) recuperacion[s] = (recuperacion[s] || 0) + 1;
    if (/cuidados intensivos/i.test(p.area || '')) uci[s] = (uci[s] || 0) + 1;
    if (p.nss === '8288680674') cama1Servicio = s; // el ejemplo del usuario (cama 1)
  }

  console.log('\nDistribucion por servicio real:');
  for (const [s, n] of Object.entries(dist).sort()) console.log(`  ${s}: ${n}`);
  console.log('\nRecuperacion (servicios quirurgicos):', JSON.stringify(recuperacion));
  console.log('UCI:', JSON.stringify(uci));
  console.log('Sin folio:', sinFolio, '| Sin servicio:', sinServicio);
  console.log('Cama 1 (NSS 8288680674) servicio =', JSON.stringify(cama1Servicio), '(esperado: MEDICINA INTERNA)');
  console.log('\nSERVICIO OK');
})().catch((e) => { console.error('SERVICIO FAIL:', e.message); process.exit(1); });
