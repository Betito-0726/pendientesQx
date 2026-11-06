'use strict';
// Netlify Function: resuelve CIE-9-MC desde lenguaje natural vía DeepSeek.
// La clave se lee de la variable de entorno DEEPSEEK_API_KEY (configurada en Netlify).
const https = require('https');

function resolverCie9(key, texto) {
  return new Promise((resolve, reject) => {
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
        if (res.statusCode !== 200) return reject(new Error(`DeepSeek HTTP ${res.statusCode}`));
        try {
          const j = JSON.parse(d);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error('Respuesta vacía de DeepSeek'));
          resolve(content.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout DeepSeek')));
    req.write(body);
    req.end();
  });
}

function ok(obj) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function err(code, msg) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return err(405, 'Method not allowed');
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return err(500, 'Falta la variable de entorno DEEPSEEK_API_KEY');
  let texto = null;
  try { texto = JSON.parse(event.body || '{}').texto; } catch (_) { texto = null; }
  if (!texto) return err(400, 'Falta el texto del procedimiento');
  try {
    const cie9 = await resolverCie9(key, texto);
    return ok({ cie9 });
  } catch (e) {
    return err(502, e.message);
  }
};
