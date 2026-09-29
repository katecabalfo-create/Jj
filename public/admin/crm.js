/* Maldonado Oportunidades — CRM de anunciantes (contactos, segmentos y campañas de email) */
(() => {
  'use strict';

  const X = () => window.MO_ADMIN; // utilidades del panel (api, esc, toast, etc.)
  let META = null;

  async function meta(force = false) {
    if (!META || force) META = await X().api('/api/admin/crm/meta');
    return META;
  }

  const SEG_KEYS = ['q', 'type', 'activity', 'tag', 'inactive_days', 'created_days', 'opt_in'];
  const pickSeg = (obj) => Object.fromEntries(SEG_KEYS.filter((k) => obj[k]).map((k) => [k, obj[k]]));

  function tabs(active) {
    const t = (href, label, id) => `<a class="btn btn-sm ${active === id ? 'btn-primary' : ''}" href="${href}">${label}</a>`;
    return `<div class="crm-tabs">${t('#/crm', '👥 Contactos', 'contacts')}${t('#/crm/campanas', '✉️ Campañas', 'campaigns')}${t('#/crm/campanas/nueva', '＋ Nueva campaña', 'new')}</div>`;
  }

  function segmentFields(seg, m, { withSearch = true, withOptIn = true } = {}) {
    const { esc, opt } = X();
    return `
      ${withSearch ? `<input class="full" name="q" type="search" placeholder="Nombre, empresa, email o teléfono" value="${esc(seg.q || '')}">` : ''}
      <select name="type" aria-label="Tipo de cuenta">${opt('', 'Todos los tipos')}${Object.entries(X().TYPES).map(([k, v]) => opt(k, v, seg.type)).join('')}</select>
      <select name="activity" aria-label="Actividad">${opt('', 'Cualquier actividad')}${Object.entries(m.activities).map(([k, v]) => opt(k, v, seg.activity)).join('')}</select>
      <select name="tag" aria-label="Etiqueta">${opt('', 'Cualquier etiqueta')}${m.tags.map((t) => opt(t, `🏷️ ${t}`, seg.tag)).join('')}</select>
      <select name="inactive_days" aria-label="Sin entrar">${opt('', 'Último ingreso: cualquiera')}${[['30', 'Sin entrar hace 30 días'], ['60', 'Sin entrar hace 60 días'], ['90', 'Sin entrar hace 90 días'], ['180', 'Sin entrar hace 6 meses']].map(([v, l]) => opt(v, l, seg.inactive_days)).join('')}</select>
      <select name="created_days" aria-label="Alta">${opt('', 'Alta: cualquier fecha')}${[['7', 'Alta en los últimos 7 días'], ['30', 'Alta en los últimos 30 días'], ['90', 'Alta en los últimos 90 días']].map(([v, l]) => opt(v, l, seg.created_days)).join('')}</select>
      ${withOptIn ? `<select name="opt_in" aria-label="Promociones">${opt('', 'Promociones: todos')}${opt('1', 'Aceptan promociones', seg.opt_in)}${opt('0', 'No aceptan promociones', seg.opt_in)}</select>` : ''}`;
  }

  // ---------- Contactos ----------
  async function contactsView(params) {
    const { api, esc, fmtDate, money, hashFor, $, TYPES } = X();
    const [m, data] = await Promise.all([meta(true), api(`/api/admin/crm/contacts?${new URLSearchParams(pickSeg(params))}`)]);
    const seg = pickSeg(params);
    const view = $('#view');
    view.innerHTML = `
      <div class="section-head"><div><h1>📇 CRM de anunciantes</h1>
        <p class="muted">${m.totals.n} anunciantes · ${m.totals.reachable} aceptan recibir promociones</p></div>${tabs('contacts')}</div>
      <form class="admin-filters crm-filters" id="cf">${segmentFields(seg, m)}<button class="btn btn-primary">Filtrar</button></form>
      <div class="bulk">
        <span class="muted"><strong>${data.total}</strong> contacto(s) · <strong>${data.reachable}</strong> reciben promociones</span>
        <a class="btn btn-sm btn-primary" href="${hashFor('/crm/campanas/nueva', { ...seg, opt_in: '' })}">✉️ Enviar campaña a este grupo</a>
        <a class="btn btn-sm" href="/api/admin/crm/contacts.csv?${new URLSearchParams(seg)}">⬇️ Exportar CSV</a>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Contacto</th><th>Tipo</th><th>Avisos</th><th>Pagado</th><th>Último pago</th><th>Promociones</th><th>Etiquetas</th></tr></thead>
        <tbody>${
          data.items.length
            ? data.items
                .map(
                  (c) => `<tr>
            <td class="title-cell"><a href="#/crm/contacto/${c.id}">${esc(c.business_name || c.name)}</a>${c.active ? '' : ' <span class="badge badge-rejected">Suspendido</span>'}
              <div class="muted" style="font-size:.82rem">${esc(c.name)} · ${esc(c.email)}${c.phone ? ` · ${esc(c.phone)}` : ''}</div></td>
            <td style="white-space:nowrap">${TYPES[c.type]}</td>
            <td><strong>${c.active_listings}</strong> <span class="muted">de ${c.total_listings}</span></td>
            <td style="white-space:nowrap">${money(c.paid_total, 'UYU')}</td>
            <td style="white-space:nowrap">${c.last_paid_at ? fmtDate(c.last_paid_at) : '—'}</td>
            <td>${c.marketing_opt_in ? '<span class="badge badge-approved">Sí</span>' : '<span class="badge">No</span>'}</td>
            <td>${c.tags.map((t) => `<a class="chip" href="#/crm?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ')}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">No hay anunciantes con esos filtros.</td></tr>'
        }</tbody></table></div>`;
    $('#cf').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = hashFor('/crm', Object.fromEntries(new FormData(e.target)));
    });
  }

  // ---------- Ficha de un contacto ----------
  async function contactView(id) {
    const { api, esc, fmtDate, money, toast, $, $$, TYPES } = X();
    const [m, c] = await Promise.all([meta(), api(`/api/admin/crm/contacts/${id}`)]);
    const STATUS = { pending: 'Pendiente', approved: 'Publicado', rejected: 'Rechazado' };
    const view = $('#view');
    view.innerHTML = `
      <p class="breadcrumb"><a href="#/crm">CRM</a> › Contacto</p>
      <div class="section-head"><div><h1>${esc(c.business_name || c.name)}</h1>
        <p class="muted">${TYPES[c.type]} · alta ${fmtDate(c.created_at)} · último ingreso ${c.last_login_at ? fmtDate(c.last_login_at) : 'nunca'}</p></div>
        <a class="btn btn-sm btn-primary" href="#/crm/campanas/nueva?q=${encodeURIComponent(c.email)}">✉️ Enviarle una campaña</a></div>
      <div class="crm-grid">
        <section class="panel">
          <h2>Datos</h2>
          <dl class="facts">
            <dt>Nombre</dt><dd>${esc(c.name)}</dd>
            <dt>Email</dt><dd>${esc(c.email)}</dd>
            ${c.phone ? `<dt>Teléfono</dt><dd>${esc(c.phone)}</dd>` : ''}
            ${c.rut ? `<dt>RUT</dt><dd>${esc(c.rut)}</dd>` : ''}
            ${c.location ? `<dt>Zona</dt><dd>${esc(c.location)}</dd>` : ''}
            <dt>Avisos</dt><dd>${c.active_listings} publicados de ${c.total_listings}</dd>
            <dt>Pagado</dt><dd>${money(c.paid_total, 'UYU')}</dd>
          </dl>
          <label class="check" style="margin-top:12px"><input type="checkbox" id="optin" ${c.marketing_opt_in ? 'checked' : ''}> Acepta recibir promociones por email</label>
          <h2 style="margin-top:18px">Etiquetas</h2>
          <div class="chips" id="tags"></div>
          <form id="tag-form" style="display:flex;gap:6px;margin-top:8px">
            <input name="tag" list="tag-list" placeholder="Ej.: inmobiliaria, cliente VIP, temporada" maxlength="40" aria-label="Nueva etiqueta">
            <datalist id="tag-list">${m.tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
            <button class="btn btn-sm">Agregar</button></form>
        </section>
        <section class="panel">
          <h2>Notas internas</h2>
          <form id="note-form"><textarea name="body" rows="3" placeholder="Ej.: Llamé el 12/10, le interesa el plan destacado para diciembre." aria-label="Nueva nota"></textarea>
            <button class="btn btn-sm btn-primary" style="margin-top:6px">Guardar nota</button></form>
          <div id="notes" class="crm-notes"></div>
        </section>
      </div>
      <h2>Avisos</h2>
      <div class="table-wrap" style="margin-bottom:16px"><table><thead><tr><th>Aviso</th><th>Estado</th><th>Vence</th><th>Visitas</th></tr></thead><tbody>
        ${c.listings.length ? c.listings.map((l) => `<tr><td><a href="#/avisos/${l.id}">${esc(l.title)}</a></td><td>${l.payment_status === 'unpaid' ? 'Sin pagar' : l.paused ? 'Pausado' : STATUS[l.status]}</td><td>${l.expires_at ? fmtDate(l.expires_at) : '—'}</td><td>${l.views}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Sin avisos.</td></tr>'}
      </tbody></table></div>
      <h2>Pagos</h2>
      <div class="table-wrap" style="margin-bottom:16px"><table><thead><tr><th>#</th><th>Detalle</th><th>Monto</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>
        ${c.payments.length ? c.payments.map((p) => `<tr><td>${p.id}</td><td>${esc(p.description)}</td><td>${money(p.amount, p.currency)}</td><td>${p.status === 'approved' ? 'Aprobado' : p.status === 'pending' ? 'Pendiente' : p.status === 'rejected' ? 'Rechazado' : 'Cancelado'}</td><td>${fmtDate(p.paid_at || p.created_at)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Sin pagos.</td></tr>'}
      </tbody></table></div>
      <h2>Campañas recibidas</h2>
      <div class="table-wrap"><table><thead><tr><th>Campaña</th><th>Enviada</th><th>Abierta</th></tr></thead><tbody>
        ${c.campaigns.length ? c.campaigns.map((k) => `<tr><td><a href="#/crm/campanas/${k.id}">${esc(k.subject)}</a></td><td>${fmtDate(k.sent_at)}</td><td>${k.opened_at ? `✅ ${fmtDate(k.opened_at)}` : '—'}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">Todavía no recibió campañas.</td></tr>'}
      </tbody></table></div>`;

    let tags = c.tags.slice();
    const saveTags = async () => {
      await api(`/api/admin/crm/contacts/${id}`, { method: 'PUT', json: { tags } });
      meta(true);
    };
    const renderTags = () => {
      $('#tags').innerHTML = tags.length
        ? tags.map((t, i) => `<button type="button" class="chip" data-i="${i}" aria-label="Quitar etiqueta ${esc(t)}">${esc(t)} ✕</button>`).join('')
        : '<span class="muted">Sin etiquetas.</span>';
      $$('#tags [data-i]').forEach((b) =>
        b.addEventListener('click', async () => {
          tags.splice(Number(b.dataset.i), 1);
          renderTags();
          await saveTags();
        }),
      );
    };
    renderTags();
    $('#tag-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = e.target.tag.value.trim();
      if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
      tags.push(t);
      e.target.reset();
      renderTags();
      await saveTags();
      toast('Etiqueta agregada');
    });
    $('#optin').addEventListener('change', async (e) => {
      await api(`/api/admin/crm/contacts/${id}`, { method: 'PUT', json: { marketing_opt_in: e.target.checked } });
      toast(e.target.checked ? 'Va a recibir promociones' : 'No va a recibir promociones');
    });

    let notes = c.notes;
    const renderNotes = () => {
      $('#notes').innerHTML = notes.length
        ? notes.map((n) => `<div class="crm-note"><div>${esc(n.body).replace(/\n/g, '<br>')}</div><small class="muted">${fmtDate(n.created_at)} · <button type="button" class="linkish" data-del="${n.id}">Borrar</button></small></div>`).join('')
        : '<p class="muted">Sin notas.</p>';
      $$('#notes [data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/admin/crm/notes/${b.dataset.del}`, { method: 'DELETE' });
          notes = notes.filter((n) => String(n.id) !== b.dataset.del);
          renderNotes();
        }),
      );
    };
    renderNotes();
    $('#note-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const n = await api(`/api/admin/crm/contacts/${id}/notes`, { method: 'POST', json: { body: e.target.body.value } });
        notes.unshift(n);
        e.target.reset();
        renderNotes();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // ---------- Campañas ----------
  async function campaignsView() {
    const { api, esc, fmtDate, $ } = X();
    const list = await api('/api/admin/crm/campaigns');
    $('#view').innerHTML = `
      <div class="section-head"><h1>✉️ Campañas de email</h1>${tabs('campaigns')}</div>
      <p class="muted">Los emails se envían de a tandas cada pocos minutos. Solo reciben promociones los anunciantes activos que las aceptan, y cada email incluye el enlace para darse de baja.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Campaña</th><th>Estado</th><th>Destinatarios</th><th>Entregados</th><th>Abiertos</th><th>Fecha</th></tr></thead>
        <tbody>${
          list.length
            ? list
                .map((c) => {
                  const rate = c.recipients ? Math.round((c.opens / c.recipients) * 100) : 0;
                  return `<tr><td class="title-cell"><a href="#/crm/campanas/${c.id}">${esc(c.subject)}</a></td>
                    <td>${c.status === 'sent' ? '<span class="badge badge-approved">Enviada</span>' : '<span class="badge badge-pending">Borrador</span>'}</td>
                    <td>${c.status === 'sent' ? c.recipients : '—'}</td>
                    <td>${c.status === 'sent' ? `${c.delivered}${c.queued ? ` <span class="muted">(+${c.queued} en cola)</span>` : ''}${c.failed ? ` <span class="badge badge-rejected">${c.failed} con error</span>` : ''}` : '—'}</td>
                    <td>${c.status === 'sent' ? `${c.opens} <span class="muted">(${rate}%)</span>` : '—'}</td>
                    <td style="white-space:nowrap">${fmtDate(c.sent_at || c.created_at)}</td></tr>`;
                })
                .join('')
            : '<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">Todavía no hay campañas. <a href="#/crm/campanas/nueva">Crear la primera</a></td></tr>'
        }</tbody></table></div>`;
  }

  async function campaignEditView(id, params) {
    const { api, esc, opt, toast, $, $$ } = X();
    const m = await meta(true);
    const isNew = id === 'nueva';
    const c = isNew ? { subject: '', body: 'Hola {nombre}:\n\n', cta_text: '', cta_url: '', segment: pickSeg(params), status: 'draft' } : await api(`/api/admin/crm/campaigns/${id}`);
    const sent = c.status === 'sent';
    const dis = sent ? 'disabled' : '';
    $('#view').innerHTML = `
      <p class="breadcrumb"><a href="#/crm/campanas">Campañas</a> › ${isNew ? 'Nueva' : esc(c.subject)}</p>
      <div class="section-head"><h1>${isNew ? '＋ Nueva campaña' : sent ? '✉️ Campaña enviada' : '✏️ Borrador'}</h1>${tabs(isNew ? 'new' : 'campaigns')}</div>
      ${sent ? `<div class="alert">Enviada el ${X().fmtDate(c.sent_at)} a ${c.recipients} anunciantes. No se puede modificar.</div>` : ''}
      <div class="crm-grid crm-editor">
        <form id="camp" class="panel" novalidate>
          ${isNew ? `<div class="field"><label for="tpl">Empezar desde una plantilla</label><select id="tpl">${opt('', 'Elegí una plantilla…')}${m.templates.map((t) => opt(t.id, t.name)).join('')}</select></div>` : ''}
          <div class="field"><label for="c-subject">Asunto</label><input id="c-subject" name="subject" maxlength="150" value="${esc(c.subject)}" ${dis}></div>
          <div class="field"><label for="c-body">Mensaje</label><textarea id="c-body" name="body" rows="10" ${dis}>${esc(c.body)}</textarea>
            <small>Podés usar <code>{nombre}</code>, <code>{empresa}</code>, <code>{panel}</code> (enlace a su panel) y <code>{publicar}</code> (enlace para publicar). Separá los párrafos con una línea en blanco. <code>**texto**</code> se ve en negrita.</small></div>
          <div class="row-2">
            <div class="field"><label for="c-cta">Texto del botón <small>(opcional)</small></label><input id="c-cta" name="cta_text" maxlength="60" value="${esc(c.cta_text)}" placeholder="Ej.: Destacar mi aviso" ${dis}></div>
            <div class="field"><label for="c-url">Enlace del botón</label><input id="c-url" name="cta_url" value="${esc(c.cta_url)}" placeholder="https://… o {panel}" ${dis}></div>
          </div>
          <fieldset ${dis}><legend>¿A quién se envía?</legend>
            <div class="admin-filters crm-seg">${segmentFields(c.segment || {}, m, { withOptIn: false })}</div>
            <p id="audience" class="muted" aria-live="polite">Calculando…</p>
          </fieldset>
          ${sent ? '' : `<div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn" id="save">💾 Guardar borrador</button>
            <button type="button" class="btn btn-primary" id="send">🚀 Enviar campaña</button>
            ${isNew ? '' : '<button type="button" class="btn btn-danger" id="del">🗑 Borrar</button>'}
          </div>
          <div class="field" style="margin-top:14px"><label for="test-to">Enviarme una prueba</label>
            <div style="display:flex;gap:6px"><input id="test-to" type="email" placeholder="tu@email.com"><button type="button" class="btn" id="test">Enviar prueba</button></div></div>`}
          <div id="send-confirm" class="alert" hidden></div>
        </form>
        <section class="panel crm-preview"><div class="section-head" style="margin:0 0 8px"><h2>Vista previa</h2><button type="button" class="btn btn-sm" id="refresh">Actualizar</button></div>
          <p class="muted" id="pv-subject" style="margin:0 0 8px"></p>
          <iframe id="pv" title="Vista previa del email" sandbox=""></iframe></section>
      </div>`;

    const form = $('#camp');
    const body = () => {
      const fd = new FormData(form);
      const seg = {};
      for (const k of SEG_KEYS) if (fd.get(k)) seg[k] = fd.get(k);
      return { subject: fd.get('subject') ?? c.subject, body: fd.get('body') ?? c.body, cta_text: fd.get('cta_text') ?? c.cta_text, cta_url: fd.get('cta_url') ?? c.cta_url, segment: sent ? c.segment : seg };
    };
    async function audience() {
      const r = await api('/api/admin/crm/audience', { method: 'POST', json: { segment: body().segment } });
      $('#audience').innerHTML = `Se envía a <strong>${r.count}</strong> anunciante${r.count === 1 ? '' : 's'} que acepta${r.count === 1 ? '' : 'n'} promociones${r.sample.length ? `: ${r.sample.map((s) => esc(s.business_name || s.name)).join(', ')}${r.count > r.sample.length ? '…' : ''}` : '.'}`;
      return r.count;
    }
    async function preview() {
      const r = await api('/api/admin/crm/preview', { method: 'POST', json: body() });
      $('#pv-subject').innerHTML = `Para: ${esc(r.to)} · Asunto: <strong>${esc(r.subject)}</strong>`;
      $('#pv').srcdoc = r.html;
    }
    let t = null;
    const refreshSoon = () => {
      clearTimeout(t);
      t = setTimeout(() => preview().catch(() => {}), 500);
    };
    form.addEventListener('input', refreshSoon);
    $$('.crm-seg select, .crm-seg input', form).forEach((el) => el.addEventListener('change', () => audience()));
    $('#refresh').addEventListener('click', () => preview());
    audience();
    preview();

    const tpl = $('#tpl');
    if (tpl)
      tpl.addEventListener('change', () => {
        const x = m.templates.find((k) => k.id === tpl.value);
        if (!x) return;
        form.subject.value = x.subject;
        form.body.value = x.body;
        form.cta_text.value = x.cta_text;
        form.cta_url.value = x.cta_url;
        preview();
      });
    if (sent) return;

    let savedId = isNew ? null : c.id;
    const showErrors = (err) => {
      toast(err.message);
      $$('.field .error', form).forEach((e) => e.remove());
      for (const [k, msg] of Object.entries(err.fields || {})) {
        const f = form.elements[k] && form.elements[k].closest('.field');
        if (f) f.insertAdjacentHTML('beforeend', `<span class="error">${esc(msg)}</span>`);
      }
    };
    async function save() {
      const saved = await api(savedId ? `/api/admin/crm/campaigns/${savedId}` : '/api/admin/crm/campaigns', { method: savedId ? 'PUT' : 'POST', json: body() });
      savedId = saved.id;
      return saved;
    }
    $('#save').addEventListener('click', async () => {
      try {
        await save();
        toast('Borrador guardado');
        if (isNew) history.replaceState(null, '', `#/crm/campanas/${savedId}`);
      } catch (err) {
        showErrors(err);
      }
    });
    $('#test').addEventListener('click', async () => {
      try {
        await save();
        const r = await api(`/api/admin/crm/campaigns/${savedId}/test`, { method: 'POST', json: { to: $('#test-to').value } });
        toast(`Prueba enviada a ${r.to}`);
      } catch (err) {
        showErrors(err);
      }
    });
    // Confirmación dentro de la página antes de enviar
    $('#send').addEventListener('click', async () => {
      try {
        await save();
        const n = await audience();
        const box = $('#send-confirm');
        box.hidden = false;
        box.innerHTML = n
          ? `¿Enviar "<strong>${esc(form.subject.value)}</strong>" a <strong>${n}</strong> anunciante${n === 1 ? '' : 's'}? Esto no se puede deshacer.
             <div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="btn btn-primary btn-sm" id="send-yes">Sí, enviar ahora</button><button type="button" class="btn btn-sm" id="send-no">Cancelar</button></div>`
          : 'No hay anunciantes que acepten promociones en este grupo. Cambiá los filtros.';
        const yes = $('#send-yes');
        if (!yes) return;
        $('#send-no').addEventListener('click', () => (box.hidden = true));
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          try {
            const r = await api(`/api/admin/crm/campaigns/${savedId}/send`, { method: 'POST', json: {} });
            toast(`Campaña enviada a ${r.recipients} anunciantes`);
            location.hash = '#/crm/campanas';
          } catch (err) {
            showErrors(err);
            yes.disabled = false;
          }
        });
      } catch (err) {
        showErrors(err);
      }
    });
    const del = $('#del');
    if (del)
      del.addEventListener('click', async () => {
        if (!confirm('¿Borrar este borrador?')) return;
        await api(`/api/admin/crm/campaigns/${savedId}`, { method: 'DELETE' });
        location.hash = '#/crm/campanas';
      });
  }

  async function route(parts, params) {
    if (parts[1] === 'contacto' && parts[2]) return contactView(parts[2]);
    if (parts[1] === 'campanas' && parts[2]) return campaignEditView(parts[2], params);
    if (parts[1] === 'campanas') return campaignsView();
    return contactsView(params);
  }

  window.MO_CRM = { route };
})();
