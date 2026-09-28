const posts = [
  { cat: "tech", emoji: "🤖", color: "#dbeafe", title: "La IA que organiza tu semana", text: "Probamos las nuevas apps de productividad que todo el mundo está recomendando.", time: "5 min", likes: 342 },
  { cat: "cultura", emoji: "🎧", color: "#fce7f3", title: "El álbum sorpresa del viernes", text: "Un lanzamiento sin aviso que ya rompe récords de reproducciones.", time: "3 min", likes: 518 },
  { cat: "deportes", emoji: "🏆", color: "#dcfce7", title: "Remontada histórica en la final", text: "Los mejores momentos y reacciones de un partido para el recuerdo.", time: "4 min", likes: 901 },
  { cat: "lifestyle", emoji: "🍜", color: "#fef3c7", title: "Ramen casero en 20 minutos", text: "La receta viral que está llenando los feeds de todo el mundo.", time: "6 min", likes: 276 },
  { cat: "tech", emoji: "📱", color: "#e0e7ff", title: "Gadgets que valen la pena este año", text: "Una lista honesta: lo que sí compraríamos y lo que no.", time: "7 min", likes: 188 },
  { cat: "cultura", emoji: "🎬", color: "#ede9fe", title: "La serie de la que todos hablan", text: "Sin spoilers: por qué engancha y dónde verla.", time: "4 min", likes: 433 },
  { cat: "lifestyle", emoji: "✈️", color: "#cffafe", title: "Escapadas de fin de semana baratas", text: "Cinco destinos cercanos para desconectar sin gastar de más.", time: "5 min", likes: 207 },
  { cat: "deportes", emoji: "🏃", color: "#ffedd5", title: "El reto de correr 5K en un mes", text: "Plan paso a paso para empezar desde cero.", time: "3 min", likes: 159 },
  { cat: "tech", emoji: "🎮", color: "#f3e8ff", title: "Los estrenos gamer del mes", text: "Lo más esperado y las joyas indie que no te puedes perder.", time: "5 min", likes: 364 },
];

const labels = { tech: "Tech", cultura: "Cultura", deportes: "Deportes", lifestyle: "Lifestyle" };
const grid = document.getElementById("postGrid");

function render(filter) {
  grid.innerHTML = "";
  posts
    .filter(p => filter === "all" || p.cat === filter)
    .forEach(p => {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `
        <div class="card-cover" style="background:${p.color}">${p.emoji}</div>
        <div class="card-body">
          <span class="card-tag">${labels[p.cat]}</span>
          <h3>${p.title}</h3>
          <p>${p.text}</p>
          <div class="card-meta">
            <span>⏱ ${p.time}</span>
            <button class="like${p.liked ? " liked" : ""}" aria-pressed="${!!p.liked}">♥ ${p.likes}</button>
          </div>
        </div>`;
      card.querySelector(".like").addEventListener("click", e => {
        p.liked = !p.liked;
        p.likes += p.liked ? 1 : -1;
        e.currentTarget.classList.toggle("liked", p.liked);
        e.currentTarget.setAttribute("aria-pressed", p.liked);
        e.currentTarget.textContent = `♥ ${p.likes}`;
      });
      grid.appendChild(card);
    });
}

function setFilter(filter) {
  document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === filter));
  render(filter);
}

document.getElementById("filters").addEventListener("click", e => {
  if (e.target.matches(".chip")) setFilter(e.target.dataset.filter);
});
document.querySelectorAll("[data-go]").forEach(a => a.addEventListener("click", () => setFilter(a.dataset.go)));

// Menú móvil
const navLinks = document.getElementById("navLinks");
document.getElementById("menuBtn").addEventListener("click", () => navLinks.classList.toggle("open"));
navLinks.addEventListener("click", e => { if (e.target.tagName === "A") navLinks.classList.remove("open"); });

// Tema claro/oscuro
const root = document.documentElement;
try {
  const saved = localStorage.getItem("theme");
  if (saved) root.dataset.theme = saved;
} catch (_) {}
document.getElementById("themeToggle").addEventListener("click", () => {
  const isDark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = isDark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch (_) {}
});

// Contadores animados
document.querySelectorAll("[data-count]").forEach(el => {
  const target = +el.dataset.count;
  const start = performance.now();
  const step = now => {
    const t = Math.min((now - start) / 1200, 1);
    el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});

// Newsletter
document.getElementById("newsForm").addEventListener("submit", e => {
  e.preventDefault();
  document.getElementById("formMsg").textContent = "¡Listo! Revisa tu correo para confirmar la suscripción. 🐝";
  e.target.reset();
});

document.getElementById("year").textContent = new Date().getFullYear();
render("all");
