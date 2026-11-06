'use strict';
// deepseek.js — Resuelve un procedimiento quirurgico en lenguaje natural a CIE-9-MC
// usando la API de DeepSeek. La key se lee del archivo "API Deepseek.txt" (gitignored).
const https = require('https');
const fs = require('fs');
const path = require('path');

function leerKey() {
  const p = path.join(__dirname, '..', 'API Deepseek.txt');
  try {
    const lineas = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lineas[lineas.length - 1]; // la ultima linea no vacia (la key)
  } catch (_) {
    return null;
  }
}

// Devuelve "CODIGO - descripcion" del procedimiento CIE-9-MC mas compatible.
function resolverCie9(texto) {
  return new Promise((resolve, reject) => {
    const key = leerKey();
    if (!key) return reject(new Error('No se encontro la API key de DeepSeek (API Deepseek.txt)'));

    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'Eres un asistente de codificacion medica. Devuelve SOLO el procedimiento CIE-9-MC mas compatible, en el formato exacto "CODIGO - descripcion corta". Sin texto adicional, sin viñetas ni explicaciones.',
        },
        { role: 'user', content: texto },
      ],
      max_tokens: 80,
      temperature: 0,
    });

    const req = https.request({
      host: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(d);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error('Respuesta vacia de DeepSeek'));
          resolve(content.trim());
        } catch (e) {
          reject(new Error('Respuesta no parseable de DeepSeek'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout DeepSeek')));
    req.write(body);
    req.end();
  });
}

module.exports = { resolverCie9 };
