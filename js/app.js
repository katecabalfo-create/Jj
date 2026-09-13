(function () {
  "use strict";

  const STORAGE_KEY = "maldonado_oportunidades_transactions_v1";

  const CATEGORIES = {
    ingreso: ["Venta", "Alquiler", "Comisión", "Anticipo", "Otro"],
    gasto: ["Mantenimiento", "Servicios", "Impuestos", "Publicidad", "Sueldos", "Comisiones", "Otro"],
  };

  const $ = (id) => document.getElementById(id);

  const form = $("transactionForm");
  const tipoInput = $("tipo");
  const fechaInput = $("fecha");
  const categoriaInput = $("categoria");
  const montoInput = $("monto");
  const descripcionInput = $("descripcion");
  const submitBtn = $("submitBtn");
  const cancelEditBtn = $("cancelEditBtn");

  const filterTipo = $("filterTipo");
  const filterCategoria = $("filterCategoria");
  const filterMes = $("filterMes");
  const filterTexto = $("filterTexto");
  const clearFiltersBtn = $("clearFiltersBtn");
  const exportCsvBtn = $("exportCsvBtn");

  const transactionsBody = $("transactionsBody");
  const emptyState = $("emptyState");

  const totalIngresosEl = $("totalIngresos");
  const totalGastosEl = $("totalGastos");
  const totalBalanceEl = $("totalBalance");

  const monthlySummaryEl = $("monthlySummary");

  let transactions = loadTransactions();
  let editingId = null;

  function loadTransactions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error("No se pudieron cargar los datos guardados", e);
      return [];
    }
  }

  function saveTransactions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  }

  function formatCurrency(amount) {
    return new Intl.NumberFormat("es-UY", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount);
  }

  function formatDate(isoDate) {
    if (!isoDate) return "";
    const [y, m, d] = isoDate.split("-");
    return `${d}/${m}/${y}`;
  }

  function generateId() {
    return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------- Tabs ----------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "resumen") renderMonthlySummary();
    });
  });

  // ---------- Category population ----------
  function populateCategories(selectEl, tipo, includeAllOption) {
    const current = selectEl.value;
    selectEl.innerHTML = "";
    if (includeAllOption) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Todas";
      selectEl.appendChild(opt);
    }
    const cats = tipo ? CATEGORIES[tipo] : [...new Set([...CATEGORIES.ingreso, ...CATEGORIES.gasto])];
    cats.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      selectEl.appendChild(opt);
    });
    if ([...selectEl.options].some((o) => o.value === current)) {
      selectEl.value = current;
    }
  }

  tipoInput.addEventListener("change", () => {
    populateCategories(categoriaInput, tipoInput.value, false);
  });

  // ---------- Form submit ----------
  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const monto = parseFloat(montoInput.value);
    if (isNaN(monto) || monto <= 0) {
      montoInput.focus();
      return;
    }

    const record = {
      id: editingId || generateId(),
      tipo: tipoInput.value,
      fecha: fechaInput.value,
      categoria: categoriaInput.value,
      descripcion: descripcionInput.value.trim(),
      monto,
    };

    if (editingId) {
      const idx = transactions.findIndex((t) => t.id === editingId);
      if (idx !== -1) transactions[idx] = record;
      exitEditMode();
    } else {
      transactions.push(record);
    }

    saveTransactions();
    resetForm();
    renderAll();
  });

  cancelEditBtn.addEventListener("click", () => {
    exitEditMode();
    resetForm();
  });

  function resetForm() {
    form.reset();
    fechaInput.value = todayIso();
    populateCategories(categoriaInput, tipoInput.value, false);
  }

  function exitEditMode() {
    editingId = null;
    submitBtn.textContent = "Agregar";
    cancelEditBtn.hidden = true;
  }

  function enterEditMode(record) {
    editingId = record.id;
    tipoInput.value = record.tipo;
    populateCategories(categoriaInput, record.tipo, false);
    fechaInput.value = record.fecha;
    categoriaInput.value = record.categoria;
    montoInput.value = record.monto;
    descripcionInput.value = record.descripcion;
    submitBtn.textContent = "Guardar cambios";
    cancelEditBtn.hidden = false;
    document.querySelector('.tab-btn[data-tab="nueva"]').click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function todayIso() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  // ---------- Filters ----------
  [filterTipo, filterCategoria, filterMes, filterTexto].forEach((el) => {
    el.addEventListener("input", renderTable);
  });

  clearFiltersBtn.addEventListener("click", () => {
    filterTipo.value = "";
    filterCategoria.value = "";
    filterMes.value = "";
    filterTexto.value = "";
    renderTable();
  });

  function getFilteredTransactions() {
    return transactions
      .filter((t) => (filterTipo.value ? t.tipo === filterTipo.value : true))
      .filter((t) => (filterCategoria.value ? t.categoria === filterCategoria.value : true))
      .filter((t) => (filterMes.value ? t.fecha.startsWith(filterMes.value) : true))
      .filter((t) =>
        filterTexto.value
          ? t.descripcion.toLowerCase().includes(filterTexto.value.toLowerCase())
          : true
      )
      .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  }

  // ---------- Rendering ----------
  function renderTable() {
    const filtered = getFilteredTransactions();
    transactionsBody.innerHTML = "";

    if (filtered.length === 0) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
    }

    filtered.forEach((t) => {
      const tr = document.createElement("tr");

      const tipoLabel = t.tipo === "ingreso" ? "Entrada" : "Gasto";
      const amountSign = t.tipo === "ingreso" ? "+" : "-";

      tr.innerHTML = `
        <td>${formatDate(t.fecha)}</td>
        <td><span class="badge badge-${t.tipo}">${tipoLabel}</span></td>
        <td>${escapeHtml(t.categoria)}</td>
        <td>${escapeHtml(t.descripcion) || "—"}</td>
        <td class="col-amount amount-${t.tipo}">${amountSign} ${formatCurrency(t.monto)}</td>
        <td class="col-actions">
          <button class="row-btn" data-action="edit" data-id="${t.id}">Editar</button>
          <button class="row-btn danger" data-action="delete" data-id="${t.id}">Eliminar</button>
        </td>
      `;
      transactionsBody.appendChild(tr);
    });
  }

  transactionsBody.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const record = transactions.find((t) => t.id === id);
    if (!record) return;

    if (btn.dataset.action === "edit") {
      enterEditMode(record);
    } else if (btn.dataset.action === "delete") {
      if (confirm("¿Eliminar esta transacción?")) {
        transactions = transactions.filter((t) => t.id !== id);
        saveTransactions();
        if (editingId === id) {
          exitEditMode();
          resetForm();
        }
        renderAll();
      }
    }
  });

  function renderSummaryCards() {
    const totalIngresos = transactions
      .filter((t) => t.tipo === "ingreso")
      .reduce((sum, t) => sum + t.monto, 0);
    const totalGastos = transactions
      .filter((t) => t.tipo === "gasto")
      .reduce((sum, t) => sum + t.monto, 0);
    const balance = totalIngresos - totalGastos;

    totalIngresosEl.textContent = formatCurrency(totalIngresos);
    totalGastosEl.textContent = formatCurrency(totalGastos);
    totalBalanceEl.textContent = formatCurrency(balance);
    totalBalanceEl.style.color = balance >= 0 ? "var(--color-income)" : "var(--color-expense)";
  }

  function renderMonthlySummary() {
    const byMonth = {};
    transactions.forEach((t) => {
      const key = t.fecha ? t.fecha.slice(0, 7) : "sin-fecha";
      if (!byMonth[key]) byMonth[key] = { ingreso: 0, gasto: 0 };
      byMonth[key][t.tipo] += t.monto;
    });

    const months = Object.keys(byMonth).sort().reverse();

    if (months.length === 0) {
      monthlySummaryEl.innerHTML = '<p class="empty-state">No hay datos para mostrar todavía.</p>';
      return;
    }

    monthlySummaryEl.innerHTML = months
      .map((month) => {
        const { ingreso, gasto } = byMonth[month];
        const balance = ingreso - gasto;
        const max = Math.max(ingreso, gasto, 1);
        const ingresoPct = (ingreso / max) * 100;
        const gastoPct = (gasto / max) * 100;
        const label = formatMonthLabel(month);

        return `
          <div class="month-row">
            <div class="month-row-header">
              <h3>${label}</h3>
              <span class="balance" style="color:${balance >= 0 ? "var(--color-income)" : "var(--color-expense)"}">
                Balance: ${formatCurrency(balance)}
              </span>
            </div>
            <div class="bar-track">
              <div class="bar-ingreso" style="width:${ingresoPct / 2}%"></div>
              <div class="bar-gasto" style="width:${gastoPct / 2}%"></div>
            </div>
            <div class="month-row-legend">
              <span>Entradas: ${formatCurrency(ingreso)}</span>
              <span>Gastos: ${formatCurrency(gasto)}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function formatMonthLabel(key) {
    if (key === "sin-fecha") return "Sin fecha";
    const [y, m] = key.split("-");
    const date = new Date(Number(y), Number(m) - 1, 1);
    return date.toLocaleDateString("es-UY", { month: "long", year: "numeric" });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function renderFilterCategoryOptions() {
    const selected = filterCategoria.value;
    populateCategories(filterCategoria, "", true);
    filterCategoria.value = selected;
  }

  function renderAll() {
    renderTable();
    renderSummaryCards();
    renderMonthlySummary();
  }

  // ---------- CSV export ----------
  exportCsvBtn.addEventListener("click", () => {
    const rows = getFilteredTransactions();
    if (rows.length === 0) {
      alert("No hay transacciones para exportar.");
      return;
    }
    const header = ["Fecha", "Tipo", "Categoria", "Descripcion", "Monto"];
    const csvLines = [header.join(",")];
    rows.forEach((t) => {
      const line = [
        t.fecha,
        t.tipo === "ingreso" ? "Entrada" : "Gasto",
        csvEscape(t.categoria),
        csvEscape(t.descripcion),
        t.monto.toFixed(2),
      ].join(",");
      csvLines.push(line);
    });
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maldonado_oportunidades_transacciones_${todayIso()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  function csvEscape(value) {
    const str = String(value ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ---------- Init ----------
  function init() {
    populateCategories(categoriaInput, tipoInput.value, false);
    renderFilterCategoryOptions();
    fechaInput.value = todayIso();
    renderAll();
  }

  init();
})();
