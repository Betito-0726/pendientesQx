'use strict';
// build_static.js — Ensambla la carpeta estática (dist/) para Netlify.
// Copia la SPA + los censos demo (anonimizados). Las cirugías se gestionan
// en Netlify Blobs (via Netlify Functions), no como archivo estático.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function copiar(origen, destino) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(origen, destino);
}

// Limpiar y crear dist/
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// SPA
copiar(path.join(ROOT, 'web', 'index.html'), path.join(DIST, 'index.html'));
copiar(path.join(ROOT, 'web', 'styles.css'), path.join(DIST, 'styles.css'));
copiar(path.join(ROOT, 'web', 'app.js'), path.join(DIST, 'app.js'));

// Censos demo (anonimizados)
copiar(path.join(ROOT, 'demo', 'hospital.json'), path.join(DIST, 'data', 'hospital.json'));
copiar(path.join(ROOT, 'demo', 'urgencias.json'), path.join(DIST, 'data', 'urgencias.json'));

console.log('Carpeta estática lista en dist/ (los censos). Las cirugías van por Netlify Functions.');
console.log('Archivos:', fs.readdirSync(DIST).join(', '));
