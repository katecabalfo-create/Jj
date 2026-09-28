'use strict';

const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { seedIfEmpty } = require('./src/seed');
const { buildDigests, flushOutbox } = require('./src/notify');
const { usingDefaultPassword } = require('./src/auth');

const db = openDb();
const seeded = seedIfEmpty(db);
if (seeded) console.log(`Se cargaron ${seeded} avisos de ejemplo.`);

const app = createApp(db);
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Maldonado Oportunidades escuchando en http://localhost:${port}`);
  console.log(`Panel de administración: http://localhost:${port}/admin/`);
  if (usingDefaultPassword()) console.warn('ATENCIÓN: definí ADMIN_PASSWORD; la contraseña por defecto es "admin".');
});

// Cada 5 minutos: arma resúmenes diarios/semanales y envía los correos en cola.
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
setInterval(async () => {
  try {
    buildDigests(db, baseUrl);
    await flushOutbox(db);
  } catch (err) {
    console.error('Error enviando notificaciones:', err);
  }
}, 5 * 60 * 1000).unref();
