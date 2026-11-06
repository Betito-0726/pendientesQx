'use strict';
// app.js — SPA de censos PHEDS + gestión de preoperatorios.

// Vistas: cada pestaña. "fuente" indica de que censo se nutre;
// "areaFiltro" restringe por area fisica. "preoperatorios" es especial.
const VIEWS = {
  hospital:       { fuente: 'hospital',        areaFiltro: null },
  recuperacion:   { fuente: 'hospital',        areaFiltro: /recuperaci/i },
  uci:            { fuente: 'hospital',        areaFiltro: /cuidados\s+intensivos/i },
  urgencias:      { fuente: 'urgencias',       areaFiltro: null },
  preoperatorios: { fuente: 'preoperatorios',  areaFiltro: null },
};

const state = {
  view: 'hospital',
  cache: { hospital: null, urgencias: null },
  loggedIn: false,
  usuario: null,   // matricula del usuario autenticado
  filtroServicio: '',
  busqueda: '',
  preop: {},      // nss -> registro pendiente
  preopList: [],  // lista de registros pendientes (para la pestaña)
};

const $ = (id) => document.getElementById(id);

// Modo de operación: 'server' (servidor local con PHEDS) o 'static' (solo lectura desde JSON).
let MODO = 'server';

// API en modo estático: los censos se leen de JSON local; cirugías y CIE9
// se resuelven vía las funciones de Netlify (endpoints /api/cirugias y /api/cie9).
function staticApi(path, opts) {
  const method = (opts && opts.method) || 'GET';
  const m = path.match(/^\/api\/censo\/(hospital|urgencias)$/);
  if (m && method === 'GET') {
    return fetch(`data/${m[1]}.json`).then((r) => r.json());
  }
  // Cirugías (GET/POST) y CIE9 (POST) → funciones de Netlify.
  return fetch(path, opts).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
    return data;
  });
}

function api(path, opts) {
  if (MODO === 'static') return staticApi(path, opts);
  return fetch(path, opts).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
    return data;
  });
}

function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- fechas ----------
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function formatoFechaHora(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd} ${MESES[d.getMonth()]}, ${d.getFullYear()}; ${hh}:${mi} hrs`;
}

// Tiempo transcurrido en formato compacto: ">1h", "12h", "1d 12h".
function tiempoTranscurrido(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return '>1h';
  const totalHoras = Math.floor(ms / 3600000);
  const dias = Math.floor(totalHoras / 24);
  const horas = totalHoras % 24;
  if (dias > 0) return `${dias}d ${horas}h`;
  if (totalHoras >= 1) return `${totalHoras}h`;
  return '>1h'; // menos de 1 hora
}

// ---------- helpers de vista ----------
function viewCfg() { return VIEWS[state.view]; }
function esVistaPreop() { return state.view === 'preoperatorios'; }

function getDatos() {
  const v = viewCfg();
  const data = state.cache[v.fuente];
  if (!data) return null;
  let pacs = data.pacientes || [];
  if (v.areaFiltro) pacs = pacs.filter((p) => v.areaFiltro.test(p.area || ''));
  return Object.assign({}, data, { pacientes: pacs });
}

function servicioLabel(p) { return p.servicio || ''; }

function servicioClass(servicio) {
  const s = norm(servicio);
  if (/cirugia/.test(s)) return 'svc-cirugia';
  if (/medicina interna/.test(s)) return 'svc-medicina';
  if (/traumatologia|ortopedia/.test(s)) return 'svc-tyo';
  if (/urologi/.test(s)) return 'svc-urologia';
  return '';
}

function especialidadLabel(esp) {
  if (!esp) return '';
  if (/cuidados intensivos/i.test(esp)) return 'UCI';
  return esp;
}

function especialidadCategoria(esp) {
  if (!esp) return null;
  const s = norm(esp);
  if (/cirugia/.test(s)) return 'CIRUGÍA';
  if (/medicina interna/.test(s)) return 'MEDICINA INTERNA';
  if (/traumatologia|ortopedia/.test(s)) return 'TRAUMATOLOGÍA';
  if (/urologi/.test(s)) return 'UROLOGÍA';
  if (/oftalmo/.test(s)) return 'OFTALMOLOGÍA';
  if (/cuidados intensivos/.test(s)) return 'UCI';
  return esp;
}

function filterLabel(p) {
  if (state.view === 'urgencias') return especialidadCategoria(p.especialidad_ingreso);
  return servicioLabel(p);
}

function esRecuperacion(p) {
  return /recuperaci/i.test(p.area || '');
}

// Busca un paciente por NSS en los censos cacheados.
function buscarPaciente(nss) {
  for (const k of ['hospital', 'urgencias']) {
    const data = state.cache[k];
    if (!data) continue;
    const p = (data.pacientes || []).find((x) => x.nss === nss);
    if (p) return p;
  }
  return null;
}

// ---------- UI ----------
function setLoading(on) {
  $('loading').classList.toggle('hidden', !on);
  if (on) { $('lista').innerHTML = ''; $('empty').classList.add('hidden'); }
}

function campoRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="campo"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div></div>`;
}

function formatNSS(nss) {
  const d = String(nss || '').replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  return nss || '';
}

// ---------- modal ----------
function openModal(titulo, html) {
  $('modalTitle').textContent = titulo;
  $('modalBody').innerHTML = html;
  $('modalOverlay').classList.remove('hidden');
}

function closeModal() {
  $('modalOverlay').classList.add('hidden');
  $('modalBody').innerHTML = '';
}

// ---------- render: tarjetas ----------
function renderSummary(data) {
  const s = $('summary');
  if (!data) { s.classList.add('hidden'); s.innerHTML = ''; return; }
  s.innerHTML = `<span class="chip"><b>${data.pacientes.length}</b> pacientes</span>`;
  if (data.fecha) s.innerHTML += `<span class="chip">${esc(data.fecha)}</span>`;
  s.classList.remove('hidden');
}

function pacienteCard(p) {
  const svc = servicioLabel(p);
  const svcBadge = svc
    ? `<span class="servicio-badge ${servicioClass(svc)}" title="${p.servicio_verificado === false ? 'Servicio sin verificar' : 'Servicio'}">${esc(svc)}</span>`
    : '';
  const esp = especialidadLabel(p.especialidad_ingreso);
  const espBadge = esp
    ? `<span class="servicio-badge ${servicioClass(esp)}" title="Especialidad de ingreso">${esc(esp)}</span>`
    : '';
  const qxPending = !!state.preop[p.nss];
  const qxBadge = qxPending
    ? `<button type="button" class="badge-qx" data-nss="${esc(p.nss)}" title="Ver cirugía pendiente">QX PENDIENTE</button>`
    : '';
  const edad = p.edad ? `<span class="edad">${esc(p.edad)} años</span>` : '';
  const medico = p.medico ? `<div class="medico"><span class="k">Médico tratante</span> <span class="v">${esc(p.medico)}</span></div>` : '';
  const dxBlock = (p.dx_codigo || p.dx_descripcion || p.diagnostico)
    ? `<div class="dx"><span class="codigo">${esc(p.dx_codigo || '')}</span>${esc(p.dx_descripcion || p.diagnostico || '')}</div>`
    : '';

  const nssAgregado = [formatNSS(p.nss), p.agregado].filter(Boolean).join(' ');
  const campos = [
    campoRow('NSS / Agregado', nssAgregado),
    campoRow('Ingreso', p.ingreso),
    campoRow('Estancia', p.estancia),
    campoRow('Alta', p.alta),
    campoRow('Resolución', p.resolucion),
    campoRow('Fecha resolución', p.resolucion_fecha),
    campoRow('Espera', p.espera),
  ].join('');

  const btnMarcar = (esRecuperacion(p) || state.preop[p.nss])
    ? ''
    : `<button type="button" class="btn-marcar" data-nss="${esc(p.nss)}">Marcar para cirugía</button>`;

  return `<article class="paciente${qxPending ? ' qx' : ''}">
    <div class="top"><h3 class="nombre">${esc(p.nombre || '(sin nombre)')}</h3><span class="cama">${esc(p.cama || '')}</span></div>
    <div class="meta"><span class="badges">${svcBadge}${espBadge}${qxBadge}</span>${edad}</div>
    ${medico}
    ${dxBlock}
    <details class="detalles">
      <summary aria-label="Ver más"></summary>
      <div class="campos">${campos}</div>
      ${btnMarcar}
    </details>
  </article>`;
}

function renderLista() {
  if (esVistaPreop()) { renderPreoperatorios(); return; }
  const data = getDatos();
  const lista = $('lista');
  const empty = $('empty');
  lista.classList.remove('modo-tabla');
  if (!data) { lista.innerHTML = ''; empty.classList.add('hidden'); return; }

  let pacs = data.pacientes || [];
  if (state.filtroServicio) pacs = pacs.filter((p) => filterLabel(p) === state.filtroServicio);
  if (state.busqueda) {
    const q = norm(state.busqueda);
    pacs = pacs.filter((p) => {
      const hay = [p.nombre, p.nss, p.agregado, p.dx_codigo, p.dx_descripcion, p.diagnostico, p.medico, p.cama, p.servicio, p.especialidad_ingreso];
      return hay.some((x) => norm(x).includes(q));
    });
  }

  lista.innerHTML = pacs.map(pacienteCard).join('');
  empty.classList.toggle('hidden', pacs.length > 0);
  renderSummary(Object.assign({}, data, { pacientes: pacs }));
}

function renderServicioFilter(data) {
  const menu = $('filtroMenu');
  const counts = new Map();
  if (data) {
    for (const p of data.pacientes) {
      const lbl = filterLabel(p);
      if (lbl) counts.set(lbl, (counts.get(lbl) || 0) + 1);
    }
  }
  const labels = [...counts.keys()].sort();
  const items = [`<button type="button" class="dropdown-item${state.filtroServicio === '' ? ' selected' : ''}" data-value="">Todos</button>`];
  for (const s of labels) {
    const cls = servicioClass(s);
    const sel = state.filtroServicio === s ? ' selected' : '';
    items.push(`<button type="button" class="dropdown-item${sel}" data-value="${esc(s)}">
      <span class="label">${esc(s)}</span>
      <span class="count-badge ${cls}">${counts.get(s)}</span>
    </button>`);
  }
  menu.innerHTML = items.join('');
  $('filtroLabel').textContent = state.filtroServicio || 'Todos';
}

function setFiltroAbierto(open) {
  $('filtroMenu').toggleAttribute('hidden', !open);
  $('filtroBtn').setAttribute('aria-expanded', String(open));
}

// ---------- render: preoperatorios ----------
function renderPreoperatorios() {
  const lista = $('lista');
  const empty = $('empty');
  const summary = $('summary');
  const preops = state.preopList || [];
  lista.classList.add('modo-tabla');

  if (preops.length === 0) {
    lista.innerHTML = '';
    summary.classList.add('hidden');
    empty.textContent = 'Sin pacientes en preoperatorio.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  summary.innerHTML = `<span class="chip"><b>${preops.length}</b> preoperatorios</span>`;
  summary.classList.remove('hidden');
  lista.innerHTML = `<table class="preop-tabla">
    <thead><tr><th>Cama</th><th>Nombre</th><th>Cirugía planeada (CIE9)</th><th>Médico</th><th title="Tiempo transcurrido">&#9201;</th></tr></thead>
    <tbody>${preops.map(preopRow).join('')}</tbody>
  </table>`;
}

function preopRow(r) {
  const cirugia = r.cie9 || r.cirugia_natural || '';
  return `<tr class="preop-summary" data-nss="${esc(r.nss)}">
    <td>${esc(r.cama || '')}</td>
    <td>${esc(r.nombre || '')}</td>
    <td>${esc(cirugia)}</td>
    <td>${esc(r.medico || '')}</td>
    <td class="preop-tiempo">${esc(tiempoTranscurrido(r.fecha_solicitud))}</td>
  </tr>
  <tr class="preop-detalles" hidden>
    <td colspan="5"><div class="preop-detalles-cuerpo">
      <div class="campos">
        ${campoRow('NSS', formatNSS(r.nss))}
        ${campoRow('Agregado', r.agregado)}
        ${campoRow('Diagnóstico', r.diagnostico)}
        ${campoRow('Especialidad', r.servicio)}
        ${campoRow('Procedimiento planeado', r.cirugia_natural)}
        ${campoRow('CIE9', r.cie9)}
        ${campoRow('Fecha de solicitud', formatoFechaHora(new Date(r.fecha_solicitud)))}
        ${campoRow('Tiempo transcurrido', tiempoTranscurrido(r.fecha_solicitud))}
      </div>
      <button type="button" class="btn-cerrar" data-nss="${esc(r.nss)}">Cerrar procedimiento</button>
    </div></td>
  </tr>`;
}

// ---------- datos ----------
async function cargarCenso(fuente) {
  setLoading(true);
  try {
    const data = await api(`/api/censo/${fuente}`);
    state.cache[fuente] = data;
    if (viewCfg().fuente === fuente) {
      renderServicioFilter(getDatos());
      renderLista();
      $('lastUpdate').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-MX');
    }
  } catch (e) {
    if (viewCfg().fuente === fuente) console.error(e.message);
  } finally {
    if (viewCfg().fuente === fuente) setLoading(false);
  }
}

async function cargarPreoperatorios() {
  try {
    const lista = await api('/api/cirugias');
    state.preopList = lista;
    state.preop = {};
    for (const r of lista) state.preop[r.nss] = r;
  } catch (e) {
    console.error(e.message);
  }
  if (esVistaPreop()) renderPreoperatorios();
  else renderLista();
}

// ---------- modales de preoperatorio ----------
function abrirMarcar(nss) {
  const p = buscarPaciente(nss);
  if (!p) return;
  const fecha = formatoFechaHora(new Date());
  openModal('Marcar para cirugía', `
    <form id="formMarcar">
      <label>Cirugía programada
        <input id="mCirugia" type="text" placeholder="Designación del procedimiento (lenguaje natural)" />
      </label>
      <div class="row-cie9">
        <button type="button" id="mBuscarCie9" class="btn-secundario">Buscar CIE9</button>
        <input id="mCie9" type="text" placeholder="CIE9 (se llena automáticamente)" />
      </div>
      <label>Observaciones
        <textarea id="mObservaciones" rows="2"></textarea>
      </label>
      <label>Fecha de solicitud
        <input id="mFecha" type="text" readonly value="${esc(fecha)}" />
      </label>
      <div class="modal-acciones">
        <button type="button" class="btn-cancelar" data-cerrar>Cerrar</button>
        <button type="submit" class="btn-primario">Guardar</button>
      </div>
    </form>
  `);
  $('mBuscarCie9').addEventListener('click', async () => {
    const texto = $('mCirugia').value.trim();
    if (!texto) { $('mCie9').value = ''; return; }
    $('mCie9').value = 'Buscando…';
    try {
      const r = await api('/api/cie9', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }) });
      $('mCie9').value = r.cie9;
    } catch (e) {
      $('mCie9').value = '';
      alert('No se pudo resolver el CIE9: ' + e.message);
    }
  });
  $('formMarcar').addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitMarcar(p);
  });
}

async function submitMarcar(p) {
  const cirugia_natural = $('mCirugia').value.trim();
  if (!cirugia_natural) { alert('Indica la cirugía programada.'); return; }
  const datos = {
    nss: p.nss,
    nombre: p.nombre,
    cama: p.cama,
    medico: p.medico,
    medico_matricula: p.medico_matricula || '',
    servicio: p.servicio,
    diagnostico: p.dx_descripcion || p.diagnostico || '',
    agregado: p.agregado,
    area: p.area,
    cirugia_natural,
    cie9: $('mCie9').value.trim(),
    observaciones: $('mObservaciones').value.trim(),
    programado_por: state.usuario || null,
  };
  try {
    await api('/api/cirugias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
    closeModal();
    await cargarPreoperatorios();
  } catch (e) {
    alert('Error al guardar: ' + e.message);
  }
}

function puedeEditar(r) {
  if (!state.usuario) return true; // demo (sin login) → permitir
  return state.usuario === r.programado_por || state.usuario === r.medico_matricula;
}

function abrirQxDetalle(nss) {
  const r = state.preop[nss];
  if (!r) return;
  const btnEditar = puedeEditar(r)
    ? `<button type="button" class="btn-secundario" id="qxEditar">Editar</button>`
    : '';
  openModal('Cirugía pendiente', `
    <div class="qx-detalle">
      ${campoRow('Paciente', r.nombre)}
      ${campoRow('Cama', r.cama)}
      ${campoRow('Procedimiento planeado', r.cirugia_natural)}
      ${campoRow('CIE9', r.cie9)}
      ${campoRow('Fecha de solicitud', formatoFechaHora(new Date(r.fecha_solicitud)))}
      ${campoRow('Tiempo transcurrido', tiempoTranscurrido(r.fecha_solicitud))}
      ${campoRow('Observaciones', r.observaciones)}
      <div class="modal-acciones">
        ${btnEditar}
        <button type="button" class="btn-cerrar" id="qxCerrar">Cerrar procedimiento</button>
      </div>
    </div>
  `);
  if (btnEditar) $('qxEditar').addEventListener('click', () => abrirEditar(nss));
  $('qxCerrar').addEventListener('click', () => abrirCerrar(nss));
}

function abrirCerrar(nss) {
  openModal('Cerrar procedimiento', `
    <div class="cerrar-opciones">
      <p class="cerrar-hint">Elige cómo cerrar este procedimiento:</p>
      <button type="button" class="btn-realizado" id="cMarcar">Marcar como realizado</button>
      <button type="button" class="btn-cancelar-proc" id="cCancelar">Cancelar procedimiento</button>
    </div>
  `);
  $('cMarcar').addEventListener('click', () => abrirRealizado(nss));
  $('cCancelar').addEventListener('click', () => cancelarProcedimiento(nss));
}

async function cancelarProcedimiento(nss) {
  if (!confirm('¿Cancelar y eliminar este procedimiento?')) return;
  try {
    await api(`/api/cirugias/${encodeURIComponent(nss)}/cancelar`, { method: 'POST' });
    closeModal();
    await cargarPreoperatorios();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function abrirEditar(nss) {
  const r = state.preop[nss];
  if (!r) return;
  openModal('Editar cirugía', `
    <form id="formEditar">
      <label>Cirugía programada
        <input id="eCirugia" type="text" value="${esc(r.cirugia_natural || '')}" />
      </label>
      <div class="row-cie9">
        <button type="button" id="eBuscarCie9" class="btn-secundario">Buscar CIE9</button>
        <input id="eCie9" type="text" value="${esc(r.cie9 || '')}" />
      </div>
      <label>Observaciones
        <textarea id="eObservaciones" rows="2">${esc(r.observaciones || '')}</textarea>
      </label>
      <div class="modal-acciones">
        <button type="button" class="btn-cancelar" data-cerrar>Cerrar</button>
        <button type="submit" class="btn-primario">Guardar cambios</button>
      </div>
    </form>
  `);
  $('eBuscarCie9').addEventListener('click', async () => {
    const texto = $('eCirugia').value.trim();
    if (!texto) { $('eCie9').value = ''; return; }
    $('eCie9').value = 'Buscando…';
    try {
      const rr = await api('/api/cie9', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }) });
      $('eCie9').value = rr.cie9;
    } catch (e) {
      $('eCie9').value = '';
      alert('No se pudo resolver el CIE9: ' + e.message);
    }
  });
  $('formEditar').addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitEditar(nss);
  });
}

async function submitEditar(nss) {
  const datos = {
    cirugia_natural: $('eCirugia').value.trim(),
    cie9: $('eCie9').value.trim(),
    observaciones: $('eObservaciones').value.trim(),
  };
  try {
    await api(`/api/cirugias/${encodeURIComponent(nss)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
    closeModal();
    await cargarPreoperatorios();
  } catch (e) {
    alert('Error al guardar: ' + e.message);
  }
}

function abrirRealizado(nss) {
  const r = state.preop[nss];
  if (!r) return;
  const fecha = formatoFechaHora(new Date());
  openModal('Procedimiento realizado', `
    <form id="formRealizado">
      <label>Cirugía realizada
        <input id="rCirugia" type="text" placeholder="La planeada" value="${esc(r.cirugia_natural || '')}" />
      </label>
      <label>Hallazgos
        <textarea id="rHallazgos" rows="2"></textarea>
      </label>
      <label>Tiempo quirúrgico
        <input id="rTiempo" type="text" placeholder="Ej: 1h 30m" />
      </label>
      <label>Cirujano
        <input id="rCirujano" type="text" placeholder="${esc(r.medico || '')}" value="${esc(r.medico || '')}" />
      </label>
      <label>Fecha
        <input id="rFecha" type="text" readonly value="${esc(fecha)}" />
      </label>
      <div class="modal-acciones">
        <button type="button" class="btn-cancelar" data-cerrar>Cerrar</button>
        <button type="submit" class="btn-realizado">Confirmar procedimiento realizado</button>
      </div>
    </form>
  `);
  $('formRealizado').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('¿Confirmar que el procedimiento fue realizado?')) return;
    const datos = {
      cirugia_realizada: $('rCirugia').value.trim(),
      hallazgos: $('rHallazgos').value.trim(),
      tiempo_quirurgico: $('rTiempo').value.trim(),
      cirujano: $('rCirujano').value.trim(),
    };
    try {
      await api(`/api/cirugias/${encodeURIComponent(nss)}/realizado`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
      closeModal();
      await cargarPreoperatorios();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  });
}

// ---------- acciones ----------
function cambiarView(view) {
  if (state.view === view) return;
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  state.filtroServicio = '';
  state.busqueda = '';
  $('search').value = '';
  $('toolbar').classList.toggle('hidden', view === 'preoperatorios');

  if (view === 'preoperatorios') {
    renderPreoperatorios();
    return;
  }
  const fuente = viewCfg().fuente;
  const data = state.cache[fuente];
  if (data) { renderServicioFilter(getDatos()); renderLista(); }
  else cargarCenso(fuente);
}

// ---------- login ----------
async function onLoginSubmit(e) {
  e.preventDefault();
  const btn = $('btnLogin');
  const msg = $('loginMsg');
  btn.disabled = true;
  msg.textContent = 'Conectando…';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: $('fUsuario').value.trim(), pass: $('fPass').value }),
    });
    state.usuario = r.usuario || null;
    entrarApp();
  } catch (err) {
    msg.textContent = err.message || 'No se pudo iniciar sesión';
  } finally {
    btn.disabled = false;
  }
}

function entrarApp() {
  state.loggedIn = true;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  cargarCenso(viewCfg().fuente);
  cargarPreoperatorios();
}

// ---------- init ----------
function init() {
  $('loginForm').addEventListener('submit', onLoginSubmit);
  $('btnRefresh').addEventListener('click', () => {
    if (esVistaPreop()) { cargarPreoperatorios(); return; }
    state.cache[viewCfg().fuente] = null;
    cargarCenso(viewCfg().fuente);
  });
  $('btnLogout').addEventListener('click', () => location.reload());
  $('search').addEventListener('input', (e) => { state.busqueda = e.target.value.trim(); renderLista(); });
  $('filtroBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    setFiltroAbierto($('filtroMenu').hasAttribute('hidden'));
  });
  $('filtroMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    state.filtroServicio = item.dataset.value;
    setFiltroAbierto(false);
    renderServicioFilter(getDatos());
    renderLista();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#filtroWrap')) setFiltroAbierto(false);
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => cambiarView(t.dataset.view)));

  // Delegación de clics en la lista (tarjetas + tabla de preoperatorios).
  $('lista').addEventListener('click', (e) => {
    const qx = e.target.closest('.badge-qx');
    if (qx) { abrirQxDetalle(qx.dataset.nss); return; }
    const m = e.target.closest('.btn-marcar');
    if (m) { abrirMarcar(m.dataset.nss); return; }
    const r = e.target.closest('.btn-cerrar');
    if (r) { abrirCerrar(r.dataset.nss); return; }
    const row = e.target.closest('.preop-summary');
    if (row) {
      const det = row.nextElementSibling;
      if (!det || !det.classList.contains('preop-detalles')) return;
      const estabaAbierto = !det.hasAttribute('hidden');
      // Cerrar todas las filas de detalle, luego abrir esta si estaba cerrada.
      document.querySelectorAll('tr.preop-detalles').forEach((d) => d.setAttribute('hidden', ''));
      if (!estabaAbierto) det.removeAttribute('hidden');
    }
  });

  // Modal: cerrar.
  $('modalClose').addEventListener('click', closeModal);
  $('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeModal(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-cerrar]')) closeModal();
  });

  // Acordeón (details): solo uno abierto a la vez.
  // El evento 'toggle' no burbujea, por eso se usa fase de captura.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.classList.contains('detalles') || !d.open) return;
    document.querySelectorAll('details.detalles[open]').forEach((o) => {
      if (o !== d) o.open = false;
    });
  }, true);

  // Detectar modo: si /api/estado no responde JSON, es estático (solo lectura).
  fetch('/api/estado')
    .then((r) => {
      const ct = (r.headers.get('content-type') || '');
      MODO = (r.ok && ct.includes('application/json')) ? 'server' : 'static';
    })
    .catch(() => { MODO = 'static'; })
    .then(() => {
      if (MODO === 'static') { entrarApp(); return; }
      api('/api/estado').then((st) => {
        if (st.loggedIn) { entrarApp(); return; }
        if (st.demo) { entrarApp(); return; }
        $('login').classList.remove('hidden');
      }).catch(() => { $('login').classList.remove('hidden'); });
    });

  // Actualizar el "tiempo transcurrido" cada hora (solo la vista de preoperatorios).
  setInterval(() => {
    if (esVistaPreop()) renderPreoperatorios();
  }, 3600000);
}

init();
