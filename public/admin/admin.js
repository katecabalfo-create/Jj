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
      const on = href === h || (href === '#/avisos' && h.startsWith('#/avisos') && !h.includes('status=pending') && !h.startsWith('#/avisos/nuevo'));
      a.toggleAttribute('aria-current', on);
      if (on) a.setAttribute('aria-current', 'page');
    });
  }

  // ---------- Login ----------
  function showLogin() {
    $('#admin-header').hidden = true;
    view.innerHTML = `<form class="panel login" id="login-form">
      <h1>🔐 Panel de administración</h1>
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
      ${!s.smtp ? '<div class="alert">✉️ No hay servidor de correo (SMTP) configurado: las notificaciones quedan en cola hasta que lo configures. Ver <a href="#/alertas">Notificaciones</a>.</div>' : ''}
      <div class="stats">
        <a class="stat" href="#/avisos?status=pending"><b>${s.byStatus.pending || 0}</b><span>Pendientes de revisión</span></a>
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
      <div class="section-head"><h1>${params.status === 'pending' ? '⏳ Pendientes de revisión' : '📋 Avisos'}</h1><a class="btn btn-primary btn-sm" href="#/avisos/nuevo">＋ Nuevo aviso</a></div>
      <form class="admin-filters" id="af">
        <input class="full" name="q" type="search" placeholder="Buscar título, descripción, empresa…" value="${esc(params.q || '')}">
        <select name="category">${opt('', 'Todas las secciones')}${META.categories.map((c) => opt(c.id, c.label, params.category)).join('')}</select>
        <select name="status">${opt('', 'Todos los estados')}${Object.entries(STATUS).map(([k, v]) => opt(k, v, params.status)).join('')}</select>
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
          <td><span class="badge badge-${l.status}">${STATUS[l.status]}</span></td>
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
        <div class="field"><label>Imagen</label>
          ${l.image ? `<img src="${esc(l.image)}" class="img-preview" alt="">` : ''}
          <input name="image" placeholder="URL de la imagen (https://…)" value="${esc(l.image || '')}">
          <input type="file" name="imageFile" accept="image/*"><small>Si subís un archivo, reemplaza la URL.</small></div>
        <fieldset><legend>Contacto</legend>
          <div class="field"><label>Nombre</label><input name="contact_name" value="${esc(l.contact_name || '')}"></div>
          <div class="row-2">
            <div class="field"><label>Teléfono</label><input name="contact_phone" value="${esc(l.contact_phone || '')}"></div>
            <div class="field"><label>Email</label><input name="contact_email" type="email" value="${esc(l.contact_email || '')}"></div>
          </div>
          <div class="field"><label>Sitio web</label><input name="website" value="${esc(l.website || '')}"></div>
        </fieldset>
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
    };
    form.category.addEventListener('change', sync);
    sync();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      if (!form.featured.checked) fd.set('featured', '0');
      if (!form.imageFile.files.length) fd.delete('imageFile');
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
          <label class="check"><input type="checkbox" name="moderation" value="1" ${s.moderation === '1' ? 'checked' : ''}> Revisar los avisos del público antes de publicarlos (recomendado)</label>
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
      try {
        await api('/api/admin/settings', { method: 'PUT', json: body });
        toast('Ajustes guardados');
      } catch (err) {
        toast(err.message);
      }
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
