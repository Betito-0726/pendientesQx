'use strict';
// smoke.js — Verificacion de punta a punta (login + descarga + parseo + validacion de totales).
// Requiere estar en la intranet de IMSS y tener config.local.json con credenciales.
// NO imprime nombres, NSS ni CURP de pacientes (solo conteos, columnas y servicios).

const fs = require('fs');
const path = require('path');
const { PhedsClient } = require('../server/pheds');
const parser = require('../server/parser');

const cfgPath = path.join(__dirname, '..', 'config.local.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Falta config.local.json con las credenciales.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pheds;

(async () => {
  const client = new PhedsClient({ baseUrl: cfg.baseUrl, unidad: cfg.unidad, pausaMs: 1200 });

  const r = await client.login(cfg.usuario, cfg.pass);
  console.log('Login OK. Area inicial:', r.area);

  for (const area of ['hospital', 'urgencias']) {
    console.log(`\n=== CENSO ${area.toUpperCase()} ===`);
    const html = await client.downloadCenso(area);
    const p = parser.parseCenso(html);
    const { parseados, declarados, ok } = p.validacion;
    console.log('Titulo        :', p.titulo);
    console.log('Columnas (%d)  :', p.columnas.length, p.columnas.join(' | '));
    console.log('Parseados     :', parseados);
    console.log('Declarados    :', declarados);
    console.log('VALIDACION    :', ok === true ? 'OK (coinciden)' : ok === false ? `DESCUADRE (${parseados} vs ${declarados})` : 'sin total declarado');
    // Servicios (dato destacado): se extraen sin exponer datos de pacientes.
    const svc = {};
    for (const fila of p.filas) {
      const i = p.columnas.findIndex((c) => parser.mapHeader(c) === 'area');
      const v = i >= 0 ? fila[i] : '';
      if (v) svc[v] = (svc[v] || 0) + 1;
    }
    console.log('Servicios     :', JSON.stringify(svc));
  }

  console.log('\nArea final:', client.areaActual, '(restaurada)');
  console.log('\nSMOKE OK');
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
