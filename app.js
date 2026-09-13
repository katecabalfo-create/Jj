/* Mis Finanzas — control de ingresos, gastos, tarjetas con cuotas y cuentas fijas.
   Todo se guarda en localStorage del navegador. */

const STORAGE_KEY = "mis-finanzas-data-v1";

const state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("No se pudo leer localStorage", e);
  }
  return { incomes: [], expenses: [], cards: [], installments: [], fixed: [] };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("No se pudo guardar en localStorage", e);
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatCurrency(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 });
}

function todayMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthKeyFromDate(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : "";
}

function monthIndex(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return y * 12 + (m - 1);
}

function addMonths(monthKey, n) {
  const idx = monthIndex(monthKey) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
}

/* ---------- Estado de mes seleccionado ---------- */
let selectedMonth = todayMonthKey();

/* ---------- Cálculos ---------- */

function incomesForMonth(monthKey) {
  return state.incomes.filter((i) => i.recurring || monthKeyFromDate(i.date) === monthKey);
}

function expensesForMonth(monthKey) {
  return state.expenses.filter((e) => monthKeyFromDate(e.date) === monthKey);
}

function installmentsForMonth(monthKey) {
  const result = [];
  state.installments.forEach((p) => {
    const startIdx = monthIndex(p.startMonth);
    const targetIdx = monthIndex(monthKey);
    const cuotaNumber = targetIdx - startIdx + 1;
    if (cuotaNumber >= 1 && cuotaNumber <= p.cuotas) {
      result.push({ ...p, cuotaNumber });
    }
  });
  return result;
}

function fixedTotal() {
  return state.fixed.reduce((sum, f) => sum + Number(f.amount), 0);
}

function cardName(cardId) {
  const c = state.cards.find((c) => c.id === cardId);
  return c ? c.name : "Tarjeta eliminada";
}

/* ---------- Render: Dashboard ---------- */

function renderDashboard() {
  const incomes = incomesForMonth(selectedMonth);
  const expenses = expensesForMonth(selectedMonth);
  const installments = installmentsForMonth(selectedMonth);
  const fixed = state.fixed;

  const totalIncome = incomes.reduce((s, i) => s + Number(i.amount), 0);
  const totalExpenseVariable = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const totalFixed = fixedTotal();
  const totalCuotas = installments.reduce((s, p) => s + Number(p.cuotaAmount), 0);
  const totalExpense = totalExpenseVariable + totalFixed + totalCuotas;
  const balance = totalIncome - totalExpense;

  document.getElementById("statIncome").textContent = formatCurrency(totalIncome);
  document.getElementById("statExpense").textContent = formatCurrency(totalExpense);

  const balanceEl = document.getElementById("statBalance");
  balanceEl.textContent = formatCurrency(balance);
  balanceEl.classList.toggle("positive", balance >= 0);
  balanceEl.classList.toggle("negative", balance < 0);

  document.getElementById("bdVariable").textContent = formatCurrency(totalExpenseVariable);
  document.getElementById("bdFixed").textContent = formatCurrency(totalFixed);
  document.getElementById("bdCuotas").textContent = formatCurrency(totalCuotas);

  const upcoming = [];
  fixed.forEach((f) => upcoming.push({ desc: f.desc, amount: f.amount, day: f.day, type: "Cuenta fija" }));
  installments.forEach((p) => {
    const card = state.cards.find((c) => c.id === p.cardId);
    upcoming.push({
      desc: `${p.desc} (cuota ${p.cuotaNumber}/${p.cuotas})`,
      amount: p.cuotaAmount,
      day: card ? card.dueDay : null,
      type: card ? card.name : "Tarjeta",
    });
  });
  upcoming.sort((a, b) => (a.day || 99) - (b.day || 99));

  const list = document.getElementById("upcomingList");
  list.innerHTML = "";
  if (upcoming.length === 0) {
    list.innerHTML = '<li class="empty-msg">No hay vencimientos cargados para este mes.</li>';
  } else {
    upcoming.forEach((u) => {
      const li = document.createElement("li");
      li.className = "list-item";
      li.innerHTML = `
        <div class="item-main">
          <span class="item-title">${escapeHtml(u.desc)}</span>
          <span class="item-sub">${escapeHtml(u.type)}${u.day ? ` · vence el día ${u.day}` : ""}</span>
        </div>
        <div class="item-right">
          <span class="item-amount expense">${formatCurrency(u.amount)}</span>
        </div>`;
      list.appendChild(li);
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ---------- Render: Ingresos ---------- */

function renderIngresos() {
  const ul = document.getElementById("listaIngresos");
  ul.innerHTML = "";
  const items = [...state.incomes].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (items.length === 0) {
    ul.innerHTML = '<li class="empty-msg">Todavía no cargaste ingresos.</li>';
    return;
  }
  items.forEach((i) => {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="item-main">
        <span class="item-title">${escapeHtml(i.desc)}</span>
        <span class="item-sub">${i.date} ${i.recurring ? "· Recurrente cada mes" : ""}</span>
      </div>
      <div class="item-right">
        <span class="item-amount income">+${formatCurrency(i.amount)}</span>
        <button class="delete-btn" data-action="del-income" data-id="${i.id}" title="Eliminar">✕</button>
      </div>`;
    ul.appendChild(li);
  });
}

/* ---------- Render: Gastos ---------- */

function renderGastos() {
  const ul = document.getElementById("listaGastos");
  ul.innerHTML = "";
  const items = [...state.expenses].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (items.length === 0) {
    ul.innerHTML = '<li class="empty-msg">Todavía no cargaste gastos.</li>';
    return;
  }
  items.forEach((e) => {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="item-main">
        <span class="item-title">${escapeHtml(e.desc)}</span>
        <span class="item-sub">${e.date} · ${escapeHtml(e.category)}</span>
      </div>
      <div class="item-right">
        <span class="item-amount expense">-${formatCurrency(e.amount)}</span>
        <button class="delete-btn" data-action="del-expense" data-id="${e.id}" title="Eliminar">✕</button>
      </div>`;
    ul.appendChild(li);
  });
}

/* ---------- Render: Tarjetas ---------- */

function renderTarjetas() {
  const ul = document.getElementById("listaTarjetas");
  ul.innerHTML = "";
  if (state.cards.length === 0) {
    ul.innerHTML = '<li class="empty-msg">Todavía no agregaste tarjetas.</li>';
  } else {
    state.cards.forEach((c) => {
      const li = document.createElement("li");
      li.className = "list-item";
      const details = [];
      if (c.closingDay) details.push(`cierre día ${c.closingDay}`);
      if (c.dueDay) details.push(`vencimiento día ${c.dueDay}`);
      if (c.limit) details.push(`límite ${formatCurrency(c.limit)}`);
      li.innerHTML = `
        <div class="item-main">
          <span class="item-title">${escapeHtml(c.name)}</span>
          <span class="item-sub">${escapeHtml(details.join(" · "))}</span>
        </div>
        <div class="item-right">
          <button class="delete-btn" data-action="del-card" data-id="${c.id}" title="Eliminar">✕</button>
        </div>`;
      ul.appendChild(li);
    });
  }

  const select = document.getElementById("cuotaTarjeta");
  select.innerHTML = "";
  if (state.cards.length === 0) {
    select.innerHTML = '<option value="">Agregá una tarjeta primero</option>';
  } else {
    state.cards.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      select.appendChild(opt);
    });
  }

  const ulCuotas = document.getElementById("listaCuotas");
  ulCuotas.innerHTML = "";
  if (state.installments.length === 0) {
    ulCuotas.innerHTML = '<li class="empty-msg">Todavía no cargaste compras en cuotas.</li>';
    return;
  }
  [...state.installments]
    .sort((a, b) => b.startMonth.localeCompare(a.startMonth))
    .forEach((p) => {
      const idxNow = monthIndex(selectedMonth) - monthIndex(p.startMonth) + 1;
      const paid = Math.min(Math.max(idxNow, 0), p.cuotas);
      const pct = Math.round((paid / p.cuotas) * 100);
      const li = document.createElement("li");
      li.className = "list-item";
      li.innerHTML = `
        <div class="item-main">
          <span class="item-title">${escapeHtml(p.desc)} — ${escapeHtml(cardName(p.cardId))}</span>
          <span class="item-sub">${p.cuotas} cuotas de ${formatCurrency(p.cuotaAmount)} desde ${monthLabel(p.startMonth)} · pagadas ${paid}/${p.cuotas}</span>
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="item-right">
          <span class="item-amount expense">${formatCurrency(p.totalAmount)}</span>
          <button class="delete-btn" data-action="del-installment" data-id="${p.id}" title="Eliminar">✕</button>
        </div>`;
      ulCuotas.appendChild(li);
    });
}

/* ---------- Render: Cuentas Fijas ---------- */

function renderFijas() {
  const ul = document.getElementById("listaFijas");
  ul.innerHTML = "";
  if (state.fixed.length === 0) {
    ul.innerHTML = '<li class="empty-msg">Todavía no cargaste cuentas fijas.</li>';
    return;
  }
  [...state.fixed]
    .sort((a, b) => a.day - b.day)
    .forEach((f) => {
      const li = document.createElement("li");
      li.className = "list-item";
      li.innerHTML = `
        <div class="item-main">
          <span class="item-title">${escapeHtml(f.desc)}</span>
          <span class="item-sub">Vence el día ${f.day} de cada mes</span>
        </div>
        <div class="item-right">
          <span class="item-amount expense">-${formatCurrency(f.amount)}</span>
          <button class="delete-btn" data-action="del-fixed" data-id="${f.id}" title="Eliminar">✕</button>
        </div>`;
      ul.appendChild(li);
    });
}

/* ---------- Render general ---------- */

function renderAll() {
  renderDashboard();
  renderIngresos();
  renderGastos();
  renderTarjetas();
  renderFijas();
}

/* ---------- Tabs ---------- */

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

/* ---------- Selector de mes ---------- */

const monthInput = document.getElementById("monthInput");
monthInput.value = selectedMonth;
monthInput.addEventListener("change", () => {
  if (monthInput.value) {
    selectedMonth = monthInput.value;
    renderAll();
  }
});

/* ---------- Formularios ---------- */

document.getElementById("formIngreso").addEventListener("submit", (e) => {
  e.preventDefault();
  state.incomes.push({
    id: uid(),
    desc: document.getElementById("ingresoDesc").value.trim(),
    amount: parseFloat(document.getElementById("ingresoMonto").value),
    date: document.getElementById("ingresoFecha").value,
    recurring: document.getElementById("ingresoRecurrente").checked,
  });
  saveState();
  e.target.reset();
  renderAll();
});

document.getElementById("formGasto").addEventListener("submit", (e) => {
  e.preventDefault();
  state.expenses.push({
    id: uid(),
    desc: document.getElementById("gastoDesc").value.trim(),
    amount: parseFloat(document.getElementById("gastoMonto").value),
    date: document.getElementById("gastoFecha").value,
    category: document.getElementById("gastoCategoria").value,
  });
  saveState();
  e.target.reset();
  renderAll();
});

document.getElementById("formTarjeta").addEventListener("submit", (e) => {
  e.preventDefault();
  state.cards.push({
    id: uid(),
    name: document.getElementById("tarjetaNombre").value.trim(),
    limit: parseFloat(document.getElementById("tarjetaLimite").value) || 0,
    closingDay: parseInt(document.getElementById("tarjetaCierre").value) || null,
    dueDay: parseInt(document.getElementById("tarjetaVencimiento").value) || null,
  });
  saveState();
  e.target.reset();
  renderAll();
});

document.getElementById("formCuota").addEventListener("submit", (e) => {
  e.preventDefault();
  const cardId = document.getElementById("cuotaTarjeta").value;
  if (!cardId) return;
  const totalAmount = parseFloat(document.getElementById("cuotaMontoTotal").value);
  const cuotas = parseInt(document.getElementById("cuotaCantidad").value);
  state.installments.push({
    id: uid(),
    cardId,
    desc: document.getElementById("cuotaDesc").value.trim(),
    totalAmount,
    cuotas,
    cuotaAmount: totalAmount / cuotas,
    startMonth: document.getElementById("cuotaInicio").value,
  });
  saveState();
  e.target.reset();
  renderAll();
});

document.getElementById("formFija").addEventListener("submit", (e) => {
  e.preventDefault();
  state.fixed.push({
    id: uid(),
    desc: document.getElementById("fijaDesc").value.trim(),
    amount: parseFloat(document.getElementById("fijaMonto").value),
    day: parseInt(document.getElementById("fijaDia").value),
  });
  saveState();
  e.target.reset();
  renderAll();
});

/* ---------- Borrado (delegado) ---------- */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  switch (action) {
    case "del-income":
      state.incomes = state.incomes.filter((i) => i.id !== id);
      break;
    case "del-expense":
      state.expenses = state.expenses.filter((x) => x.id !== id);
      break;
    case "del-card":
      state.cards = state.cards.filter((c) => c.id !== id);
      state.installments = state.installments.filter((p) => p.cardId !== id);
      break;
    case "del-installment":
      state.installments = state.installments.filter((p) => p.id !== id);
      break;
    case "del-fixed":
      state.fixed = state.fixed.filter((f) => f.id !== id);
      break;
    default:
      return;
  }
  saveState();
  renderAll();
});

/* ---------- Init ---------- */

document.getElementById("ingresoFecha").valueAsDate = new Date();
document.getElementById("gastoFecha").valueAsDate = new Date();
document.getElementById("cuotaInicio").value = selectedMonth;

renderAll();
