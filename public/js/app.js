/* Maldonado Oportunidades — aplicación pública (SPA sin dependencias) */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $('#view');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let META = null;
  let COUNTS = {};

  const SORT_OPTIONS = [
    ['relevance', 'Destacados primero'],
    ['recent', 'Más recientes'],
    ['oldest', 'Más antiguos'],
    ['price_asc', 'Precio: menor a mayor'],
    ['price_desc', 'Precio: mayor a menor'],
    ['popular', 'Más vistos'],
    ['event_date', 'Fecha del evento'],
    ['title', 'Título (A-Z)'],
  ];
  const DAYS_OPTIONS = [['', 'Cualquier fecha'], ['1', 'Últimas 24 horas'], ['7', 'Última semana'], ['30', 'Último mes']];

  // ---------- Utilidades ----------
  async function api(url, opts = {}) {
    const res = await fetch(url, opts);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* sin cuerpo */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.fields = data && data.fields;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 3500);
  }

  const cat = (id) => META.categories.find((c) => c.id === id);
  const nf = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 });

  function formatPrice(l) {
    if (l.price === null || l.price === undefined) return '';
    if (Number(l.price) === 0) return l.category === 'eventos' ? 'Entrada libre' : 'Gratis';
    return `${l.currency === 'USD' ? 'US$' : '$'} ${nf.format(l.price)}`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'recién';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
    const d = Math.floor(diff / 86400);
    if (d < 30) return `hace ${d} día${d === 1 ? '' : 's'}`;
    return new Date(iso).toLocaleDateString('es-UY');
  }

  function formatDate(ymd) {
    if (!ymd) return '';
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-UY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), params: Object.fromEntries(new URLSearchParams(query)) };
  }

  function buildHash(path, params) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null));
    const qs = new URLSearchParams(clean).toString();
    return `#${path}${qs ? `?${qs}` : ''}`;
  }

  function setTitle(t) {
    document.title = t ? `${t} | ${META.siteName}` : `${META.siteName} — Empleos, alquileres y avisos en Maldonado`;
  }

  // ---------- AdSense ----------
  function adHtml(slot, cls = '') {
    const a = META.adsense;
    if (!a || !slot) return '';
    return `<div class="ad-slot ${cls}"><span class="ad-label">Publicidad</span>
      <ins class="adsbygoogle" style="display:block" data-ad-client="${esc(a.client)}" data-ad-slot="${esc(slot)}"
        data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
  }

  function activateAds(root = document) {
    if (!META.adsense) return;
    $$('ins.adsbygoogle:not([data-adsbygoogle-status])', root).forEach((ins) => {
      if (ins.dataset.pushed) return;
      ins.dataset.pushed = '1';
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        /* bloqueador de anuncios o aún cargando */
      }
    });
  }

  function renderTopAd() {
    const box = $('#ad-top');
    if (META.adsense && META.adsense.slotTop && !box.dataset.ready) {
      box.innerHTML = adHtml(META.adsense.slotTop);
      box.hidden = false;
      box.dataset.ready = '1';
      activateAds(box);
    }
  }

  // ---------- Pestañas ----------
  function renderTabs(active) {
    let html = `<a class="tab" role="tab" href="#/" aria-selected="${active === 'home'}">🏖️ Inicio</a>`;
    let group = null;
    for (const c of META.categories) {
      if (group && c.group !== group) html += '<span class="tab-sep" aria-hidden="true"></span>';
      group = c.group;
      const n = COUNTS[c.id];
      html += `<a class="tab" role="tab" href="#/s/${c.id}" aria-selected="${active === c.id}">${c.icon} ${esc(c.label)}${n ? ` <span class="count">${n}</span>` : ''}</a>`;
    }
    $('#tabs').innerHTML = html;
    const sel = $('#tabs .tab[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  // ---------- Tarjetas ----------
  function cardHtml(l) {
    const c = cat(l.category);
    const price = formatPrice(l);
    const img = l.image
      ? `<img class="card-img" src="${esc(l.image)}" alt="" loading="lazy">`
      : `<div class="card-img placeholder" aria-hidden="true">${c ? c.icon : '📌'}</div>`;
    return `<a class="card" href="#/aviso/${l.id}">
      ${l.featured ? '<span class="badge badge-featured">★ Destacado</span>' : ''}
      ${img}
      <div class="card-body">
        <div class="card-meta">
          ${l.subtype ? `<span class="badge">${esc(l.subtype)}</span>` : ''}
          ${l.event_date ? `<span class="badge badge-date">📅 ${esc(formatDate(l.event_date))}</span>` : ''}
        </div>
        <h3 class="card-title">${esc(l.title)}</h3>
        ${l.company ? `<div class="muted" style="font-size:.88rem">${esc(l.company)}</div>` : ''}
        <p class="card-desc">${esc(l.description)}</p>
        <div class="card-meta">
          ${price ? `<span class="price">${esc(price)}</span>` : ''}
          ${l.location ? `<span>📍 ${esc(l.location)}</span>` : ''}
          <span>🕒 ${esc(timeAgo(l.published_at || l.created_at))}</span>
        </div>
      </div>
    </a>`;
  }

  function gridHtml(items) {
    const a = META.adsense;
    const every = a && a.slotFeed ? a.feedEvery : 0;
    let html = '';
    items.forEach((l, i) => {
      html += cardHtml(l);
      if (every && (i + 1) % every === 0 && i < items.length - 1) html += adHtml(a.slotFeed);
    });
    return `<div class="grid">${html}</div>`;
  }

  function paginationHtml(page, pages, hrefFor) {
    if (pages <= 1) return '';
    const nums = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    const sorted = [...nums].sort((a, b) => a - b);
    let html = `<nav class="pagination" aria-label="Paginación">`;
    html += page > 1 ? `<a class="btn" href="${hrefFor(page - 1)}" aria-label="Anterior">‹</a>` : `<span class="btn" aria-disabled="true" style="opacity:.4">‹</span>`;
    let prev = 0;
    for (const n of sorted) {
      if (n - prev > 1) html += '<span class="dots">…</span>';
      html += `<a class="btn" href="${hrefFor(n)}" ${n === page ? 'aria-current="page"' : ''}>${n}</a>`;
      prev = n;
    }
    html += page < pages ? `<a class="btn" href="${hrefFor(page + 1)}" aria-label="Siguiente">›</a>` : `<span class="btn" aria-disabled="true" style="opacity:.4">›</span>`;
    return `${html}</nav>`;
  }

  // ---------- Vistas ----------
  async function homeView() {
    setTitle('');
    renderTabs('home');
    const quick = META.categories
      .map((c) => `<a href="#/s/${c.id}">${c.icon} ${esc(c.label)}<small>${COUNTS[c.id] || 0} publicaciones</small></a>`)
      .join('');
    view.innerHTML = `
      <section class="hero">
        <h1>Oportunidades en Maldonado y todo Uruguay</h1>
        <p>Trabajo, alquileres, avisos, noticias y eventos en un solo lugar.</p>
        <form class="search-bar" id="home-search" role="search">
          <div class="search-input"><input name="q" type="search" placeholder="¿Qué estás buscando?" aria-label="Buscar" /></div>
          <button class="btn btn-accent" type="submit">Buscar</button>
        </form>
      </section>
      <div class="quick">${quick}</div>
      <div id="home-sections">${['empleo-maldonado', 'alquileres', 'eventos', 'noticias'].map(() => '<div class="skeleton" style="margin:16px 0"></div>').join('')}</div>`;
    $('#home-search').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = buildHash('/buscar', { q: new FormData(e.target).get('q').trim() });
    });

    const sections = ['empleo-maldonado', 'empleo-pais', 'alquileres', 'avisos-maldonado', 'eventos', 'noticias'];
    const results = await Promise.all(
      sections.map((id) => api(`/api/listings?category=${id}&pageSize=3${id === 'eventos' ? '&upcoming=1' : ''}`).catch(() => ({ items: [] }))),
    );
    let html = '';
    sections.forEach((id, i) => {
      const c = cat(id);
      if (!results[i].items.length) return;
      html += `<section class="home-section">
        <div class="section-head"><h2>${c.icon} ${esc(c.label)}</h2><a href="#/s/${id}">Ver todo (${results[i].total}) →</a></div>
        ${gridHtml(results[i].items)}
      </section>`;
      if (i === 1) html += adHtml(META.adsense && META.adsense.slotFeed);
    });
    $('#home-sections').innerHTML =
      html || `<div class="empty"><div class="big">🌊</div><p>Todavía no hay publicaciones.</p><a class="btn btn-primary" href="#/publicar">Publicar el primero</a></div>`;
    activateAds(view);
  }

  async function listView(categoryId, params) {
    const c = categoryId ? cat(categoryId) : null;
    if (categoryId && !c) return notFound();
    const base = c ? `/s/${c.id}` : '/buscar';
    setTitle(c ? c.label : `Búsqueda${params.q ? `: ${params.q}` : ''}`);
    renderTabs(c ? c.id : 'search');

    const effectiveCat = c || (params.category ? cat(params.category) : null);
    const locations = effectiveCat ? effectiveCat.locations : [...META.localities, ...META.departments.filter((d) => d !== 'Maldonado')];
    const subtypes = effectiveCat ? effectiveCat.subtypes : [];
    const priceLabel = effectiveCat && effectiveCat.priceLabel ? effectiveCat.priceLabel : 'Precio';
    const showPrice = !effectiveCat || effectiveCat.hasPrice;
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;

    view.innerHTML = `
      <div class="section-head">
        <div>
          <h1>${c ? `${c.icon} ${esc(c.label)}` : '🔎 Buscar en todo el sitio'}</h1>
          <p class="muted" id="result-count">Cargando…</p>
        </div>
        ${c && c.id !== 'noticias' ? `<a class="btn btn-sm" href="#/alertas?cat=${c.id}">🔔 Avisarme de nuevos</a>` : ''}
      </div>
      <form class="search-bar" id="search-form" role="search">
        <div class="search-input"><input name="q" type="search" value="${esc(params.q || '')}" placeholder="Buscar ${c ? `en ${esc(c.label.toLowerCase())}` : 'por palabra clave'}…" aria-label="Buscar" /></div>
        <button class="btn btn-primary" type="submit">Buscar</button>
      </form>
      <div class="layout" style="margin-top:12px">
        <aside class="filters" id="filters" aria-label="Filtros">
          <div class="section-head" style="margin:0 0 10px"><h2>Filtros</h2><button type="button" class="btn btn-ghost btn-sm only-mobile" data-close-filters aria-label="Cerrar">✕</button></div>
          <form id="filter-form">
            ${!c ? `<div class="field"><label for="f-category">Sección</label><select id="f-category" name="category">${opt('', 'Todas')}${META.categories.map((x) => opt(x.id, x.label, params.category)).join('')}</select></div>` : ''}
            <div class="field"><label for="f-location">Ubicación</label>
              <select id="f-location" name="location">${opt('', 'Todas')}${locations.map((x) => opt(x, x, params.location)).join('')}</select></div>
            ${subtypes && subtypes.length ? `<div class="field"><label for="f-subtype">Tipo</label><select id="f-subtype" name="subtype">${opt('', 'Todos')}${subtypes.map((x) => opt(x, x, params.subtype)).join('')}</select></div>` : ''}
            ${showPrice ? `<div class="field"><label>${esc(priceLabel)}</label>
              <div class="row-2" style="grid-template-columns:1fr 1fr">
                <input name="minPrice" inputmode="numeric" placeholder="Mín." value="${esc(params.minPrice || '')}" aria-label="${esc(priceLabel)} mínimo">
                <input name="maxPrice" inputmode="numeric" placeholder="Máx." value="${esc(params.maxPrice || '')}" aria-label="${esc(priceLabel)} máximo">
              </div>
              <select name="currency" aria-label="Moneda">${opt('', 'Cualquier moneda')}${opt('UYU', 'Pesos ($)', params.currency)}${opt('USD', 'Dólares (US$)', params.currency)}</select></div>` : ''}
            <div class="field"><label for="f-days">Publicado</label><select id="f-days" name="days">${DAYS_OPTIONS.map(([v, l]) => opt(v, l, params.days)).join('')}</select></div>
            ${effectiveCat && effectiveCat.hasEventDate ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" name="upcoming" value="1" ${params.upcoming === '1' ? 'checked' : ''}> Solo próximos eventos</label>` : ''}
            <label class="check" style="margin-bottom:10px"><input type="checkbox" name="withImage" value="1" ${params.withImage === '1' ? 'checked' : ''}> Solo con foto</label>
            <label class="check" style="margin-bottom:16px"><input type="checkbox" name="featured" value="1" ${params.featured === '1' ? 'checked' : ''}> Solo destacados</label>
            <div class="filters-actions">
              <button type="button" class="btn" id="clear-filters">Limpiar</button>
              <button type="submit" class="btn btn-primary">Aplicar</button>
            </div>
          </form>
        </aside>
        <div>
          <div class="toolbar">
            <button type="button" class="btn btn-sm only-mobile" id="open-filters">⚙️ Filtros<span id="filter-count"></span></button>
            <div class="chips" id="chips"></div>
            <label style="display:flex;align-items:center;gap:6px;margin-left:auto">
              <span class="muted" style="font-weight:500">Ordenar</span>
              <select id="sort">${SORT_OPTIONS.filter(([v]) => v !== 'event_date' || (effectiveCat && effectiveCat.hasEventDate))
                .filter(([v]) => showPrice || !v.startsWith('price'))
                .map(([v, l]) => opt(v, l, params.sort || (c && c.id === 'eventos' ? 'event_date' : 'relevance')))
                .join('')}</select>
            </label>
          </div>
          <div id="results"><div class="grid">${'<div class="skeleton"></div>'.repeat(6)}</div></div>
        </div>
      </div>
      <a class="btn btn-primary fab" href="#/publicar${c ? `?cat=${c.id}` : ''}">＋ Publicar</a>`;

    const go = (patch) => {
      location.hash = buildHash(base, { ...params, page: '', ...patch });
    };
    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      go({ q: new FormData(e.target).get('q').trim() });
    });
    $('#filter-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const patch = { location: '', subtype: '', minPrice: '', maxPrice: '', currency: '', days: '', upcoming: '', withImage: '', featured: '', category: params.category || '' };
      for (const [k, v] of fd.entries()) patch[k] = String(v).trim();
      closeFilters();
      go(patch);
    });
    $('#clear-filters').addEventListener('click', () => {
      closeFilters();
      location.hash = buildHash(base, { q: params.q || '' });
    });
    $('#sort').addEventListener('change', (e) => go({ sort: e.target.value }));

    const filters = $('#filters');
    let backdrop = null;
    function closeFilters() {
      filters.classList.remove('open');
      if (backdrop) backdrop.remove();
      backdrop = null;
    }
    $('#open-filters').addEventListener('click', () => {
      filters.classList.add('open');
      backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      backdrop.addEventListener('click', closeFilters);
      document.body.appendChild(backdrop);
    });
    $('[data-close-filters]').addEventListener('click', closeFilters);

    // Chips de filtros activos
    const labels = {
      category: (v) => (cat(v) ? cat(v).label : v),
      location: (v) => `📍 ${v}`,
      subtype: (v) => v,
      minPrice: (v) => `Desde ${nf.format(v)}`,
      maxPrice: (v) => `Hasta ${nf.format(v)}`,
      currency: (v) => (v === 'USD' ? 'US$' : 'Pesos'),
      days: (v) => (DAYS_OPTIONS.find(([d]) => d === v) || [, v])[1],
      upcoming: () => 'Próximos',
      withImage: () => 'Con foto',
      featured: () => 'Destacados',
      q: (v) => `“${v}”`,
    };
    const active = Object.keys(labels).filter((k) => params[k]);
    $('#chips').innerHTML = active.map((k) => `<button type="button" class="chip" data-remove="${k}" aria-label="Quitar filtro">${esc(labels[k](params[k]))} ✕</button>`).join('');
    $$('#chips [data-remove]').forEach((b) => b.addEventListener('click', () => go({ [b.dataset.remove]: '' })));
    const nFilters = active.filter((k) => k !== 'q').length;
    $('#filter-count').textContent = nFilters ? ` (${nFilters})` : '';

    // Resultados
    const query = new URLSearchParams({ ...params, ...(c ? { category: c.id } : {}) });
    try {
      const data = await api(`/api/listings?${query}`);
      $('#result-count').textContent = `${data.total} resultado${data.total === 1 ? '' : 's'}${data.pages > 1 ? ` · página ${data.page} de ${data.pages}` : ''}`;
      if (!data.items.length) {
        $('#results').innerHTML = `<div class="empty"><div class="big">🔍</div><p>No encontramos publicaciones con esos criterios.</p>
          <p><a href="${buildHash(base, {})}">Ver todo</a> · <a href="#/alertas${c ? `?cat=${c.id}` : ''}">Crear una alerta</a></p></div>`;
        return;
      }
      $('#results').innerHTML =
        gridHtml(data.items) + paginationHtml(data.page, data.pages, (p) => buildHash(base, { ...params, page: p === 1 ? '' : p }));
      activateAds($('#results'));
    } catch (err) {
      $('#results').innerHTML = `<div class="empty"><p>No se pudieron cargar los resultados. ${esc(err.message)}</p></div>`;
    }
  }

  async function detailView(id) {
    view.innerHTML = '<div class="skeleton" style="margin:16px 0;min-height:360px"></div>';
    let l;
    try {
      l = await api(`/api/listings/${Number(id)}`);
    } catch {
      return notFound('Este aviso no existe o ya no está disponible.');
    }
    const c = cat(l.category);
    setTitle(l.title);
    renderTabs(l.category);
    const price = formatPrice(l);
    const tel = l.contact_phone.replace(/[^\d+]/g, '');
    const wa = tel ? tel.replace(/^\+/, '').replace(/^0/, '598') : '';
    const shareUrl = `${location.origin}/aviso/${l.id}`;
    view.innerHTML = `
      <div class="breadcrumb"><a href="#/">Inicio</a> › <a href="#/s/${c.id}">${esc(c.label)}</a></div>
      <div class="detail">
        <article class="panel">
          ${l.image ? `<img class="detail-img" src="${esc(l.image)}" alt="${esc(l.title)}">` : ''}
          <div class="card-meta" style="margin-bottom:8px">
            ${l.featured ? '<span class="badge" style="background:var(--accent);color:var(--accent-ink)">★ Destacado</span>' : ''}
            ${l.subtype ? `<span class="badge">${esc(l.subtype)}</span>` : ''}
            <span>🕒 Publicado ${esc(timeAgo(l.published_at || l.created_at))}</span>
            <span>👁️ ${l.views + 1} visita${l.views ? 's' : ''}</span>
          </div>
          <h1>${esc(l.title)}</h1>
          ${l.company ? `<p class="muted" style="margin-top:0">${esc(l.company)}</p>` : ''}
          ${price ? `<p class="price" style="font-size:1.4rem;margin:.2rem 0 1rem">${esc(price)}</p>` : ''}
          <div class="detail-desc">${esc(l.description)}</div>
          ${adHtml(META.adsense && META.adsense.slotDetail)}
        </article>
        <aside class="panel">
          <dl class="facts">
            <dt>Sección</dt><dd>${c.icon} ${esc(c.label)}</dd>
            ${l.location ? `<dt>Ubicación</dt><dd>${esc(l.location)}</dd>` : ''}
            ${l.event_date ? `<dt>Fecha</dt><dd>${esc(formatDate(l.event_date))}</dd>` : ''}
            ${l.contact_name ? `<dt>Contacto</dt><dd>${esc(l.contact_name)}</dd>` : ''}
            <dt>Referencia</dt><dd>#${l.id}</dd>
          </dl>
          <div class="contact-actions">
            ${tel ? `<a class="btn btn-primary" href="tel:${esc(tel)}">📞 Llamar ${esc(l.contact_phone)}</a>` : ''}
            ${wa ? `<a class="btn" href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(`Hola, vi tu aviso "${l.title}" en Maldonado Oportunidades`)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
            ${l.contact_email ? `<a class="btn" href="mailto:${esc(l.contact_email)}?subject=${encodeURIComponent(l.title)}">✉️ ${esc(l.contact_email)}</a>` : ''}
            ${l.website ? `<a class="btn" href="${esc(l.website)}" target="_blank" rel="noopener nofollow">🔗 Sitio web</a>` : ''}
            <button class="btn btn-ghost" id="share">↗️ Compartir</button>
          </div>
        </aside>
      </div>
      ${l.related && l.related.length ? `<section class="related"><div class="section-head"><h2>Más en ${esc(c.label)}</h2><a href="#/s/${c.id}">Ver todo →</a></div>${gridHtml(l.related.map((r) => ({ ...r, description: '', subtype: '' })))}</section>` : ''}`;
    $('#share').addEventListener('click', async () => {
      try {
        if (navigator.share) await navigator.share({ title: l.title, url: shareUrl });
        else {
          await navigator.clipboard.writeText(shareUrl);
          toast('Enlace copiado');
        }
      } catch {
        /* cancelado */
      }
    });
    activateAds(view);
    window.scrollTo(0, 0);
  }

  function fieldError(form, fields) {
    $$('.field', form).forEach((f) => {
      f.classList.remove('invalid');
      const e = $('.error', f);
      if (e) e.remove();
    });
    let first = null;
    for (const [name, msg] of Object.entries(fields || {})) {
      const input = form.elements[name] || (name === 'contact' ? form.elements.contact_phone : null) || (name === 'image' ? form.elements.imageFile : null);
      const field = input && (input.closest ? input.closest('.field') : input[0] && input[0].closest('.field'));
      if (!field) continue;
      field.classList.add('invalid');
      field.insertAdjacentHTML('beforeend', `<span class="error">${esc(msg)}</span>`);
      first = first || field;
    }
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function publishView(params) {
    setTitle('Publicar un aviso');
    renderTabs('publish');
    const selected = cat(params.cat) ? params.cat : 'empleo-maldonado';
    view.innerHTML = `
      <div class="form-page">
        <h1>＋ Publicar un aviso</h1>
        <div class="steps-note">Completá el formulario. Tu publicación será revisada antes de aparecer en el sitio. Publicar es gratis.</div>
        <form id="publish-form" class="panel" novalidate>
          <div class="field"><label>Sección *</label>
            <div class="cat-picker" role="radiogroup">
              ${META.categories.map((c) => `<label class="cat-option"><input type="radio" name="category" value="${c.id}" ${c.id === selected ? 'checked' : ''}><span>${c.icon} ${esc(c.label)}</span></label>`).join('')}
            </div>
          </div>
          <div class="field"><label for="p-title">Título *</label><input id="p-title" name="title" maxlength="140" required placeholder="Ej: Se busca cocinero/a para temporada"></div>
          <div class="row-2">
            <div class="field"><label for="p-subtype">Tipo</label><select id="p-subtype" name="subtype"></select></div>
            <div class="field"><label for="p-location">Ubicación</label><select id="p-location" name="location"></select></div>
          </div>
          <div class="field" id="company-field"><label for="p-company">Empresa / organizador <small>(opcional)</small></label><input id="p-company" name="company" maxlength="120"></div>
          <div class="field"><label for="p-description">Descripción *</label><textarea id="p-description" name="description" maxlength="6000" required placeholder="Contá todos los detalles: requisitos, horarios, características, etc."></textarea><small><span id="desc-count">0</span>/6000</small></div>
          <div class="row-2" id="price-row">
            <div class="field"><label for="p-price" id="price-label">Precio</label><input id="p-price" name="price" inputmode="decimal" placeholder="Opcional"></div>
            <div class="field"><label for="p-currency">Moneda</label><select id="p-currency" name="currency"><option value="UYU">Pesos uruguayos ($)</option><option value="USD">Dólares (US$)</option></select></div>
          </div>
          <div class="field" id="event-field" hidden><label for="p-event">Fecha del evento *</label><input id="p-event" type="date" name="event_date"></div>
          <div class="field"><label for="p-image">Foto <small>(opcional, máx. 5 MB)</small></label><input id="p-image" type="file" name="imageFile" accept="image/jpeg,image/png,image/webp,image/gif"><img id="img-preview" class="img-preview" alt="" hidden></div>
          <h2 style="margin-top:8px">Datos de contacto</h2>
          <div class="field"><label for="p-cname">Nombre</label><input id="p-cname" name="contact_name" maxlength="120" autocomplete="name"></div>
          <div class="row-2">
            <div class="field"><label for="p-phone">Teléfono / WhatsApp</label><input id="p-phone" name="contact_phone" type="tel" maxlength="40" autocomplete="tel" placeholder="09X XXX XXX"></div>
            <div class="field"><label for="p-email">Email</label><input id="p-email" name="contact_email" type="email" maxlength="160" autocomplete="email"></div>
          </div>
          <div class="field"><label for="p-web">Sitio web <small>(opcional)</small></label><input id="p-web" name="website" maxlength="300" placeholder="https://"></div>
          <input class="hp" name="hp_field" tabindex="-1" autocomplete="off" aria-hidden="true">
          <div class="field"><label class="check"><input type="checkbox" name="accept_terms" value="on"> Acepto las <a href="#/terminos" target="_blank">condiciones de uso</a> y confirmo que la información es real.</label></div>
          <button class="btn btn-primary" type="submit" style="width:100%">Enviar publicación</button>
        </form>
      </div>`;

    const form = $('#publish-form');
    function syncCategory() {
      const c = cat(form.elements.category.value);
      $('#p-subtype').innerHTML = `<option value="">—</option>${(c.subtypes || []).map((s) => `<option>${esc(s)}</option>`).join('')}`;
      $('#p-location').innerHTML = `<option value="">—</option>${c.locations.map((s) => `<option>${esc(s)}</option>`).join('')}`;
      $('#price-row').hidden = !c.hasPrice;
      $('#price-label').textContent = c.priceLabel || 'Precio';
      $('#event-field').hidden = !c.hasEventDate;
      $('#company-field').hidden = c.id === 'noticias';
    }
    $$('input[name="category"]', form).forEach((r) => r.addEventListener('change', syncCategory));
    syncCategory();
    $('#p-description').addEventListener('input', (e) => ($('#desc-count').textContent = e.target.value.length));
    $('#p-image').addEventListener('change', (e) => {
      const f = e.target.files[0];
      const prev = $('#img-preview');
      if (f && f.size > 5 * 1024 * 1024) {
        toast('La imagen supera los 5 MB');
        e.target.value = '';
      }
      prev.hidden = !e.target.files[0];
      if (e.target.files[0]) prev.src = URL.createObjectURL(e.target.files[0]);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', form);
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      try {
        const res = await api('/api/listings', { method: 'POST', body: new FormData(form) });
        view.innerHTML = `<div class="form-page"><div class="empty"><div class="big">✅</div>
          <h1>¡Gracias por publicar!</h1>
          <p>${res.status === 'approved' ? 'Tu aviso ya está publicado.' : 'Tu aviso quedó pendiente de revisión y aparecerá en el sitio una vez aprobado.'}</p>
          <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            ${res.status === 'approved' ? `<a class="btn btn-primary" href="#/aviso/${res.id}">Ver aviso</a>` : ''}
            <a class="btn" href="#/publicar">Publicar otro</a><a class="btn" href="#/">Ir al inicio</a></p></div></div>`;
        window.scrollTo(0, 0);
      } catch (err) {
        toast(err.message);
        fieldError(form, err.fields);
        btn.disabled = false;
        btn.textContent = 'Enviar publicación';
      }
    });
  }

  async function alertsView(params) {
    setTitle('Alertas por email');
    renderTabs('alerts');
    let sub = null;
    if (params.token) {
      try {
        sub = await api(`/api/subscriptions/${encodeURIComponent(params.token)}`);
      } catch {
        toast('No encontramos esa alerta');
      }
    }
    const selectedCats = sub ? sub.categories : params.cat ? [params.cat] : [];
    const allLocations = [...new Set([...META.localities, ...META.departments])];
    view.innerHTML = `
      <div class="form-page">
        <h1>🔔 ${sub ? 'Tus alertas' : 'Configurar alertas'}</h1>
        <div class="steps-note">${sub ? `Alertas de <strong>${esc(sub.email)}</strong>. ${sub.active ? '' : '<strong>Actualmente pausadas.</strong>'}` : 'Recibí por email los nuevos avisos que te interesan: elegí secciones, palabras clave, zona y frecuencia.'}</div>
        <form id="alert-form" class="panel" novalidate>
          ${sub ? '' : '<div class="field"><label for="a-email">Tu email *</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>'}
          <div class="field"><label>Secciones <small>(si no marcás ninguna, recibís de todas)</small></label>
            <div class="cat-picker">${META.categories.map((c) => `<label class="cat-option"><input type="checkbox" name="categories" value="${c.id}" ${selectedCats.includes(c.id) ? 'checked' : ''}><span>${c.icon} ${esc(c.label)}</span></label>`).join('')}</div>
          </div>
          <div class="field"><label for="a-kw">Palabras clave <small>(separadas por coma, opcional)</small></label><input id="a-kw" name="keywords" value="${esc(sub ? sub.keywords : '')}" placeholder="Ej: cocina, recepción, 2 dormitorios"></div>
          <div class="field"><label for="a-loc">Zona</label><select id="a-loc" name="location"><option value="">Todas</option>${allLocations.map((l) => `<option ${sub && sub.location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <div class="field"><label>Frecuencia</label>
            ${[['instant', 'Al instante (un email por aviso)'], ['daily', 'Resumen diario'], ['weekly', 'Resumen semanal']]
              .map(([v, l]) => `<label class="check"><input type="radio" name="frequency" value="${v}" ${(sub ? sub.frequency : 'daily') === v ? 'checked' : ''}> ${l}</label>`)
              .join('')}
          </div>
          ${sub ? `<label class="check" style="margin-bottom:14px"><input type="checkbox" name="active" ${sub.active ? 'checked' : ''}> Alertas activas</label>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit" style="flex:1">${sub ? 'Guardar cambios' : 'Activar alertas'}</button>
            ${sub ? '<button class="btn btn-danger" type="button" id="delete-sub">Eliminar alertas</button>' : ''}
          </div>
        </form>
      </div>`;

    const form = $('#alert-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        email: fd.get('email'),
        categories: fd.getAll('categories'),
        keywords: fd.get('keywords'),
        location: fd.get('location'),
        frequency: fd.get('frequency'),
      };
      try {
        if (sub) {
          body.active = form.elements.active.checked;
          await api(`/api/subscriptions/${encodeURIComponent(sub.token)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          toast('Alertas actualizadas');
        } else {
          const res = await api('/api/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          view.innerHTML = `<div class="form-page"><div class="empty"><div class="big">📬</div>
            <h1>${res.existing ? 'Revisá tu correo' : '¡Alertas activadas!'}</h1>
            <p>${res.existing ? 'Ese email ya tenía alertas. Te enviamos un enlace para modificarlas.' : 'Te enviamos un email con el enlace para modificar o cancelar tus alertas cuando quieras.'}</p>
            <a class="btn btn-primary" href="#/">Volver al inicio</a></div></div>`;
        }
      } catch (err) {
        toast(err.message);
        fieldError(form, err.fields);
      }
    });
    const del = $('#delete-sub');
    if (del)
      del.addEventListener('click', async () => {
        if (!confirm('¿Eliminar tus alertas? No vas a recibir más correos.')) return;
        await api(`/api/subscriptions/${encodeURIComponent(sub.token)}`, { method: 'DELETE' });
        toast('Alertas eliminadas');
        location.hash = '#/';
      });
  }

  function privacyView() {
    setTitle('Privacidad y cookies');
    renderTabs('privacy');
    view.innerHTML = `<article class="prose panel">
      <h1>Política de privacidad y cookies</h1>
      <p>En ${esc(META.siteName)} respetamos tu privacidad. Esta página explica qué datos recopilamos y cómo los usamos, conforme a la Ley N.º 18.331 de Protección de Datos Personales de Uruguay.</p>
      <h2>Datos que recopilamos</h2>
      <ul><li>Los datos que ingresás al publicar un aviso (nombre, teléfono, email), que se muestran públicamente junto al aviso.</li>
      <li>El email y las preferencias que indicás al configurar alertas, usados solo para enviarte esas notificaciones.</li></ul>
      <h2>Publicidad y cookies</h2>
      <p>Este sitio utiliza Google AdSense para mostrar anuncios. Google y sus socios utilizan cookies para mostrar anuncios basados en tus visitas anteriores a este y otros sitios web. Podés desactivar la publicidad personalizada en <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener">Configuración de anuncios de Google</a> o en <a href="https://www.aboutads.info" target="_blank" rel="noopener">www.aboutads.info</a>.</p>
      <p>Más información sobre cómo Google usa los datos: <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener">policies.google.com/technologies/partner-sites</a>.</p>
      <h2>Tus derechos</h2>
      <p>Podés solicitar el acceso, rectificación o eliminación de tus datos${META.contactEmail ? ` escribiendo a <a href="mailto:${esc(META.contactEmail)}">${esc(META.contactEmail)}</a>` : ' contactándonos'}. Las alertas se pueden cancelar en cualquier momento desde el enlace incluido en cada email.</p>
    </article>`;
  }

  function termsView() {
    setTitle('Condiciones de uso');
    renderTabs('terms');
    view.innerHTML = `<article class="prose panel">
      <h1>Condiciones de uso</h1>
      <p>Al publicar en ${esc(META.siteName)} aceptás estas condiciones:</p>
      <ul>
        <li>La información publicada debe ser verdadera y estar relacionada con la sección elegida.</li>
        <li>No se permiten avisos engañosos, discriminatorios, ilegales, ni ofertas de empleo que soliciten pagos a los postulantes.</li>
        <li>Nos reservamos el derecho de editar, rechazar o eliminar cualquier publicación.</li>
        <li>${esc(META.siteName)} no es parte de las transacciones entre usuarios; cada anunciante es responsable de su aviso.</li>
      </ul>
      <p>Si ves un aviso sospechoso${META.contactEmail ? `, avisanos a <a href="mailto:${esc(META.contactEmail)}">${esc(META.contactEmail)}</a>` : ''} indicando su número de referencia.</p>
    </article>`;
  }

  function notFound(msg) {
    setTitle('No encontrado');
    view.innerHTML = `<div class="empty" style="margin:24px 0"><div class="big">🧭</div><p>${esc(msg || 'Página no encontrada.')}</p><a class="btn btn-primary" href="#/">Ir al inicio</a></div>`;
  }

  // ---------- Router ----------
  async function route() {
    const { parts, params } = parseHash();
    const [a, b] = parts;
    if (!a || a === '') await homeView();
    else if (a === 's' && b) await listView(b, params);
    else if (a === 'buscar') await listView(null, params);
    else if (a === 'aviso' && b) await detailView(b);
    else if (a === 'publicar') publishView(params);
    else if (a === 'alertas') await alertsView(params);
    else if (a === 'privacidad') privacyView();
    else if (a === 'terminos') termsView();
    else notFound();
  }

  let lastPath = null;
  window.addEventListener('hashchange', () => {
    const path = location.hash.split('?')[0];
    route().then(() => {
      if (path !== lastPath) window.scrollTo(0, 0);
      lastPath = path;
    });
  });

  async function init() {
    try {
      [META, COUNTS] = await Promise.all([api('/api/meta'), api('/api/counts').catch(() => ({}))]);
    } catch {
      view.innerHTML = '<div class="empty" style="margin:24px 0"><p>No se pudo conectar con el servidor. Recargá la página.</p></div>';
      return;
    }
    renderTopAd();
    lastPath = location.hash.split('?')[0];
    route();
  }

  init();
})();
