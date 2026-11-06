'use strict';
// pheds.js — Cliente HTTP de PHEDS (login, area, descarga de censos).
// Mantiene la sesion (cookies) en memoria. NO registra credenciales ni datos de pacientes.
// Pensado para reutilizarse en la futura app Capacitor (misma logica, solo cambia el transporte HTTP).

const https = require('https');
const zlib = require('zlib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marcadores que validan el login en principal.asp (no confiar en HTTP 200).
const LOGIN_MARKERS = ['SIMBOLOGIA CAMAS', 'LogOut.asp', 'iFrameprincipal'];

// Lista blanca de POST permitidos (solo login y preparacion de reportes; NADA de escritura).
const POST_WHITELIST = ['loginBD.asp', 'rpt_menu.asp'];

class PhedsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PhedsError';
    this.status = status;
  }
}

class PhedsClient {
  constructor({ baseUrl, unidad, pausaMs = 1200, pausaDetalleMs = 700 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.unidad = unidad;
    this.pausaMs = pausaMs;
    this.pausaDetalleMs = pausaDetalleMs;
    this.jar = new Map(); // nombre -> { value }
    this.areaActual = null; // 'hospital' | 'urgencias' | null
    this.loggedIn = false;
    this.serviceCache = new Map(); // folio -> servicio (estable durante el episodio)
  }

  // ---------- utilidades HTTP ----------
  _setCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const sc of list) {
      const first = sc.split(';')[0];
      const eq = first.indexOf('=');
      if (eq < 0) continue;
      this.jar.set(first.slice(0, eq).trim(), { value: first.slice(eq + 1).trim() });
    }
  }

  _cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v.value}`).join('; ');
  }

  _request(method, pathname, { form, referer } = {}) {
    return new Promise((resolve, reject) => {
      if (method === 'POST') {
        const base = pathname.split('?')[0];
        if (!POST_WHITELIST.some((w) => base.endsWith(w))) {
          return reject(new PhedsError(`POST fuera de lista blanca: ${pathname}`));
        }
      }
      const url = new URL(this.baseUrl + '/' + pathname.replace(/^\//, ''));
      const body = form ? new URLSearchParams(form).toString() : null;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PhedsClient/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      };
      const ck = this._cookieHeader();
      if (ck) headers['Cookie'] = ck;
      if (referer) headers['Referer'] = this.baseUrl + '/' + referer.replace(/^\//, '');
      if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';

      const req = https.request({
        host: url.host,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: false, // cadena de confianza de PHEDS da problemas; ver README.
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          this._setCookies(res.headers['set-cookie']);
          let buf = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          resolve({ status: res.statusCode, headers: res.headers, body: buf, location: res.headers.location });
        });
      });
      req.on('error', reject);
      req.setTimeout(45000, () => req.destroy(new PhedsError('timeout')));
      if (body) req.write(body);
      req.end();
    });
  }

  _assertOk(r, ctx) {
    if (r.status === 403 || r.status === 429) {
      throw new PhedsError(`${ctx}: bloqueado por el servidor (HTTP ${r.status}). Detente y avisa.`, r.status);
    }
    if (r.status >= 500) {
      throw new PhedsError(`${ctx}: error del servidor (HTTP ${r.status}). Detente y avisa.`, r.status);
    }
  }

  _esRedireccionALogin(r) {
    if (r.status === 302 && r.location && /login/i.test(r.location)) return true;
    // El formulario de login tiene "loginBD.asp" como action.
    const txt = r.body.toString('utf8');
    return /loginBD\.asp/i.test(txt) && /usuario/i.test(txt) && /pass/i.test(txt);
  }

  // ---------- Login (3 pasos) ----------
  async login(usuario, pass) {
    // 1. GET login.html (captura cookie BIGipServerpool)
    let r = await this._request('GET', '/login.html');
    this._assertOk(r, 'login.html');
    await sleep(this.pausaMs);

    // 2. POST loginBD.asp
    r = await this._request('POST', '/loginBD.asp', {
      form: { usuario, pass, Submit: 'Entrar' },
      referer: 'login.html',
    });
    this._assertOk(r, 'loginBD.asp');
    await sleep(this.pausaMs);

    // 3. GET derechos.asp
    r = await this._request('GET', '/derechos.asp');
    this._assertOk(r, 'derechos.asp');
    await sleep(this.pausaMs);

    // 4. GET principal.asp -> valida por marcadores (HTTP 200 miente)
    r = await this._request('GET', '/principal.asp');
    this._assertOk(r, 'principal.asp');
    const txt = r.body.toString('utf8').replace(/\s+/g, ' ');
    const missing = LOGIN_MARKERS.filter((m) => !txt.includes(m));
    if (missing.length > 0) {
      throw new PhedsError(`Login no validado: faltan marcadores ${missing.join(', ')}`);
    }
    this.loggedIn = true;
    this.areaActual = this._areaDesdeTexto(txt);
    return { area: this.areaActual };
  }

  _areaDesdeTexto(txt) {
    const t = txt.replace(/\s+/g, ' ');
    if (t.includes('AREA DE URGENCIAS')) return 'urgencias';
    if (t.includes('AREA DE HOSPITALIZACION')) return 'hospital';
    return null;
  }

  async getArea() {
    const r = await this._request('GET', '/principal.asp');
    this._assertOk(r, 'principal.asp');
    const area = this._areaDesdeTexto(r.body.toString('utf8'));
    if (area) this.areaActual = area;
    return area;
  }

  // Conmuta el area (GET CambioUsuario.asp). Devuelve la nueva area.
  async _toggleArea() {
    await this._request('GET', '/CambioUsuario.asp');
    await sleep(this.pausaMs);
    return this.getArea();
  }

  // Garantiza que la sesion este en el area indicada. Devuelve si se conmuto.
  async ensureArea(area) {
    if (this.areaActual === area) return false;
    let areaLeida = this.areaActual;
    // Releer por si acaso (la sesion puede haber cambiado en el servidor).
    if (areaLeida === null) areaLeida = await this.getArea();
    if (areaLeida === area) return false;
    areaLeida = await this._toggleArea();
    if (areaLeida !== area) {
      throw new PhedsError(`No se pudo conmutar al area ${area} (actual: ${areaLeida})`);
    }
    return true;
  }

  // ---------- Descarga de un censo ----------
  // area: 'hospital' | 'urgencias'
  async downloadCenso(area) {
    if (!this.loggedIn) throw new PhedsError('No hay sesion iniciada');
    const reporte = area === 'hospital' ? '33' : '7';

    const areaOriginal = this.areaActual;
    await this.ensureArea(area);

    try {
      // Paso 1: preparar el reporte.
      let r = await this._request('POST', '/rpt_menu.asp', {
        form: { lst_reporte: reporte, lst_hosp: this.unidad, lst_area: '0', division: '0', tFormato: 'P' },
        referer: 'principal.asp',
      });
      this._assertOk(r, 'rpt_menu.asp');
      if (this._esRedireccionALogin(r)) throw new PhedsError('Sesion expirada durante la descarga del censo');
      await sleep(this.pausaMs);

      // Paso 2: resolver la URL del window.open(...) y descargar el censo.
      const urlCenso = require('./parser').extractCensoUrl(r.body);
      r = await this._request('GET', '/' + urlCenso, { referer: 'principal.asp' });
      this._assertOk(r, urlCenso);
      if (this._esRedireccionALogin(r)) throw new PhedsError('Sesion expirada al descargar el censo');

      const html = r.body.toString('utf8');
      // Valida por marcadores (HTTP 200 miente: censo vacio tambien da 200).
      if (!/Nombre del Paciente/i.test(html)) {
        throw new PhedsError('El censo no contiene la tabla de pacientes (posible censo vacio/mal formado)');
      }
      return html;
    } finally {
      // Regla: quien conmuta, restaura.
      if (areaOriginal && areaOriginal !== this.areaActual) {
        await this.ensureArea(areaOriginal);
      }
    }
  }

  // ---------- Servicio real por paciente (hospital) ----------
  // El area del censo es imprecisa (camas -> central). El servicio correcto
  // esta en paciente.asp?folio=X (campo "Servicio"). Se obtiene el folio desde
  // Camasmanejo.asp (mapa de camas con NSS oculto).

  // GET con reintento para las descargas masivas (tolerar timeouts/5xx puntuales).
  async _getConReintento(pathname, referer, intentos = 2) {
    let lastErr;
    for (let i = 0; i < intentos; i++) {
      try {
        const r = await this._request('GET', pathname, { referer });
        this._assertOk(r, pathname);
        return r;
      } catch (e) {
        lastErr = e;
        if (i < intentos - 1) await sleep(this.pausaDetalleMs * 3);
      }
    }
    throw lastErr;
  }

  // Centrales de enfermeria de la unidad (desde resumen.asp).
  async getCentrales() {
    if (!this.loggedIn) throw new PhedsError('No hay sesion iniciada');
    const r = await this._request('GET', '/resumen.asp', { referer: 'principal.asp' });
    this._assertOk(r, 'resumen.asp');
    return require('./parser').parseCentrales(r.body);
  }

  // Mapa de camas de una central: [{ cama, folio, anio, central, nss, curp }].
  async getCamaFolios(central) {
    const r = await this._getConReintento(`/Camasmanejo.asp?central=${central}`, 'Camas.asp');
    await sleep(this.pausaDetalleMs);
    return require('./parser').parseCamaFolios(r.body, central);
  }

  // Servicio del paciente (campo "Servicio" de paciente.asp). Cacheado por folio.
  async getPacienteServicio(folio, anio, central) {
    if (this.serviceCache.has(folio)) return this.serviceCache.get(folio);
    const r = await this._getConReintento(`/paciente.asp?folio=${folio}&anio=${anio || 26}&central=${central}`, 'Camasmanejo.asp');
    const svc = require('./parser').extractServicio(r.body);
    this.serviceCache.set(folio, svc);
    await sleep(this.pausaDetalleMs);
    return svc;
  }
}

module.exports = { PhedsClient, PhedsError };
