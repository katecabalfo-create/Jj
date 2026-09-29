'use strict';

const { insertListing } = require('./listings');

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// Avisos de ejemplo para que el sitio no arranque vacío. Se pueden borrar desde el panel.
const SAMPLES = [
  { category: 'empleo-maldonado', title: 'Mozo/a para restaurante en Punta del Este', subtype: 'Zafral / temporada', location: 'Punta del Este', price: 45000, currency: 'UYU', company: 'Restaurante La Rambla (ejemplo)', description: 'Buscamos mozos y mozas con experiencia para la temporada de verano. Horario rotativo, buen ambiente de trabajo y propinas. Enviar CV por email.', contact_email: 'empleo@example.com', featured: 1 },
  { category: 'empleo-maldonado', title: 'Recepcionista bilingüe para hotel', subtype: 'Tiempo completo', location: 'Maldonado', price: 38000, currency: 'UYU', company: 'Hotel Centro (ejemplo)', description: 'Se requiere recepcionista con inglés fluido, manejo de sistemas de reservas y disponibilidad para turnos rotativos.', contact_phone: '099 000 001' },
  { category: 'empleo-maldonado', title: 'Ayudante de cocina en San Carlos', subtype: 'Medio horario', location: 'San Carlos', price: 22000, currency: 'UYU', description: 'Parrillada familiar busca ayudante de cocina para turno noche de jueves a domingo. No se requiere experiencia.', contact_phone: '099 000 002' },
  { category: 'empleo-pais', title: 'Vendedor/a comercial zona Montevideo', subtype: 'Tiempo completo', location: 'Montevideo', price: 42000, currency: 'UYU', company: 'Distribuidora (ejemplo)', description: 'Empresa distribuidora busca vendedor con libreta de conducir y experiencia en ventas mayoristas. Sueldo fijo más comisiones.', contact_email: 'rrhh@example.com' },
  { category: 'empleo-pais', title: 'Peón rural para establecimiento ganadero', subtype: 'Tiempo completo', location: 'Tacuarembó', description: 'Se busca peón rural con experiencia en manejo de ganado. Vivienda en el establecimiento.', contact_phone: '099 000 003' },
  { category: 'alquileres', title: 'Apartamento 2 dormitorios cerca de la playa', subtype: 'Anual', location: 'Maldonado', price: 22000, currency: 'UYU', description: 'Apartamento de 2 dormitorios, living comedor, cocina equipada, garaje. A 4 cuadras de la playa. Contrato anual con garantía ANDA o depósito.', contact_phone: '099 000 004', featured: 1 },
  { category: 'alquileres', title: 'Casa para temporada en La Barra', subtype: 'Temporada', location: 'La Barra', price: 3500, currency: 'USD', description: 'Casa de 3 dormitorios con piscina y parrillero, capacidad 6 personas. Disponible enero y febrero, por quincena.', contact_email: 'labarra@example.com' },
  { category: 'alquileres', title: 'Monoambiente en Piriápolis', subtype: 'Anual', location: 'Piriápolis', price: 14000, currency: 'UYU', description: 'Monoambiente luminoso sobre la rambla, ideal para una persona. Gastos comunes incluidos.', contact_phone: '099 000 005' },
  { category: 'avisos-maldonado', title: 'Jardinería y mantenimiento de piscinas', subtype: 'Servicios', location: 'Punta del Este', description: 'Corte de pasto, poda, limpieza y mantenimiento de piscinas. Presupuestos sin cargo. Zona Punta del Este, Maldonado y La Barra.', contact_phone: '099 000 006' },
  { category: 'avisos-maldonado', title: 'Vendo bicicleta rodado 29', subtype: 'Venta', location: 'Maldonado', price: 9000, currency: 'UYU', description: 'Bicicleta de montaña rodado 29, cambios Shimano, frenos a disco. Muy buen estado.', contact_phone: '099 000 007' },
  { category: 'avisos-pais', title: 'Fletes y mudanzas a todo el país', subtype: 'Servicios', location: 'Canelones', description: 'Fletes, mudanzas y traslados a todo Uruguay. Camión con caja cerrada, personal con experiencia.', contact_phone: '099 000 008' },
  { category: 'noticias', title: 'Comienza la temporada de cruceros en Punta del Este', subtype: 'Turismo', location: 'Punta del Este', description: 'La temporada de cruceros arranca con el arribo de los primeros buques. Se espera un movimiento importante para el comercio local y los servicios turísticos del departamento.' },
  { category: 'noticias', title: 'Nuevos cursos gratuitos de capacitación laboral', subtype: 'Locales', location: 'Maldonado', description: 'Se abren inscripciones para cursos gratuitos de gastronomía, hotelería e informática orientados a mejorar las oportunidades de empleo en la temporada.' },
  { category: 'eventos', title: 'Feria gastronómica de fin de semana', subtype: 'Gastronomía', location: 'San Carlos', price: 0, currency: 'UYU', event_date: day(12), description: 'Productores locales, food trucks y música en vivo en la plaza principal. Entrada libre.' },
  { category: 'eventos', title: 'Concierto al atardecer en Punta Ballena', subtype: 'Música', location: 'Punta Ballena', price: 800, currency: 'UYU', event_date: day(20), description: 'Concierto acústico al aire libre con artistas locales. Traer reposera y abrigo.', website: 'https://example.com' },
];

function seedIfEmpty(db) {
  if (process.env.SEED === '0') return 0;
  const n = db.prepare('SELECT COUNT(*) n FROM listings').get().n;
  if (n > 0) return 0;
  SAMPLES.forEach((s, i) => {
    const { featured = 0, ...data } = s;
    insertListing(db, data, { status: 'approved', featured, published_at: ago(i * 5 + 1), notified: 1 });
  });
  return SAMPLES.length;
}

module.exports = { seedIfEmpty };
