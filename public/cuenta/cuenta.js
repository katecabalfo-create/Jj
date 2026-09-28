/* Maldonado Oportunidades — panel de anunciantes (Empresas, Servicios, Alquileres) */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $('#view');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let META = null;
  let USER = null;

  const METHOD_LABEL = {
    mercadopago: '💳 Mercado Pago (tarjeta de crédito/débito, Abitab, Redpagos)',
    transfer: '🏦 Transferencia bancaria',
    demo: '🧪 Pago de prueba (modo demo)',
    free: 'Gratis',
  };
  const PAY_STATUS = { pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado', cancelled: 'Cancelado' };
  const PAY_BADGE = { pending: 'badge-pending', approved: 'badge-approved', rejected: 'badge-rejected', cancelled: 'badge-paused' };

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
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.fields = data && data.fields;
      err.status = res.status;
      if (res.status === 401 && USER) {
        USER = null;
        renderChrome();
        location.hash = '#/ingresar';
      }
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 3500);
  }

  const nf = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 });
  const money = (amount, cur) => (Number(amount) === 0 ? 'Gratis' : `${cur === 'USD' ? 'US$' : '$'} ${nf.format(amount)}`);
  const fmtDate = (s) => {
    if (!s) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('es-UY');
    }
    return new Date(s).toLocaleString('es-UY', { dateStyle: 'short', timeStyle: 'short' });
  };
  const cat = (id) => META.categories.find((c) => c.id === id) || { label: id, icon: '📌', locations: [], subtypes: [] };
  const type = (id) => META.accountTypes.find((t) => t.id === id);
  const today = () => new Date().toISOString().slice(0, 10);

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, q = ''] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), params: Object.fromEntries(new URLSearchParams(q)) };
  }

  function showErrors(form, fields) {
    $$('.field', form).forEach((f) => {
      f.classList.remove('invalid');
      $$('.error', f).forEach((e) => e.remove());
    });
    let first = null;
    for (const [name, msg] of Object.entries(fields || {})) {
      let el = form.elements[name];
      if (name === 'contact') el = form.elements.contact_phone;
      if (el && !el.closest && el[0]) el = el[0];
      const field = el && el.closest('.field');
      if (!field) continue;
      field.classList.add('invalid');
      field.insertAdjacentHTML('beforeend', `<span class="error">${esc(msg)}</span>`);
      first = first || field;
    }
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Estado de un aviso desde el punto de vista del anunciante. */
  function listingState(l) {
    if (l.payment_status === 'unpaid') return ['unpaid', 'Falta pagar'];
    if (l.status === 'rejected') return ['rejected', 'Rechazado'];
    if (l.expires_at && l.expires_at.slice(0, 10) < today()) return ['expired', 'Vencido'];
    if (l.paused) return ['paused', 'Pausado'];
    if (l.status === 'pending') return ['pending', 'En revisión'];
    return ['approved', 'Publicado'];
  }

  // ---------- Encabezado y navegación ----------
  function renderChrome() {
    const t = USER && type(USER.type);
    $('#panel-name').textContent = t ? `· ${t.panel}` : 'Oportunidades';
    $('#user-actions').innerHTML = USER
      ? `<a class="btn btn-ghost btn-sm" href="/" title="Ver el sitio">🌐 <span class="hide-sm">Ver sitio</span></a><a class="btn btn-primary btn-sm" href="#/avisos/nuevo">＋ <span class="hide-sm">Nuevo aviso</span></a>`
      : `<a class="btn btn-ghost btn-sm" href="/">← Sitio</a><a class="btn btn-sm" href="#/ingresar">Ingresar</a>`;
    $('#account-tabs').hidden = !USER;
    if (USER) {
      const items = [
        ['#/', '📊 Resumen'],
        ['#/avisos', '📋 Mis avisos'],
        ['#/avisos/nuevo', '＋ Nuevo aviso'],
        ['#/pagos', '💳 Pagos'],
        ['#/perfil', '👤 Perfil'],
      ];
      const h = location.hash.split('?')[0] || '#/';
      $('#account-nav').innerHTML = items
        .map(([href, label]) => {
          const on = h === href || (href === '#/avisos' && /^#\/avisos\/\d/.test(h)) || (href === '#/pagos' && h.startsWith('#/pagos/'));
          return `<a class="tab" href="${href}" aria-selected="${on}">${label}</a>`;
        })
        .join('');
    }
  }

  // ---------- Vistas sin sesión ----------
  function landingView() {
    const freeNote = META.freePosting ? '<p class="muted" style="text-align:center">¿Solo querés publicar un aviso puntual? <a href="/#/publicar">Publicá sin cuenta</a>.</p>' : '';
    view.innerHTML = `
      <section class="hero"><h1>Publicá en Maldonado Oportunidades</h1>
        <p>Creá tu cuenta gratis, cargá tus avisos y gestionalos desde tu propio panel. Pagás solo cuando publicás.</p></section>
      <div class="type-cards">
        ${META.accountTypes
          .map(
            (t) => `<div class="type-card"><div class="big">${t.icon}</div><h2>${esc(t.label)}</h2><p>${esc(t.pitch)}</p>
          <p style="font-size:.85rem">Secciones: ${t.categories.map((c) => esc(cat(c).label)).join(', ')}</p>
          <a class="btn btn-primary" href="#/registro?tipo=${t.id}">Crear cuenta de ${esc(t.label.toLowerCase())}</a></div>`,
          )
          .join('')}
      </div>
      <p style="text-align:center">¿Ya tenés cuenta? <a href="#/ingresar"><strong>Ingresá a tu panel</strong></a></p>
      ${freeNote}`;
  }

  function loginView(params) {
    view.innerHTML = `<form class="panel auth-box" id="login" novalidate>
      <h1>Ingresar a mi panel</h1>
      <div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="l-pw">Contraseña</label><input id="l-pw" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary" style="width:100%">Ingresar</button>
      <p style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:.92rem"><a href="#/olvide">Olvidé mi contraseña</a><a href="#/">Crear una cuenta</a></p>
    </form>`;
    $('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/account/login', { method: 'POST', json: Object.fromEntries(new FormData(e.target)) });
        USER = r.user;
        location.hash = params.next || '#/';
        route();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  function registerView(params) {
    const t = type(params.tipo) || META.accountTypes[0];
    view.innerHTML = `<form class="panel auth-box" id="register" novalidate>
      <h1>${t.icon} Cuenta de ${esc(t.label.toLowerCase())}</h1>
      <p class="muted" style="margin-top:0">${esc(t.pitch)}</p>
      <div class="field"><label>Tipo de cuenta</label><select name="type">${META.accountTypes.map((x) => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${x.icon} ${esc(x.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="r-name">Tu nombre *</label><input id="r-name" name="name" autocomplete="name" required></div>
      <div class="field"><label for="r-bn">${esc(t.businessLabel)}${t.id === 'empresa' ? ' *' : ''}</label><input id="r-bn" name="business_name" autocomplete="organization"></div>
      ${t.id === 'empresa' ? '<div class="field"><label for="r-rut">RUT <small>(opcional, para la factura)</small></label><input id="r-rut" name="rut" inputmode="numeric"></div>' : ''}
      <div class="field"><label for="r-phone">Teléfono / WhatsApp</label><input id="r-phone" name="phone" type="tel" autocomplete="tel"></div>
      <div class="field"><label for="r-email">Email *</label><input id="r-email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="r-pw">Contraseña * <small>(mínimo 8 caracteres)</small></label><input id="r-pw" name="password" type="password" autocomplete="new-password" required minlength="8"></div>
      <div class="field"><label class="check"><input type="checkbox" name="accept_terms" value="on"> Acepto las <a href="/#/terminos" target="_blank">condiciones de uso</a> y la <a href="/#/privacidad" target="_blank">política de privacidad</a>.</label></div>
      <button class="btn btn-primary" style="width:100%">Crear cuenta</button>
      <p style="text-align:center;font-size:.92rem">¿Ya tenés cuenta? <a href="#/ingresar">Ingresá</a></p>
    </form>`;
    const form = $('#register');
    form.elements.type.addEventListener('change', (e) => (location.hash = `#/registro?tipo=${e.target.value}`));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      try {
        const r = await api('/api/account/register', { method: 'POST', json: body });
        USER = r.user;
        toast('¡Cuenta creada! Ya podés cargar tu primer aviso.');
        location.hash = '#/avisos/nuevo';
      } catch (err) {
        toast(err.message);
        showErrors(form, err.fields);
      }
    });
  }

  function forgotView() {
    view.innerHTML = `<form class="panel auth-box" id="forgot" novalidate>
      <h1>Recuperar contraseña</h1>
      <p class="muted">Te enviamos un enlace por email para elegir una nueva.</p>
      <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" required></div>
      <button class="btn btn-primary" style="width:100%">Enviar enlace</button>
      <p style="text-align:center"><a href="#/ingresar">Volver</a></p></form>`;
    $('#forgot').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/account/forgot', { method: 'POST', json: { email: e.target.email.value } });
        view.innerHTML = '<div class="empty auth-box"><div class="big">📬</div><p>Si el email tiene una cuenta, te llegará un enlace en unos minutos.</p><a class="btn" href="#/ingresar">Volver</a></div>';
      } catch (err) {
        toast(err.message);
      }
    });
  }

  function resetView(params) {
    view.innerHTML = `<form class="panel auth-box" id="reset" novalidate>
      <h1>Nueva contraseña</h1>
      <div class="field"><label for="n-pw">Contraseña nueva <small>(mínimo 8 caracteres)</small></label><input id="n-pw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn btn-primary" style="width:100%">Guardar</button></form>`;
    $('#reset').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/account/reset', { method: 'POST', json: { token: params.token, password: e.target.password.value } });
        USER = r.user;
        toast('Contraseña actualizada');
        location.hash = '#/';
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // ---------- Resumen ----------
  async function dashboardView() {
    const [s, list] = await Promise.all([api('/api/account/stats'), api('/api/account/listings?pageSize=5')]);
    const t = type(USER.type);
    view.innerHTML = `
      <div class="section-head"><div><h1>${t.icon} Hola, ${esc(USER.name.split(' ')[0])}</h1><p class="muted">${esc(USER.business_name || t.panel)}${USER.verified ? ' · ✔️ Verificado' : ''}</p></div>
        <a class="btn btn-primary" href="#/avisos/nuevo">＋ Publicar aviso</a></div>
      ${s.unpaid ? `<div class="notice warn">Tenés ${s.unpaid} aviso(s) esperando el pago para publicarse. <a href="#/avisos?payment=unpaid">Pagar ahora →</a></div>` : ''}
      ${s.expiringSoon.length ? `<div class="notice warn">⏰ Por vencer: ${s.expiringSoon.map((l) => `<a href="#/avisos/${l.id}/pagar">${esc(l.title)}</a> (${fmtDate(l.expires_at)})`).join(', ')}. Renovalos para que sigan visibles.</div>` : ''}
      <div class="stats">
        <a class="stat" href="#/avisos"><b>${s.active}</b><span>Publicados</span></a>
        <a class="stat" href="#/avisos?payment=unpaid"><b>${s.unpaid}</b><span>Falta pagar</span></a>
        <a class="stat" href="#/avisos"><b>${s.pending}</b><span>En revisión</span></a>
        <div class="stat"><b>${s.views}</b><span>Visitas totales</span></div>
        <a class="stat" href="#/pagos"><b>${s.spent.length ? s.spent.map((x) => money(x.total, x.currency)).join(' + ') : '$ 0'}</b><span>Invertido</span></a>
      </div>
      <div class="section-head"><h2>Últimos avisos</h2><a href="#/avisos">Ver todos →</a></div>
      ${list.items.length ? `<div class="my-list">${list.items.map(itemHtml).join('')}</div>` : `<div class="empty"><div class="big">${t.icon}</div><p>Todavía no publicaste nada.</p><a class="btn btn-primary" href="#/avisos/nuevo">Crear mi primer aviso</a></div>`}`;
    bindItemActions();
  }

  // ---------- Mis avisos ----------
  function itemHtml(l) {
    const c = cat(l.category);
    const [st, label] = listingState(l);
    const canPay = st === 'unpaid' || st === 'expired' || (st === 'approved' && l.expires_at);
    return `<div class="my-item">
      ${l.image ? `<img src="${esc(l.image)}" alt="">` : `<div class="ph">${c.icon}</div>`}
      <div>
        <h3>${l.featured ? '★ ' : ''}${esc(l.title)}</h3>
        <div class="card-meta"><span class="badge badge-${st}">${label}</span><span>${esc(c.label)}</span>
          ${l.expires_at ? `<span>Vence ${fmtDate(l.expires_at.slice(0, 10))}</span>` : ''}<span>👁️ ${l.views}</span></div>
      </div>
      <div class="actions">
        ${canPay ? `<a class="btn btn-sm ${st === 'unpaid' || st === 'expired' ? 'btn-primary' : ''}" href="#/avisos/${l.id}/pagar">${st === 'unpaid' ? '💳 Pagar y publicar' : '🔁 Renovar'}</a>` : ''}
        <a class="btn btn-sm" href="#/avisos/${l.id}">✏️ Editar</a>
        ${st === 'approved' || st === 'paused' ? `<button class="btn btn-sm" data-pause="${l.id}" data-paused="${l.paused ? 1 : 0}">${l.paused ? '▶️ Reactivar' : '⏸ Pausar'}</button>` : ''}
        ${st === 'approved' ? `<a class="btn btn-sm" href="/#/aviso/${l.id}" target="_blank">↗ Ver</a>` : ''}
        <button class="btn btn-sm btn-danger" data-del="${l.id}" aria-label="Eliminar">🗑</button>
      </div>
    </div>`;
  }

  function bindItemActions() {
    $$('[data-pause]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/api/account/listings/${b.dataset.pause}/pause`, { method: 'POST', json: { paused: b.dataset.paused !== '1' } });
        toast(b.dataset.paused === '1' ? 'Aviso reactivado' : 'Aviso pausado: no se muestra en el sitio');
        route();
      }),
    );
    $$('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este aviso? Si tenía días pagos, se pierden.')) return;
        await api(`/api/account/listings/${b.dataset.del}`, { method: 'DELETE' });
        toast('Aviso eliminado');
        route();
      }),
    );
  }

  async function listView(params) {
    const q = new URLSearchParams({ pageSize: '20', ...params });
    const data = await api(`/api/account/listings?${q}`);
    const t = type(USER.type);
    const go = (patch) => (location.hash = `#/avisos?${new URLSearchParams(Object.fromEntries(Object.entries({ ...params, page: '', ...patch }).filter(([, v]) => v)))}`);
    view.innerHTML = `
      <div class="section-head"><h1>📋 Mis avisos</h1><a class="btn btn-primary btn-sm" href="#/avisos/nuevo">＋ Nuevo</a></div>
      <form class="search-bar" id="mine-search"><div class="search-input"><input name="q" type="search" placeholder="Buscar en mis avisos…" value="${esc(params.q || '')}"></div>
        <select name="filter" style="width:auto">${[
          ['', 'Todos'],
          ['unpaid', 'Falta pagar'],
          ['approved', 'Publicados'],
          ['pending', 'En revisión'],
          ['rejected', 'Rechazados'],
          ['expired', 'Vencidos'],
        ]
          .map(([v, l]) => `<option value="${v}" ${(params.payment === 'unpaid' ? 'unpaid' : params.expired ? 'expired' : params.status || '') === v ? 'selected' : ''}>${l}</option>`)
          .join('')}</select></form>
      <p class="muted">${data.total} aviso(s)</p>
      ${data.items.length ? `<div class="my-list">${data.items.map(itemHtml).join('')}</div>` : `<div class="empty"><div class="big">${t.icon}</div><p>No hay avisos.</p><a class="btn btn-primary" href="#/avisos/nuevo">Crear aviso</a></div>`}
      ${data.pages > 1 ? `<nav class="pagination">${data.page > 1 ? `<button class="btn" data-page="${data.page - 1}">‹</button>` : ''}<span class="muted">Página ${data.page} de ${data.pages}</span>${data.page < data.pages ? `<button class="btn" data-page="${data.page + 1}">›</button>` : ''}</nav>` : ''}`;
    const form = $('#mine-search');
    const apply = () => {
      const f = form.filter.value;
      go({ q: form.q.value.trim(), status: ['approved', 'pending', 'rejected'].includes(f) ? f : '', payment: f === 'unpaid' ? 'unpaid' : '', expired: f === 'expired' ? '1' : '' });
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      apply();
    });
    form.filter.addEventListener('change', apply);
    $$('[data-page]').forEach((b) => b.addEventListener('click', () => go({ page: b.dataset.page })));
    bindItemActions();
  }

  // ---------- Alta / edición ----------
  async function editView(id) {
    const isNew = id === 'nuevo';
    const t = type(USER.type);
    const l = isNew
      ? { category: t.categories[0], currency: 'UYU', contact_name: USER.name, contact_phone: USER.phone, contact_email: USER.email, website: USER.website, company: USER.business_name, subtype: USER.type === 'servicios' ? 'Servicios' : '' }
      : await api(`/api/account/listings/${id}`);
    const cats = t.categories.map(cat);
    view.innerHTML = `
      <div class="form-page">
        <h1>${isNew ? '＋ Nuevo aviso' : '✏️ Editar aviso'}</h1>
        ${isNew ? '<div class="steps-note"><strong>Paso 1 de 2:</strong> cargá los datos del aviso. En el paso 2 elegís el plan y pagás para publicarlo.</div>' : ''}
        ${!isNew && l.status === 'rejected' ? '<div class="notice warn">Este aviso fue rechazado. Corregilo y guardalo para que lo volvamos a revisar.</div>' : ''}
        <form id="edit" class="panel" novalidate>
          <div class="field"><label>Sección *</label>
            <div class="cat-picker">${cats.map((c) => `<label class="cat-option"><input type="radio" name="category" value="${c.id}" ${c.id === l.category ? 'checked' : ''}><span>${c.icon} ${esc(c.label)}</span></label>`).join('')}</div></div>
          <div class="field"><label for="e-title">Título *</label><input id="e-title" name="title" maxlength="140" value="${esc(l.title || '')}"></div>
          <div class="row-2">
            <div class="field"><label for="e-sub">Tipo</label><select id="e-sub" name="subtype"></select></div>
            <div class="field"><label for="e-loc">Ubicación</label><select id="e-loc" name="location"></select></div>
          </div>
          <div class="field"><label for="e-company">${USER.type === 'alquileres' ? 'Inmobiliaria' : 'Empresa / nombre comercial'}</label><input id="e-company" name="company" maxlength="120" value="${esc(l.company || '')}"></div>
          <div class="field"><label for="e-desc">Descripción *</label><textarea id="e-desc" name="description" maxlength="6000">${esc(l.description || '')}</textarea></div>
          <div class="row-2" id="price-row">
            <div class="field"><label for="e-price" id="price-label">Precio</label><input id="e-price" name="price" inputmode="decimal" value="${l.price ?? ''}"></div>
            <div class="field"><label for="e-cur">Moneda</label><select id="e-cur" name="currency"><option value="UYU" ${l.currency !== 'USD' ? 'selected' : ''}>Pesos ($)</option><option value="USD" ${l.currency === 'USD' ? 'selected' : ''}>Dólares (US$)</option></select></div>
          </div>
          <div class="field" id="event-field" hidden><label for="e-date">Fecha del evento *</label><input id="e-date" type="date" name="event_date" value="${esc((l.event_date || '').slice(0, 10))}"></div>
          <div class="field"><label for="e-img">Foto <small>(máx. 5 MB)</small></label>
            ${l.image ? `<img src="${esc(l.image)}" class="img-preview" id="cur-img" alt="">` : '<img class="img-preview" id="cur-img" alt="" hidden>'}
            <input id="e-img" type="file" name="imageFile" accept="image/jpeg,image/png,image/webp,image/gif"></div>
          <h2>Contacto</h2>
          <div class="field"><label for="e-cn">Nombre</label><input id="e-cn" name="contact_name" value="${esc(l.contact_name || '')}"></div>
          <div class="row-2">
            <div class="field"><label for="e-ph">Teléfono / WhatsApp</label><input id="e-ph" name="contact_phone" type="tel" value="${esc(l.contact_phone || '')}"></div>
            <div class="field"><label for="e-em">Email</label><input id="e-em" name="contact_email" type="email" value="${esc(l.contact_email || '')}"></div>
          </div>
          <div class="field"><label for="e-web">Sitio web</label><input id="e-web" name="website" value="${esc(l.website || '')}"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit" style="flex:1">${isNew ? 'Continuar al pago →' : 'Guardar cambios'}</button>
            <a class="btn" href="#/avisos">Cancelar</a>
          </div>
        </form>
      </div>`;

    const form = $('#edit');
    const sync = () => {
      const c = cat(form.querySelector('input[name="category"]:checked').value);
      const fill = (sel, list, cur) => {
        const all = cur && !list.includes(cur) ? [cur, ...list] : list;
        sel.innerHTML = `<option value="">—</option>${all.map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
      };
      fill($('#e-sub'), c.subtypes || [], $('#e-sub').value || l.subtype);
      fill($('#e-loc'), c.locations || [], $('#e-loc').value || l.location);
      $('#price-row').hidden = !c.hasPrice;
      $('#price-label').textContent = c.priceLabel || 'Precio';
      $('#event-field').hidden = !c.hasEventDate;
    };
    $$('input[name="category"]', form).forEach((r) => r.addEventListener('change', () => {
      $('#e-sub').value = '';
      $('#e-loc').value = '';
      sync();
    }));
    sync();
    $('#e-img').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f && f.size > 5 * 1024 * 1024) {
        toast('La imagen supera los 5 MB');
        e.target.value = '';
        return;
      }
      if (f) {
        $('#cur-img').src = URL.createObjectURL(f);
        $('#cur-img').hidden = false;
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      if (!form.imageFile.files.length) fd.delete('imageFile');
      const btn = $('button[type="submit"]', form);
      btn.disabled = true;
      try {
        const saved = await api(isNew ? '/api/account/listings' : `/api/account/listings/${l.id}`, { method: isNew ? 'POST' : 'PUT', body: fd });
        if (isNew || saved.payment_status === 'unpaid') location.hash = `#/avisos/${saved.id}/pagar`;
        else {
          toast('Cambios guardados');
          location.hash = '#/avisos';
        }
      } catch (err) {
        toast(err.message);
        showErrors(form, err.fields);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- Pago ----------
  async function payView(id) {
    const [l, p] = await Promise.all([api(`/api/account/listings/${id}`), api('/api/account/plans')]);
    const [st] = listingState(l);
    if (!p.plans.length) {
      view.innerHTML = '<div class="empty" style="margin:20px 0"><p>No hay planes disponibles en este momento. Contactanos.</p></div>';
      return;
    }
    const allFree = p.plans.every((x) => Number(x.price) === 0);
    view.innerHTML = `
      <div class="form-page">
        <h1>${st === 'unpaid' ? '💳 Elegí tu plan y publicá' : '🔁 Renovar aviso'}</h1>
        ${st === 'unpaid' ? '<div class="steps-note"><strong>Paso 2 de 2:</strong> elegí el plan y el medio de pago. Tu aviso se publica apenas se confirma el pago.</div>' : `<div class="steps-note">Los días que compres se suman a partir del ${l.expires_at && l.expires_at.slice(0, 10) >= today() ? `vencimiento actual (${fmtDate(l.expires_at.slice(0, 10))})` : 'día de hoy'}.</div>`}
        <div class="panel" style="margin-bottom:14px"><strong>${esc(l.title)}</strong><div class="muted">${esc(cat(l.category).label)}</div></div>
        <form id="pay" novalidate>
          <div class="plans">${p.plans
            .map(
              (x, i) => `<label class="plan"><input type="radio" name="plan_id" value="${x.id}" ${i === 0 ? 'checked' : ''}><span>
              <strong>${x.featured ? '★ ' : ''}${esc(x.name)}</strong>
              <span class="amount">${money(x.price, x.currency)}</span>
              <span class="muted">${esc(x.description)}</span>
              <span class="muted" style="font-size:.85rem">${x.duration_days} días de publicación</span></span></label>`,
            )
            .join('')}</div>
          ${allFree ? '' : `<h2 style="margin-top:18px">Medio de pago</h2>
          <div class="methods">${p.methods.length ? p.methods.map((m, i) => `<label class="method"><input type="radio" name="method" value="${m}" ${i === 0 ? 'checked' : ''}> ${METHOD_LABEL[m]}</label>`).join('') : '<div class="notice warn">No hay medios de pago configurados todavía. Contactanos.</div>'}</div>`}
          <button class="btn btn-primary" style="width:100%" ${!allFree && !p.methods.length ? 'disabled' : ''}>Continuar</button>
        </form>
        <p class="muted" style="font-size:.85rem;text-align:center">Los pagos con tarjeta se procesan en el sitio seguro de Mercado Pago. No guardamos datos de tarjetas.</p>
      </div>`;
    $('#pay').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = $('button', e.target);
      btn.disabled = true;
      btn.textContent = 'Procesando…';
      try {
        const pay = await api(`/api/account/listings/${l.id}/checkout`, { method: 'POST', json: { plan_id: Number(fd.get('plan_id')), method: fd.get('method') } });
        if (pay.method === 'mercadopago' && pay.checkout_url) {
          location.href = pay.checkout_url;
          return;
        }
        location.hash = `#/pagos/${pay.id}`;
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = 'Continuar';
      }
    });
  }

  async function paymentsView() {
    const rows = await api('/api/account/payments');
    view.innerHTML = `<h1>💳 Mis pagos</h1>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Detalle</th><th>Monto</th><th>Medio</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>
      ${rows
        .map(
          (p) => `<tr><td><a href="#/pagos/${p.id}">${p.id}</a></td><td>${esc(p.description)}</td><td style="white-space:nowrap">${money(p.amount, p.currency)}</td>
          <td>${esc((METHOD_LABEL[p.method] || p.method).split(' (')[0])}</td><td><span class="badge ${PAY_BADGE[p.status]}">${PAY_STATUS[p.status]}</span></td><td style="white-space:nowrap">${fmtDate(p.created_at)}</td></tr>`,
        )
        .join('')}</tbody></table></div>` : '<div class="empty"><p>Todavía no hiciste pagos.</p></div>'}`;
  }

  async function paymentView(id, attempt = 0) {
    const p = await api(`/api/account/payments/${id}`);
    const { parts } = parseHash();
    if (parts[0] !== 'pagos' || parts[1] !== String(id)) return; // el usuario navegó a otra vista
    let body = '';
    if (p.status === 'approved') {
      body = `<div class="big">✅</div><h1>¡Pago confirmado!</h1>
        <p>${p.listing ? (p.listing.status === 'approved' ? `Tu aviso está publicado hasta el ${fmtDate((p.listing.expires_at || '').slice(0, 10))}.` : 'Tu aviso quedó en revisión y se publicará en breve.') : ''}</p>
        <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${p.listing && p.listing.status === 'approved' ? `<a class="btn btn-primary" href="/#/aviso/${p.listing.id}" target="_blank">Ver mi aviso</a>` : ''}<a class="btn" href="#/avisos">Mis avisos</a></p>`;
    } else if (p.status === 'pending' && p.method === 'transfer') {
      body = `<div class="big">🏦</div><h1>Pago por transferencia #${p.id}</h1>
        <p>Transferí <strong>${money(p.amount, p.currency)}</strong> a la siguiente cuenta, indicando la referencia <strong>#${p.id}</strong>:</p>
        <div class="transfer-box" style="text-align:left">${esc(p.transferInfo || '')}</div>
        <p class="muted">Cuando confirmemos la transferencia, tu aviso se publica automáticamente y te avisamos por email.</p>
        <p><button class="btn btn-danger btn-sm" id="cancel-pay">Cancelar este pago</button> <a class="btn btn-sm" href="#/avisos">Mis avisos</a></p>`;
    } else if (p.status === 'pending') {
      body = `<div class="big">⏳</div><h1>Esperando la confirmación del pago</h1>
        <p>Si ya pagaste en Mercado Pago, en unos segundos se actualiza. Si pagaste en Abitab o Redpagos puede demorar unas horas.</p>
        <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${p.checkout_url ? `<a class="btn btn-primary" href="${esc(p.checkout_url)}">Ir a pagar</a>` : ''}<button class="btn" id="refresh">Actualizar</button><a class="btn" href="#/avisos">Mis avisos</a></p>`;
    } else {
      body = `<div class="big">⚠️</div><h1>Pago ${PAY_STATUS[p.status].toLowerCase()}</h1><p>${esc(p.note || 'El pago no se completó.')}</p>
        ${p.listing ? `<a class="btn btn-primary" href="#/avisos/${p.listing.id}/pagar">Intentar de nuevo</a>` : ''}`;
    }
    view.innerHTML = `<div class="form-page"><div class="empty">${body}</div></div>`;
    const cancel = $('#cancel-pay');
    if (cancel)
      cancel.addEventListener('click', async () => {
        if (!confirm('¿Cancelar este pago?')) return;
        await api(`/api/account/payments/${p.id}/cancel`, { method: 'POST' });
        route();
      });
    const refresh = $('#refresh');
    if (refresh) refresh.addEventListener('click', () => paymentView(id));
    // Al volver de Mercado Pago, se consulta el estado unas veces automáticamente.
    if (p.status === 'pending' && p.method === 'mercadopago' && attempt < 6) setTimeout(() => paymentView(id, attempt + 1), 5000);
  }

  // ---------- Perfil ----------
  function profileView() {
    const t = type(USER.type);
    const allLoc = [...new Set([...META.localities, ...META.departments])];
    view.innerHTML = `
      <div class="form-page">
        <h1>👤 Perfil</h1>
        <p class="muted">Cuenta de ${esc(t.label.toLowerCase())} · ${esc(USER.email)} · <a href="/#/anunciante/${USER.id}" target="_blank">Ver mi página pública ↗</a></p>
        <form id="profile" class="panel" novalidate>
          <div class="field"><label>Nombre</label><input name="name" value="${esc(USER.name)}"></div>
          <div class="field"><label>${esc(t.businessLabel)}</label><input name="business_name" value="${esc(USER.business_name)}"></div>
          ${USER.type === 'empresa' ? `<div class="field"><label>RUT</label><input name="rut" value="${esc(USER.rut)}"></div>` : ''}
          <div class="row-2">
            <div class="field"><label>Teléfono</label><input name="phone" value="${esc(USER.phone)}"></div>
            <div class="field"><label>Zona</label><select name="location"><option value="">—</option>${allLoc.map((x) => `<option ${x === USER.location ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Sitio web</label><input name="website" value="${esc(USER.website)}"></div>
          <div class="field"><label>Sobre ${USER.type === 'empresa' ? 'la empresa' : 'vos'} <small>(se muestra en tu página pública)</small></label><textarea name="about" rows="4">${esc(USER.about)}</textarea></div>
          <button class="btn btn-primary" style="width:100%">Guardar perfil</button>
        </form>
        <form id="password" class="panel" style="margin-top:16px" novalidate>
          <h2>Cambiar contraseña</h2>
          <div class="field"><label>Contraseña actual</label><input name="current" type="password" autocomplete="current-password"></div>
          <div class="field"><label>Contraseña nueva</label><input name="password" type="password" autocomplete="new-password"></div>
          <button class="btn" style="width:100%">Cambiar contraseña</button>
        </form>
        <p style="text-align:center;margin-top:20px"><button class="btn btn-danger" id="logout">Cerrar sesión</button></p>
      </div>`;
    $('#profile').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/account/me', { method: 'PUT', json: Object.fromEntries(new FormData(e.target)) });
        USER = r.user;
        toast('Perfil guardado');
      } catch (err) {
        toast(err.message);
        showErrors(e.target, err.fields);
      }
    });
    $('#password').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/account/password', { method: 'PUT', json: Object.fromEntries(new FormData(e.target)) });
        e.target.reset();
        toast('Contraseña actualizada');
      } catch (err) {
        toast(err.message);
        showErrors(e.target, err.fields);
      }
    });
    $('#logout').addEventListener('click', async () => {
      await api('/api/account/logout', { method: 'POST' });
      USER = null;
      location.hash = '#/';
      route();
    });
  }

  // ---------- Router ----------
  async function route() {
    const { parts, params } = parseHash();
    const [a, b, c] = parts;
    renderChrome();
    try {
      if (!USER) {
        if (a === 'registro') return registerView(params);
        if (a === 'ingresar') return loginView(params);
        if (a === 'olvide') return forgotView();
        if (a === 'restablecer') return resetView(params);
        if (a && a !== '') return loginView({ next: location.hash });
        return landingView();
      }
      if (!a) await dashboardView();
      else if (a === 'avisos' && b && c === 'pagar') await payView(b);
      else if (a === 'avisos' && b) await editView(b);
      else if (a === 'avisos') await listView(params);
      else if (a === 'pagos' && b) await paymentView(b);
      else if (a === 'pagos') await paymentsView();
      else if (a === 'perfil') profileView();
      else if (['registro', 'ingresar'].includes(a)) location.hash = '#/';
      else location.hash = '#/';
    } catch (err) {
      if (err.status !== 401) view.innerHTML = `<div class="empty" style="margin:20px 0">${esc(err.message)}</div>`;
    }
  }

  window.addEventListener('hashchange', () => {
    route();
    window.scrollTo(0, 0);
  });

  (async function init() {
    try {
      const [meta, me] = await Promise.all([api('/api/meta'), api('/api/account/me')]);
      META = meta;
      USER = me.user;
    } catch {
      view.innerHTML = '<div class="empty" style="margin:20px 0">No se pudo conectar con el servidor.</div>';
      return;
    }
    route();
  })();
})();
