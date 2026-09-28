'use strict';

// Secciones del sitio, en el orden en que aparecen las pestañas.
const CATEGORIES = [
  { id: 'empleo-maldonado', label: 'Empleo Maldonado', short: 'Empleo MDO', group: 'Ofertas de empleo', region: 'maldonado', subtypes: ['Tiempo completo', 'Medio horario', 'Zafral / temporada', 'Por horas', 'Pasantía'], hasPrice: true, priceLabel: 'Sueldo', icon: '💼' },
  { id: 'empleo-pais', label: 'Empleo resto del país', short: 'Empleo país', group: 'Ofertas de empleo', region: 'pais', subtypes: ['Tiempo completo', 'Medio horario', 'Zafral / temporada', 'Por horas', 'Pasantía'], hasPrice: true, priceLabel: 'Sueldo', icon: '🧳' },
  { id: 'alquileres', label: 'Alquileres', short: 'Alquileres', group: 'Alquileres', region: 'maldonado', subtypes: ['Anual', 'Temporada', 'Por día / fin de semana', 'Habitación', 'Local comercial'], hasPrice: true, priceLabel: 'Precio', icon: '🏠' },
  { id: 'avisos-maldonado', label: 'Avisos Maldonado', short: 'Avisos MDO', group: 'Avisos publicitarios', region: 'maldonado', subtypes: ['Servicios', 'Venta', 'Compra', 'Vehículos', 'Inmuebles en venta', 'Otros'], hasPrice: true, priceLabel: 'Precio', icon: '📣' },
  { id: 'avisos-pais', label: 'Avisos resto del país', short: 'Avisos país', group: 'Avisos publicitarios', region: 'pais', subtypes: ['Servicios', 'Venta', 'Compra', 'Vehículos', 'Inmuebles en venta', 'Otros'], hasPrice: true, priceLabel: 'Precio', icon: '📢' },
  { id: 'noticias', label: 'Noticias', short: 'Noticias', group: 'Noticias', region: 'maldonado', subtypes: ['Locales', 'Nacionales', 'Economía', 'Turismo', 'Deportes', 'Cultura'], hasPrice: false, icon: '📰' },
  { id: 'eventos', label: 'Eventos', short: 'Eventos', group: 'Eventos', region: 'maldonado', subtypes: ['Música', 'Gastronomía', 'Deportes', 'Ferias', 'Cultura', 'Infantiles'], hasPrice: true, priceLabel: 'Entrada', hasEventDate: true, icon: '🎉' },
];

const MALDONADO_LOCALITIES = [
  'Maldonado', 'Punta del Este', 'San Carlos', 'Piriápolis', 'Pan de Azúcar', 'Aiguá',
  'La Barra', 'Manantiales', 'José Ignacio', 'Punta Ballena', 'Solís', 'Las Flores',
  'Playa Verde', 'Garzón', 'Cerro Pelado', 'Balneario Buenos Aires', 'Ocean Park', 'Sauce de Portezuelo',
];

const DEPARTMENTS = [
  'Artigas', 'Canelones', 'Cerro Largo', 'Colonia', 'Durazno', 'Flores', 'Florida', 'Lavalleja',
  'Maldonado', 'Montevideo', 'Paysandú', 'Río Negro', 'Rivera', 'Rocha', 'Salto', 'San José',
  'Soriano', 'Tacuarembó', 'Treinta y Tres',
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Tipos de cuenta de anunciante y las secciones donde puede publicar cada uno.
const ACCOUNT_TYPES = [
  {
    id: 'empresa',
    label: 'Empresas',
    panel: 'Panel de Empresas',
    icon: '🏢',
    pitch: 'Publicá ofertas de empleo, avisos publicitarios y eventos de tu empresa.',
    businessLabel: 'Razón social / nombre comercial',
    categories: ['empleo-maldonado', 'empleo-pais', 'avisos-maldonado', 'avisos-pais', 'eventos'],
  },
  {
    id: 'servicios',
    label: 'Servicios',
    panel: 'Panel de Servicios',
    icon: '🛠️',
    pitch: 'Ofrecé tus servicios: plomería, jardinería, clases, fletes, limpieza y más.',
    businessLabel: 'Nombre profesional o del emprendimiento',
    categories: ['avisos-maldonado', 'avisos-pais'],
  },
  {
    id: 'alquileres',
    label: 'Alquileres',
    panel: 'Panel de Alquileres',
    icon: '🏠',
    pitch: 'Para propietarios e inmobiliarias: publicá alquileres anuales y de temporada.',
    businessLabel: 'Inmobiliaria (opcional)',
    categories: ['alquileres'],
  },
];
const ACCOUNT_TYPE_IDS = ACCOUNT_TYPES.map((t) => t.id);
const getAccountType = (id) => ACCOUNT_TYPES.find((t) => t.id === id) || null;

function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

function locationsFor(categoryId) {
  const cat = getCategory(categoryId);
  if (!cat) return [];
  return cat.region === 'pais' ? DEPARTMENTS.filter((d) => d !== 'Maldonado') : MALDONADO_LOCALITIES;
}

module.exports = { ACCOUNT_TYPES, ACCOUNT_TYPE_IDS, getAccountType, CATEGORIES, CATEGORY_IDS, MALDONADO_LOCALITIES, DEPARTMENTS, getCategory, locationsFor };
