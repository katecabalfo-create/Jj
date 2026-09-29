/* Maldonado Oportunidades — panel de administración */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $('#view');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const STATUS = { pending: 'Pendiente', approved: 'Publicado', rejected: 'Rechazado' };
  let META = null;
  let ME = null;

  async function api(url, opts = {}) {
    const init = { ...opts };
    if (init.json !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(init.json);
      delete init.json;
    }
    const res = await fetch(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* vacío */
    }
    if (res.status === 401 && !url.endsWith('/login')) {
      showLogin();
      throw new Error('Sesión vencida');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.fields = data && data.fields;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 3000);
  }

  const cat = (id) => META.categories.find((c) => c.id === id) || { label: id, icon: '' };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('es-UY', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const nf = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 });
  const money = (a, c) => `${c === 'USD' ? 'US$' : '$'} ${nf.format(a || 0)}`;
  const TYPES = { empresa: '🏢 Empresa', servicios: '🛠️ Servicios', alquileres: '🏠 Alquileres' };
  const PAY = { pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado', cancelled: 'Cancelado' };
  const PAYB = { pending: 'badge-pending', approved: 'badge-approved', rejected: 'badge-rejected', cancelled: '' };
  const METHOD = { mercadopago: 'Mercado Pago', transfer: 'Transferencia Itaú', free: 'Gratis', demo: 'Demo' };
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`;

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, q = ''] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), params: Object.fromEntries(new URLSearchParams(q)) };
  }
  const hashFor = (path, params) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))).toString();
    return `#${path}${qs ? `?${qs}` : ''}`;
  };

  function setNav() {
    const h = location.hash || '#/';
    $$('#admin-nav a').forEach((a) => {
      const href = a.getAttribute('href');
      const on = href === h || (href === '#/avisos' && h.startsWith('#/avisos') && !h.includes('payment=ready') && !h.startsWith('#/avisos/nuevo'));
      a.toggleAttribute('aria-current', on);
      if (on) a.setAttribute('aria-current', 'page');
    });
  }

  // ---------- Login ----------
  function showLogin() {
    $('#admin-header').hidden = true;
    view.innerHTML = `<form class="panel login" id="login-form">
      <img class="auth-logo" src="/img/icon.svg" alt="Maldonado Oportunidades" width="56" height="56">
      <h1>Panel de administración</h1>
      <div class="field"><label for="pw">Contraseña</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus></div>
      <button class="btn btn-primary" style="width:100%">Entrar</button>
    </form>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/login', { method: 'POST', json: { password: e.target.password.value } });
        start();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // ---------- Resumen ----------
  async function dashboard() {
    const s = await api('/api/admin/stats');
    const perCat = {};
    for (const r of s.byCategory) {
      perCat[r.category] = perCat[r.category] || { approved: 0, pending: 0, rejected: 0 };
      perCat[r.category][r.status] = r.n;
    }
    view.innerHTML = `
      ${ME.defaultPassword ? '<div class="alert">⚠️ Estás usando la contraseña por defecto. Definí la variable de entorno <code>ADMIN_PASSWORD</code> en el servidor.</div>' : ''}
      ${!s.mercadopago ? '<div class="alert">💳 Mercado Pago no está configurado: definí <code>MP_ACCESS_TOKEN</code> en el servidor para cobrar con tarjeta. Mientras tanto se puede pagar por transferencia.</div>' : ''}
      ${!s.transferReady ? '<div class="alert">🏦 La transferencia bancaria no está disponible: cargá tu cuenta Itaú en <a href="#/ajustes">Ajustes</a>.</div>' : ''}
      ${s.receiptsToReview ? `<div class="alert">📎 Hay ${s.receiptsToReview} comprobante(s) de transferencia para revisar. <a href="#/pagos?status=pending&method=transfer">Revisar →</a></div>` : ''}
      ${s.demo ? '<div class="alert">🧪 Modo de pagos de prueba activo (<code>PAYMENTS_DEMO=1</code>). Desactivalo antes de abrir el sitio al público.</div>' : ''}
      ${!s.smtp ? '<div class="alert">✉️ No hay servidor de correo (SMTP) configurado: las notificaciones quedan en cola hasta que lo configures. Ver <a href="#/alertas">Notificaciones</a>.</div>' : ''}
      <div class="stats">
        <a class="stat" href="#/avisos?status=pending&payment=ready"><b>${s.pendingReady}</b><span>Pendientes de revisión</span></a>
        <a class="stat" href="#/pagos"><b>${s.revenue30.length ? s.revenue30.map((r) => money(r.total, r.currency)).join(' + ') : '$ 0'}</b><span>Ingresos últimos 30 días</span></a>
        <a class="stat" href="#/pagos?status=pending&method=transfer"><b>${s.pendingTransfers}</b><span>Transferencias por confirmar</span></a>
        <a class="stat" href="#/usuarios"><b>${Object.values(s.users).reduce((a, b) => a + b, 0)}</b><span>Anunciantes (🏢 ${s.users.empresa || 0} · 🛠️ ${s.users.servicios || 0} · 🏠 ${s.users.alquileres || 0})</span></a>
        <a class="stat" href="#/avisos?status=approved"><b>${s.byStatus.approved || 0}</b><span>Publicados</span></a>
        <div class="stat"><b>${s.views}</b><span>Visitas a avisos</span></div>
        <a class="stat" href="#/alertas"><b>${s.subs.active}</b><span>Suscriptores activos</span></a>
        <div class="stat"><b>${s.last7}</b><span>Avisos nuevos (7 días)</span></div>
        <a class="stat" href="#/avisos?status=rejected"><b>${s.byStatus.rejected || 0}</b><span>Rechazados</span></a>
        <a class="stat" href="#/alertas"><b>${s.outbox.queued || 0}</b><span>Emails en cola</span></a>
        <a class="stat" href="#/alertas"><b>${s.outbox.sent || 0}</b><span>Emails enviados</span></a>
      </div>
      <h2>Por sección</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Sección</th><th>Publicados</th><th>Pendientes</th><th>Rechazados</th></tr></thead>
        <tbody>${META.categories
          .map((c) => {
            const r = perCat[c.id] || {};
            return `<tr><td><a href="#/avisos?category=${c.id}">${c.icon} ${esc(c.label)}</a></td><td>${r.approved || 0}</td><td>${r.pending ? `<a href="#/avisos?category=${c.id}&status=pending"><b>${r.pending}</b></a>` : 0}</td><td>${r.rejected || 0}</td></tr>`;
          })
          .join('')}</tbody>
      </table></div>`;
  }

  // ---------- Lista de avisos ----------
  async function listingsView(params) {
    const q = new URLSearchParams({ pageSize: '25', sort: 'recent', ...params });
    const data = await api(`/api/admin/listings?${q}`);
    const go = (patch) => (location.hash = hashFor('/avisos', { ...params, page: '', ...patch }));
    view.innerHTML = `
      <div class="section-head"><h1>${params.status === 'pending' && params.payment === 'ready' ? '⏳ Pendientes de revisión' : '📋 Avisos'}</h1><a class="btn btn-primary btn-sm" href="#/avisos/nuevo">＋ Nuevo aviso</a></div>
      <form class="admin-filters" id="af">
        <input class="full" name="q" type="search" placeholder="Buscar título, descripción, empresa…" value="${esc(params.q || '')}">
        <select name="category">${opt('', 'Todas las secciones')}${META.categories.map((c) => opt(c.id, c.label, params.category)).join('')}</select>
        <select name="status">${opt('', 'Todos los estados')}${Object.entries(STATUS).map(([k, v]) => opt(k, v, params.status)).join('')}</select>
        <select name="payment">${opt('', 'Pago: todos')}${opt('ready', 'Sin deuda de pago', params.payment)}${opt('unpaid', 'Falta pagar', params.payment)}${opt('paid', 'Pagados', params.payment)}${opt('none', 'Gratuitos / admin', params.payment)}</select>
        <select name="sort">${[['recent', 'Más recientes'], ['oldest', 'Más antiguos'], ['popular', 'Más vistos'], ['price_desc', 'Precio ↓'], ['price_asc', 'Precio ↑'], ['title', 'Título']].map(([v, l]) => opt(v, l, params.sort || 'recent')).join('')}</select>
        <button class="btn btn-primary">Filtrar</button>
      </form>
      <div class="bulk">
        <span class="muted">${data.total} aviso(s) · Con seleccionados:</span>
        <button class="btn btn-sm" data-bulk="approved">✅ Aprobar</button>
        <button class="btn btn-sm" data-bulk="rejected">🚫 Rechazar</button>
        <button class="btn btn-sm" data-bulk="feature">★ Destacar</button>
        <button class="btn btn-sm" data-bulk="unfeature">☆ Quitar destacado</button>
        <button class="btn btn-sm btn-danger" data-bulk="delete">🗑 Eliminar</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="check-all" aria-label="Seleccionar todos"></th><th></th><th>Aviso</th><th>Sección</th><th>Estado</th><th>Fecha</th><th>Visitas</th><th>Acciones</th></tr></thead>
        <tbody>${
          data.items.length
            ? data.items
                .map(
                  (l) => `<tr>
          <td><input type="checkbox" class="row-check" value="${l.id}" aria-label="Seleccionar"></td>
          <td>${l.image ? `<img class="thumb" src="${esc(l.image)}" alt="">` : `<div class="thumb" style="display:grid;place-items:center">${cat(l.category).icon}</div>`}</td>
          <td class="title-cell"><a href="#/avisos/${l.id}">${l.featured ? '★ ' : ''}${esc(l.title)}</a><div class="muted" style="font-size:.82rem">#${l.id} · ${esc(l.location || '')} ${l.contact_phone ? `· ${esc(l.contact_phone)}` : ''} ${l.contact_email ? `· ${esc(l.contact_email)}` : ''}</div></td>
          <td>${esc(cat(l.category).label)}</td>
          <td><span class="badge badge-${l.status}">${STATUS[l.status]}</span>${l.payment_status === 'unpaid' ? ' <span class="badge badge-rejected">Sin pagar</span>' : l.payment_status === 'paid' ? ' <span class="badge badge-approved">💳 Pago</span>' : ''}${l.paused ? ' <span class="badge">Pausado</span>' : ''}${l.user_id ? `<div><a href="#/usuarios?id=${l.user_id}" style="font-size:.8rem">Cuenta #${l.user_id}</a></div>` : ''}</td>
          <td style="white-space:nowrap">${fmtDate(l.created_at)}</td>
          <td>${l.views}</td>
          <td class="actions">
            ${l.status !== 'approved' ? `<button class="btn btn-sm" data-act="approved" data-id="${l.id}" title="Aprobar">✅</button>` : ''}
            ${l.status !== 'rejected' ? `<button class="btn btn-sm" data-act="rejected" data-id="${l.id}" title="Rechazar">🚫</button>` : ''}
            <a class="btn btn-sm" href="#/avisos/${l.id}" title="Editar">✏️</a>
            ${l.status === 'approved' ? `<a class="btn btn-sm" href="/#/aviso/${l.id}" target="_blank" title="Ver en el sitio">↗</a>` : ''}
          </td></tr>`,
                )
                .join('')
            : '<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No hay avisos con esos filtros.</td></tr>'
        }</tbody>
      </table></div>
      ${data.pages > 1 ? `<nav class="pagination">
        ${data.page > 1 ? `<a class="btn" href="${hashFor('/avisos', { ...params, page: data.page - 1 })}">‹ Anterior</a>` : ''}
        <span class="muted">Página ${data.page} de ${data.pages}</span>
        ${data.page < data.pages ? `<a class="btn" href="${hashFor('/avisos', { ...params, page: data.page + 1 })}">Siguiente ›</a>` : ''}
      </nav>` : ''}`;

    $('#af').addEventListener('submit', (e) => {
      e.preventDefault();
      go(Object.fromEntries(new FormData(e.target)));
    });
    $('#check-all').addEventListener('change', (e) => $$('.row-check').forEach((c) => (c.checked = e.target.checked)));
    $$('[data-act]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/api/admin/listings/${b.dataset.id}`, { method: 'PUT', json: { status: b.dataset.act } });
        toast(b.dataset.act === 'approved' ? 'Aviso aprobado y publicado' : 'Aviso rechazado');
        route();
      }),
    );
    $$('[data-bulk]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ids = $$('.row-check:checked').map((c) => Number(c.value));
        if (!ids.length) return toast('Seleccioná al menos un aviso');
        if (b.dataset.bulk === 'delete' && !confirm(`¿Eliminar ${ids.length} aviso(s) definitivamente?`)) return;
        const r = await api('/api/admin/listings/bulk', { method: 'POST', json: { ids, action: b.dataset.bulk } });
        toast(`${r.affected} aviso(s) actualizados`);
        route();
      }),
    );
  }

  // ---------- Formulario de alta / edición ----------
  async function editView(id) {
    const isNew = id === 'nuevo';
    const l = isNew ? { category: 'empleo-maldonado', status: 'approved', currency: 'UYU', featured: 0 } : await api(`/api/admin/listings/${id}`);
    view.innerHTML = `
      <div class="section-head"><h1>${isNew ? '＋ Nuevo aviso' : `✏️ Editar aviso #${l.id}`}</h1>
        ${!isNew ? `<span class="badge badge-${l.status}">${STATUS[l.status]}</span>` : ''}</div>
      <form id="edit-form" class="panel" novalidate style="max-width:820px">
        <div class="row-2">
          <div class="field"><label>Sección</label><select name="category">${META.categories.map((c) => opt(c.id, `${c.icon} ${c.label}`, l.category)).join('')}</select></div>
          <div class="field"><label>Estado</label><select name="status">${Object.entries(STATUS).map(([k, v]) => opt(k, v, l.status)).join('')}</select></div>
        </div>
        <div class="field"><label>Título</label><input name="title" value="${esc(l.title || '')}" maxlength="140"></div>
        <div class="row-2">
          <div class="field"><label>Tipo</label><select name="subtype" data-value="${esc(l.subtype || '')}"></select></div>
          <div class="field"><label>Ubicación</label><select name="location" data-value="${esc(l.location || '')}"></select></div>
        </div>
        <div class="field"><label>Empresa / organizador / fuente</label><input name="company" value="${esc(l.company || '')}"></div>
        <div class="field"><label>Descripción</label><textarea name="description" rows="8">${esc(l.description || '')}</textarea></div>
        <div class="row-2">
          <div class="field"><label>Precio / sueldo</label><input name="price" inputmode="decimal" value="${l.price ?? ''}"></div>
          <div class="field"><label>Moneda</label><select name="currency">${opt('UYU', 'Pesos ($)', l.currency)}${opt('USD', 'Dólares (US$)', l.currency)}</select></div>
        </div>
        <div class="row-2">
          <div class="field"><label>Fecha del evento</label><input type="date" name="event_date" value="${esc((l.event_date || '').slice(0, 10))}"></div>
          <div class="field"><label>Vence el <small>(se oculta después de esta fecha)</small></label><input type="date" name="expires_at" value="${esc((l.expires_at || '').slice(0, 10))}"></div>
        </div>
        <div class="field"><label>Fotos</label><div id="a-photos"></div></div>
        <div class="field" id="map-field" hidden><label>Ubicación en el mapa</label><div id="a-map"></div>
          <input type="hidden" name="lat"><input type="hidden" name="lng"></div>
        <fieldset><legend>Contacto</legend>
          <div class="field"><label>Nombre</label><input name="contact_name" value="${esc(l.contact_name || '')}"></div>
          <div class="row-2">
            <div class="field"><label>Teléfono</label><input name="contact_phone" value="${esc(l.contact_phone || '')}"></div>
            <div class="field"><label>Email</label><input name="contact_email" type="email" value="${esc(l.contact_email || '')}"></div>
          </div>
          <div class="field"><label>Sitio web</label><input name="website" value="${esc(l.website || '')}"></div>
        </fieldset>
        <div class="row-2">
          <div class="field"><label>Pago</label><select name="payment_status">${opt('none', 'No requiere pago', l.payment_status || 'none')}${opt('unpaid', 'Falta pagar (oculto)', l.payment_status)}${opt('paid', 'Pagado', l.payment_status)}</select></div>
          <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="paused" value="1" ${l.paused ? 'checked' : ''}> Pausado por el anunciante</label></div>
        </div>
        <label class="check" style="margin-bottom:16px"><input type="checkbox" name="featured" value="1" ${l.featured ? 'checked' : ''}> ★ Aviso destacado (aparece primero)</label>
        ${!isNew ? `<p class="muted" style="font-size:.85rem">Creado ${fmtDate(l.created_at)} · Publicado ${fmtDate(l.published_at)} · ${l.views} visitas</p>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" type="submit" style="flex:1">Guardar</button>
          <a class="btn" href="#/avisos">Cancelar</a>
          ${!isNew ? '<button class="btn btn-danger" type="button" id="del">🗑 Eliminar</button>' : ''}
        </div>
      </form>`;

    const form = $('#edit-form');
    const sync = () => {
      const c = cat(form.category.value);
      const st = form.subtype;
      const lo = form.location;
      const keep = (sel, list) => {
        const cur = sel.value || sel.dataset.value;
        const all = cur && !list.includes(cur) ? [cur, ...list] : list;
        sel.innerHTML = `<option value="">—</option>${all.map((x) => opt(x, x, cur)).join('')}`;
      };
      keep(st, c.subtypes || []);
      keep(lo, c.locations || []);
      $('#map-field').hidden = !c.hasMap;
      if (c.hasMap && !mapReady) {
        mapReady = true;
        MO.mapPicker($('#a-map'), { lat: l.lat ?? null, lng: l.lng ?? null, bounds: META.uyBounds, latInput: form.elements.lat, lngInput: form.elements.lng });
      }
    };
    let mapReady = false;
    const photos = MO.photoManager($('#a-photos'), { initial: MO.parseImages(l), max: META.maxImages, onMessage: toast });
    form.category.addEventListener('change', sync);
    sync();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      if (!form.featured.checked) fd.set('featured', '0');
      if (!form.paused.checked) fd.set('paused', '0');
      photos.apply(fd);
      if ($('#map-field').hidden) {
        fd.delete('lat');
        fd.delete('lng');
      }
      try {
        const saved = await api(isNew ? '/api/admin/listings' : `/api/admin/listings/${l.id}`, { method: isNew ? 'POST' : 'PUT', body: fd });
        toast('Guardado');
        location.hash = `#/avisos/${saved.id}`;
        if (!isNew) route();
      } catch (err) {
        toast(err.message);
        $$('.field .error', form).forEach((x) => x.remove());
        for (const [k, msg] of Object.entries(err.fields || {})) {
          const f = form.elements[k] && form.elements[k].closest('.field');
          if (f) f.insertAdjacentHTML('beforeend', `<span class="error">${esc(msg)}</span>`);
        }
      }
    });
    const del = $('#del');
    if (del)
      del.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este aviso definitivamente?')) return;
        await api(`/api/admin/listings/${l.id}`, { method: 'DELETE' });
        toast('Aviso eliminado');
        location.hash = '#/avisos';
      });
  }

  // ---------- Notificaciones ----------
  async function alertsView() {
    const [subs, outbox] = await Promise.all([api('/api/admin/subscriptions'), api('/api/admin/outbox')]);
    const freq = { instant: 'Al instante', daily: 'Diario', weekly: 'Semanal' };
    view.innerHTML = `
      <h1>🔔 Notificaciones</h1>
      ${ME.smtp ? '<p class="muted">Servidor de correo configurado. Los emails se envían automáticamente cada 5 minutos.</p>' : `<div class="alert">No hay SMTP configurado. Para enviar emails definí en el servidor las variables <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> y <code>SMTP_FROM</code> (ver README). Mientras tanto los correos quedan en cola.</div>`}
      <div class="panel" style="margin-bottom:16px">
        <h2>Enviar ahora / probar</h2>
        <form id="test-form" style="display:flex;gap:8px;flex-wrap:wrap">
          <input name="to" type="email" placeholder="tu@email.com" style="flex:1;min-width:200px">
          <button class="btn">Enviar email de prueba</button>
          <button class="btn btn-primary" type="button" id="flush">Procesar cola y resúmenes</button>
        </form>
      </div>
      <h2>Suscriptores (${subs.length})</h2>
      <div class="table-wrap" style="margin-bottom:20px"><table>
        <thead><tr><th>Email</th><th>Secciones</th><th>Palabras clave</th><th>Zona</th><th>Frecuencia</th><th>Activa</th><th></th></tr></thead>
        <tbody>${
          subs.length
            ? subs
                .map((s) => {
                  const cats = JSON.parse(s.categories);
                  return `<tr><td>${esc(s.email)}</td><td>${cats.length ? cats.map((c) => esc(cat(c).label)).join(', ') : 'Todas'}</td><td>${esc(s.keywords || '—')}</td><td>${esc(s.location || 'Todas')}</td><td>${freq[s.frequency]}</td>
            <td><input type="checkbox" data-sub-active="${s.id}" ${s.active ? 'checked' : ''} aria-label="Activa"></td>
            <td><button class="btn btn-sm btn-danger" data-sub-del="${s.id}">🗑</button></td></tr>`;
                })
                .join('')
            : '<tr><td colspan="7" class="muted" style="text-align:center">Todavía no hay suscriptores.</td></tr>'
        }</tbody>
      </table></div>
      <div class="section-head"><h2>Últimos emails (${outbox.length})</h2><button class="btn btn-sm" id="clear-outbox">Limpiar enviados/errores</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Para</th><th>Asunto</th><th>Estado</th><th>Fecha</th></tr></thead>
        <tbody>${
          outbox.length
            ? outbox
                .map(
                  (m) => `<tr><td>${esc(m.to_email)}</td><td><details><summary>${esc(m.subject)}</summary><pre class="mail">${esc(m.body)}</pre></details></td>
            <td><span class="badge ${m.status === 'sent' ? 'badge-approved' : m.status === 'error' ? 'badge-rejected' : 'badge-pending'}" title="${esc(m.error)}">${m.status === 'sent' ? 'Enviado' : m.status === 'error' ? 'Error' : 'En cola'}</span></td>
            <td style="white-space:nowrap">${fmtDate(m.created_at)}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="4" class="muted" style="text-align:center">Sin emails.</td></tr>'
        }</tbody>
      </table></div>`;

    $('#test-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/admin/test-email', { method: 'POST', json: { to: e.target.to.value } });
        toast(r.smtp ? `Enviados: ${r.sent}` : 'Email en cola (falta configurar SMTP)');
        route();
      } catch (err) {
        toast(err.message);
      }
    });
    $('#flush').addEventListener('click', async () => {
      const r = await api('/api/admin/outbox/flush', { method: 'POST' });
      toast(r.smtp ? `Enviados: ${r.sent} · Resúmenes: ${r.digests}` : `Resúmenes armados: ${r.digests}. Falta configurar SMTP.`);
      route();
    });
    $('#clear-outbox').addEventListener('click', async () => {
      await api('/api/admin/outbox', { method: 'DELETE' });
      route();
    });
    $$('[data-sub-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este suscriptor?')) return;
        await api(`/api/admin/subscriptions/${b.dataset.subDel}`, { method: 'DELETE' });
        route();
      }),
    );
    $$('[data-sub-active]').forEach((c) =>
      c.addEventListener('change', async () => {
        await api(`/api/admin/subscriptions/${c.dataset.subActive}`, { method: 'PUT', json: { active: c.checked } });
        toast(c.checked ? 'Alerta activada' : 'Alerta pausada');
      }),
    );
  }

  // ---------- Ajustes y AdSense ----------
  async function settingsView() {
    const s = await api('/api/admin/settings');
    view.innerHTML = `
      <h1>⚙️ Ajustes</h1>
      <form id="settings-form" style="max-width:820px">
        <fieldset><legend>Sitio</legend>
          <div class="field"><label>Nombre del sitio</label><input name="site_name" value="${esc(s.site_name)}"></div>
          <div class="field"><label>Descripción</label><input name="site_tagline" value="${esc(s.site_tagline)}"></div>
          <div class="field"><label>Email de contacto / administración</label><input name="contact_email" type="email" value="${esc(s.contact_email)}"><small>Recibe un aviso por cada publicación nueva y aparece en la página de privacidad.</small></div>
          <div class="field"><label>Avisos por página</label><input name="page_size" type="number" min="3" max="50" value="${esc(s.page_size)}"></div>
          <label class="check"><input type="checkbox" name="moderation" value="1" ${s.moderation === '1' ? 'checked' : ''}> Revisar los avisos anónimos (sin cuenta) antes de publicarlos</label>
        </fieldset>
        <fieldset><legend>💳 Cobros a anunciantes</legend>
          <p class="muted" style="margin-top:0">Mercado Pago: ${ME.mercadopago ? '✅ configurado' : '❌ sin configurar (definí <code>MP_ACCESS_TOKEN</code> en el servidor; ver README)'}. Los precios se editan en <a href="#/planes">Planes y precios</a>.</p>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="payments_transfer_enabled" value="1" ${s.payments_transfer_enabled === '1' ? 'checked' : ''}> Aceptar transferencia bancaria (se confirma a mano en <a href="#/pagos">Pagos</a>)</label>
          <div class="row-2">
            <div class="field"><label>Banco</label><input name="transfer_bank" value="${esc(s.transfer_bank)}"></div>
            <div class="field"><label>Tipo de cuenta</label><select name="transfer_account_type">${['Caja de ahorro', 'Cuenta corriente'].map((t) => opt(t, t, s.transfer_account_type)).join('')}</select></div>
          </div>
          <div class="row-2">
            <div class="field"><label>N.º de cuenta en pesos (UYU)</label><input name="transfer_account_uyu" inputmode="numeric" placeholder="Ej: 1234567" value="${esc(s.transfer_account_uyu)}"></div>
            <div class="field"><label>N.º de cuenta en dólares (USD)</label><input name="transfer_account_usd" inputmode="numeric" placeholder="Opcional" value="${esc(s.transfer_account_usd)}"></div>
          </div>
          <div class="row-2">
            <div class="field"><label>Titular</label><input name="transfer_holder" value="${esc(s.transfer_holder)}"></div>
            <div class="field"><label>RUT / CI del titular</label><input name="transfer_holder_doc" value="${esc(s.transfer_holder_doc)}"></div>
          </div>
          <div class="field"><label>Sucursal <small>(opcional)</small></label><input name="transfer_branch" value="${esc(s.transfer_branch)}"></div>
          <div class="field"><label>Instrucciones para el anunciante</label><textarea name="bank_transfer_info" rows="3">${esc(s.bank_transfer_info)}</textarea>
            <small>La transferencia solo se ofrece para los planes cuya moneda tenga una cuenta cargada.</small></div>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="moderation_accounts" value="1" ${s.moderation_accounts === '1' ? 'checked' : ''}> Revisar también los avisos pagos antes de publicarlos</label>
          <label class="check"><input type="checkbox" name="public_free_posting" value="1" ${s.public_free_posting === '1' ? 'checked' : ''}> Permitir además publicar gratis sin cuenta (formulario anónimo)</label>
        </fieldset>
        <fieldset><legend>🧾 Datos para los comprobantes</legend>
          <p class="muted" style="margin-top:0">Estos datos aparecen en el comprobante de pago que descarga cada anunciante. En <a href="#/pagos">Pagos</a> podés exportar los pagos a un CSV para tu contador.</p>
          <div class="field"><label>Razón social</label><input name="billing_name" value="${esc(s.billing_name)}"></div>
          <div class="row-2">
            <div class="field"><label>RUT</label><input name="billing_rut" inputmode="numeric" value="${esc(s.billing_rut)}"></div>
            <div class="field"><label>Dirección</label><input name="billing_address" value="${esc(s.billing_address)}"></div>
          </div>
        </fieldset>
        <fieldset><legend>📬 Cuentas y avisos por email</legend>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="require_email_verification" value="1" ${s.require_email_verification === '1' ? 'checked' : ''}> Pedir que los anunciantes confirmen su email antes de publicar${ME.smtp ? '' : ' <small class="muted">(se aplica cuando configures el servidor de correo)</small>'}</label>
          <div class="field"><label>Avisar por email antes del vencimiento (días)</label><input name="expiry_reminder_days" type="number" min="0" max="30" value="${esc(s.expiry_reminder_days)}"><small>0 = no avisar.</small></div>
          <label class="check"><input type="checkbox" name="cookie_banner" value="1" ${s.cookie_banner === '1' ? 'checked' : ''}> Mostrar el aviso de cookies a los visitantes</label>
        </fieldset>
        <fieldset><legend>💰 Google AdSense</legend>
          <p class="muted" style="margin-top:0">1) Creá tu cuenta en <a href="https://adsense.google.com" target="_blank" rel="noopener">adsense.google.com</a> y agregá tu dominio. 2) Pegá acá tu ID de editor. 3) Cuando Google apruebe el sitio, creá bloques de anuncios "Display" y pegá sus IDs de bloque (data-ad-slot). El archivo <a href="/ads.txt" target="_blank">/ads.txt</a> se genera solo.</p>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="adsense_enabled" value="1" ${s.adsense_enabled === '1' ? 'checked' : ''}> Activar anuncios de AdSense</label>
          <div class="field"><label>ID de editor (client)</label><input name="adsense_client" placeholder="ca-pub-1234567890123456" value="${esc(s.adsense_client)}"></div>
          <div class="row-2">
            <div class="field"><label>Bloque superior (debajo de las pestañas)</label><input name="adsense_slot_top" inputmode="numeric" placeholder="1234567890" value="${esc(s.adsense_slot_top)}"></div>
            <div class="field"><label>Bloque entre avisos (in-feed)</label><input name="adsense_slot_feed" inputmode="numeric" value="${esc(s.adsense_slot_feed)}"></div>
          </div>
          <div class="row-2">
            <div class="field"><label>Bloque en el detalle del aviso</label><input name="adsense_slot_detail" inputmode="numeric" value="${esc(s.adsense_slot_detail)}"></div>
            <div class="field"><label>Mostrar anuncio cada N avisos</label><input name="adsense_feed_every" type="number" min="2" max="30" value="${esc(s.adsense_feed_every)}"></div>
          </div>
          <small class="muted">Si solo pegás el ID de editor sin bloques, podés usar los "Anuncios automáticos" desde el panel de AdSense: el script ya queda cargado en todas las páginas.</small>
        </fieldset>
        <button class="btn btn-primary" style="width:100%">Guardar ajustes</button>
      </form>`;
    $('#settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = Object.fromEntries(new FormData(f));
      body.moderation = f.moderation.checked ? '1' : '0';
      body.adsense_enabled = f.adsense_enabled.checked ? '1' : '0';
      for (const k of ['payments_transfer_enabled', 'moderation_accounts', 'public_free_posting', 'require_email_verification', 'cookie_banner']) body[k] = f[k].checked ? '1' : '0';
      try {
        await api('/api/admin/settings', { method: 'PUT', json: body });
        toast('Ajustes guardados');
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // ---------- Anunciantes ----------
  async function usersView(params) {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'id')));
    let rows = await api(`/api/admin/users?${q}`);
    if (params.id) rows = rows.filter((u) => String(u.id) === params.id);
    view.innerHTML = `
      <h1>👥 Anunciantes</h1>
      <form class="admin-filters" id="uf">
        <input class="full" name="q" type="search" placeholder="Email, nombre, empresa o RUT" value="${esc(params.q || '')}">
        <select name="type">${opt('', 'Todos los tipos')}${Object.entries(TYPES).map(([k, v]) => opt(k, v, params.type)).join('')}</select>
        <button class="btn btn-primary">Buscar</button>
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Anunciante</th><th>Tipo</th><th>Avisos</th><th>Pagado</th><th>Alta</th><th>Email confirmado</th><th>Verificado</th><th>Activo</th><th></th></tr></thead>
        <tbody>${
          rows.length
            ? rows
                .map(
                  (u) => `<tr>
          <td>${u.id}</td>
          <td><strong>${esc(u.business_name || u.name)}</strong><div class="muted" style="font-size:.82rem">${esc(u.name)} · ${esc(u.email)}${u.phone ? ` · ${esc(u.phone)}` : ''}${u.rut ? ` · RUT ${esc(u.rut)}` : ''}</div></td>
          <td style="white-space:nowrap">${TYPES[u.type]}</td>
          <td><a href="#/avisos?user=${u.id}">${u.listings}</a></td>
          <td style="white-space:nowrap">${money(u.paid, 'UYU')}</td>
          <td style="white-space:nowrap">${fmtDate(u.created_at)}</td>
          <td><input type="checkbox" data-email-ok="${u.id}" ${u.email_verified ? 'checked' : ''} aria-label="Email confirmado"></td>
          <td><input type="checkbox" data-verified="${u.id}" ${u.verified ? 'checked' : ''} aria-label="Verificado"></td>
          <td><input type="checkbox" data-active="${u.id}" ${u.active ? 'checked' : ''} aria-label="Activo"></td>
          <td class="actions"><a class="btn btn-sm" href="/#/anunciante/${u.id}" target="_blank" title="Página pública">↗</a> <button class="btn btn-sm btn-danger" data-del-user="${u.id}" title="Eliminar">🗑</button></td></tr>`,
                )
                .join('')
            : '<tr><td colspan="10" class="muted" style="text-align:center;padding:30px">No hay anunciantes.</td></tr>'
        }</tbody></table></div>
      <p class="muted" style="font-size:.88rem">Desactivar una cuenta oculta todos sus avisos del sitio y le impide ingresar. "Verificado" muestra un ✔️ junto a su nombre.</p>`;
    $('#uf').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = hashFor('/usuarios', Object.fromEntries(new FormData(e.target)));
    });
    $$('[data-verified]').forEach((c) => c.addEventListener('change', async () => {
      await api(`/api/admin/users/${c.dataset.verified}`, { method: 'PUT', json: { verified: c.checked } });
      toast(c.checked ? 'Marcado como verificado' : 'Verificación quitada');
    }));
    $$('[data-email-ok]').forEach((c) => c.addEventListener('change', async () => {
      await api(`/api/admin/users/${c.dataset.emailOk}`, { method: 'PUT', json: { email_verified: c.checked } });
      toast(c.checked ? 'Email marcado como confirmado' : 'Email marcado como no confirmado');
    }));
    $$('[data-active]').forEach((c) => c.addEventListener('change', async () => {
      await api(`/api/admin/users/${c.dataset.active}`, { method: 'PUT', json: { active: c.checked } });
      toast(c.checked ? 'Cuenta activada' : 'Cuenta suspendida: sus avisos se ocultaron');
    }));
    $$('[data-del-user]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar la cuenta y TODOS sus avisos? No se puede deshacer.')) return;
      await api(`/api/admin/users/${b.dataset.delUser}`, { method: 'DELETE' });
      toast('Cuenta eliminada');
      route();
    }));
  }

  // ---------- Pagos ----------
  async function paymentsView(params) {
    const rows = await api(`/api/admin/payments?${new URLSearchParams(params)}`);
    const totals = {};
    rows.filter((p) => p.status === 'approved' && p.method !== 'demo').forEach((p) => (totals[p.currency] = (totals[p.currency] || 0) + p.amount));
    view.innerHTML = `
      <h1>💳 Pagos</h1>
      <form class="admin-filters" id="pf">
        <select name="status">${opt('', 'Todos los estados')}${Object.entries(PAY).map(([k, v]) => opt(k, v, params.status)).join('')}</select>
        <select name="method">${opt('', 'Todos los medios')}${Object.entries(METHOD).map(([k, v]) => opt(k, v, params.method)).join('')}</select>
        <button class="btn btn-primary">Filtrar</button>
      </form>
      <div class="panel" style="margin:12px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:end">
        <div class="field" style="margin:0"><label for="csv-month">Exportar pagos aprobados para el contador</label><input id="csv-month" type="month" value="${new Date().toISOString().slice(0, 7)}"></div>
        <a class="btn" id="csv-link" href="/api/admin/payments.csv?month=${new Date().toISOString().slice(0, 7)}">⬇️ Descargar CSV (Excel)</a>
        <a class="btn btn-ghost btn-sm" href="/api/admin/payments.csv">Todos los meses</a>
      </div>
      <p class="muted">${rows.length} pago(s) · Aprobados en esta lista: <strong>${Object.entries(totals).map(([c, t]) => money(t, c)).join(' + ') || '$ 0'}</strong></p>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Anunciante</th><th>Detalle</th><th>Monto</th><th>Medio</th><th>Estado</th><th>Fecha</th><th></th></tr></thead>
        <tbody>${
          rows.length
            ? rows
                .map(
                  (p) => `<tr>
          <td>${p.id}</td>
          <td><a href="#/usuarios?id=${p.user_id}">${esc(p.business_name || p.name)}</a><div class="muted" style="font-size:.8rem">${esc(p.email)}</div></td>
          <td>${esc(p.description)}${p.listing_id ? ` <a href="#/avisos/${p.listing_id}" style="font-size:.8rem">(aviso #${p.listing_id})</a>` : ''}${p.note ? `<div class="muted" style="font-size:.8rem">${esc(p.note)}</div>` : ''}${p.provider_payment_id ? `<div class="muted" style="font-size:.8rem">MP #${esc(p.provider_payment_id)}</div>` : ''}${p.receipt_file ? `<div style="font-size:.85rem;margin-top:4px"><a href="/api/admin/payments/${p.id}/receipt" target="_blank">📎 Ver comprobante</a> <span class="muted">(${fmtDate(p.receipt_at)})</span></div>` : p.method === 'transfer' && p.status === 'pending' ? '<div class="muted" style="font-size:.8rem">Sin comprobante todavía</div>' : ''}${p.payer_note ? `<div class="muted" style="font-size:.8rem">💬 ${esc(p.payer_note)}</div>` : ''}</td>
          <td style="white-space:nowrap"><strong>${money(p.amount, p.currency)}</strong></td>
          <td>${METHOD[p.method]}</td>
          <td><span class="badge ${PAYB[p.status]}">${PAY[p.status]}</span></td>
          <td style="white-space:nowrap">${fmtDate(p.created_at)}${p.paid_at ? `<div class="muted" style="font-size:.8rem">Pagado ${fmtDate(p.paid_at)}</div>` : ''}</td>
          <td class="actions">${
            p.status === 'approved' && p.method !== 'demo' && Number(p.amount) > 0
              ? `<a class="btn btn-sm" href="/api/admin/payments/${p.id}/recibo" target="_blank" title="Comprobante de pago">🧾 Comprobante</a>`
              : p.status === 'pending'
              ? `<button class="btn btn-sm" data-approve="${p.id}" title="Confirmar pago">✅ Confirmar</button> <button class="btn btn-sm" data-reject="${p.id}" title="Rechazar">🚫</button>${p.method === 'mercadopago' ? ` <button class="btn btn-sm" data-sync="${p.id}" title="Consultar a Mercado Pago">🔄</button>` : ''}`
              : ''
          }</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No hay pagos.</td></tr>'
        }</tbody></table></div>`;
    $('#pf').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = hashFor('/pagos', Object.fromEntries(new FormData(e.target)));
    });
    $('#csv-month').addEventListener('change', (e) => ($('#csv-link').href = `/api/admin/payments.csv?month=${e.target.value}`));
    $$('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Confirmás que recibiste este pago? El aviso se publicará.')) return;
      await api(`/api/admin/payments/${b.dataset.approve}/approve`, { method: 'POST', json: {} });
      toast('Pago confirmado y aviso publicado');
      route();
    }));
    $$('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const note = prompt('Motivo (se muestra al anunciante):', 'No recibimos la transferencia');
      if (note === null) return;
      await api(`/api/admin/payments/${b.dataset.reject}/reject`, { method: 'POST', json: { note } });
      route();
    }));
    $$('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/api/admin/payments/${b.dataset.sync}/sync`, { method: 'POST' });
      toast(`Estado: ${PAY[r.status]}`);
      route();
    }));
  }

  // ---------- Planes ----------
  async function plansView() {
    const plans = await api('/api/admin/plans');
    const row = (p) => `<tr data-plan="${p.id || ''}">
      <td><select name="account_type">${Object.entries(TYPES).map(([k, v]) => opt(k, v, p.account_type)).join('')}</select></td>
      <td><input name="name" value="${esc(p.name || '')}" placeholder="Nombre"><input name="description" value="${esc(p.description || '')}" placeholder="Descripción" style="margin-top:6px"></td>
      <td><input name="price" inputmode="decimal" value="${p.price ?? ''}" style="min-width:90px"><select name="currency" style="margin-top:6px">${opt('UYU', '$', p.currency)}${opt('USD', 'US$', p.currency)}</select></td>
      <td><input name="duration_days" type="number" min="1" max="365" value="${p.duration_days || 30}" style="min-width:70px"></td>
      <td><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''} aria-label="Destacado"></td>
      <td><input type="checkbox" name="active" ${p.active !== 0 ? 'checked' : ''} aria-label="Activo"></td>
      <td><input name="sort" type="number" value="${p.sort || 0}" style="min-width:60px"></td>
      <td class="actions"><button class="btn btn-sm btn-primary" data-save>Guardar</button></td></tr>`;
    view.innerHTML = `
      <h1>🏷️ Planes y precios</h1>
      <p class="muted">Cada anunciante ve solo los planes de su tipo de cuenta. Precio 0 = gratis. Un plan "destacado" pone el aviso primero en su sección. Los precios se cobran por aviso.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Tipo de cuenta</th><th>Plan</th><th>Precio</th><th>Días</th><th>Destacado</th><th>Activo</th><th>Orden</th><th></th></tr></thead>
        <tbody id="plans-body">${plans.map(row).join('')}</tbody>
      </table></div>
      <p><button class="btn" id="add-plan">＋ Agregar plan</button></p>`;
    const bind = (tr) => $('[data-save]', tr).addEventListener('click', async () => {
      const g = (n) => $(`[name="${n}"]`, tr);
      const body = {
        account_type: g('account_type').value, name: g('name').value, description: g('description').value, price: g('price').value,
        currency: g('currency').value, duration_days: g('duration_days').value, featured: g('featured').checked, active: g('active').checked, sort: g('sort').value,
      };
      try {
        const id = tr.dataset.plan;
        const saved = await api(id ? `/api/admin/plans/${id}` : '/api/admin/plans', { method: id ? 'PUT' : 'POST', json: body });
        tr.dataset.plan = saved.id;
        toast('Plan guardado');
      } catch (err) {
        toast(err.fields ? Object.values(err.fields).join(' · ') : err.message);
      }
    });
    $$('#plans-body tr').forEach(bind);
    $('#add-plan').addEventListener('click', () => {
      $('#plans-body').insertAdjacentHTML('beforeend', row({ account_type: 'empresa', currency: 'UYU', duration_days: 30, active: 1 }));
      bind($('#plans-body tr:last-child'));
    });
  }

  // ---------- Router ----------
  async function route() {
    const { parts, params } = parseHash();
    setNav();
    try {
      if (!parts.length) await dashboard();
      else if (parts[0] === 'avisos' && parts[1]) await editView(parts[1]);
      else if (parts[0] === 'avisos') await listingsView(params);
      else if (parts[0] === 'alertas') await alertsView();
      else if (parts[0] === 'usuarios') await usersView(params);
      else if (parts[0] === 'pagos') await paymentsView(params);
      else if (parts[0] === 'planes') await plansView();
      else if (parts[0] === 'ajustes') await settingsView();
      else location.hash = '#/';
    } catch (err) {
      if (err.message !== 'Sesión vencida') view.innerHTML = `<div class="empty" style="margin:20px 0">Error: ${esc(err.message)}</div>`;
    }
  }

  async function start() {
    ME = await api('/api/admin/me');
    if (!ME.admin) return showLogin();
    META = META || (await api('/api/meta'));
    $('#admin-header').hidden = false;
    route();
  }

  window.addEventListener('hashchange', () => ME && ME.admin && route());
  $('#logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    ME = null;
    showLogin();
  });
  start();
})();
