# Maldonado Oportunidades

Sitio de clasificados para Maldonado y todo Uruguay, pensado para el celular y listo para Google AdSense.

**Secciones (pestañas, en este orden):**

1. 💼 Empleo Maldonado
2. 🧳 Empleo resto del país
3. 🏠 Alquileres
4. 📣 Avisos Maldonado
5. 📢 Avisos resto del país
6. 📰 Noticias
7. 🎉 Eventos

## Funciones

- **Diseño mobile-first**: pestañas deslizables, filtros en panel inferior, botón flotante "Publicar", botones de llamar/WhatsApp, modo oscuro automático e instalable como app (PWA).
- **Búsqueda y filtros**: texto libre, ubicación (localidades de Maldonado o departamentos), tipo (tiempo completo, temporada, anual…), rango de precio/sueldo, moneda, fecha de publicación, solo con foto, solo destacados, próximos eventos.
- **Orden y paginación**: destacados primero, más recientes, más antiguos, precio ↑/↓, más vistos, fecha del evento, título.
- **Formulario de carga** (`#/publicar`): con foto (hasta 5 MB), validación, anti-spam (honeypot + límite por IP) y moderación previa.
- **Notificaciones** (`#/alertas`): el público elige secciones, palabras clave, zona y frecuencia (al instante, diario o semanal). Cada email trae enlace para modificar o darse de baja.
- **Panel de administración** (`/admin/`): resumen con estadísticas, cola de pendientes, aprobar/rechazar/destacar/eliminar (uno por uno o en lote), crear y editar avisos, fecha de vencimiento, suscriptores, historial de emails y ajustes.
- **Google AdSense**: se configura desde el panel (sin tocar código). Bloque superior, anuncios entre avisos cada N publicaciones y en el detalle; `ads.txt` automático; compatible con anuncios automáticos. Incluye páginas de privacidad/cookies y condiciones, que AdSense exige.
- **SEO**: `sitemap.xml`, `robots.txt`, enlaces compartibles `/aviso/123` con Open Graph.

## Cómo ejecutarlo

Requiere **Node.js 22.13 o superior** (usa la base SQLite incluida en Node; no hace falta instalar una base de datos).

```bash
npm install
cp .env.example .env        # editá los valores
ADMIN_PASSWORD=tu-clave npm start
```

- Sitio: http://localhost:3000
- Panel: http://localhost:3000/admin/ (contraseña = `ADMIN_PASSWORD`; si no la definís es `admin`)

La primera vez se cargan unos avisos de ejemplo para ver el sitio funcionando; borralos desde el panel o arrancá con `SEED=0`.

### Con Docker

```bash
docker build -t maldonado-oportunidades .
docker run -d -p 3000:3000 -e ADMIN_PASSWORD=tu-clave -e BASE_URL=https://tudominio.com \
  -v mo-data:/app/data -v mo-uploads:/app/uploads maldonado-oportunidades
```

Sirve en cualquier hosting con Node o Docker (Railway, Render, Fly.io, un VPS…). Asegurate de que las carpetas `data/` y `uploads/` sean persistentes.

## Activar Google AdSense

1. Publicá el sitio en tu dominio (AdSense no aprueba `localhost` ni subdominios gratuitos de algunos hostings).
2. Creá la cuenta en https://adsense.google.com y agregá el sitio.
3. En el panel → **Ajustes y AdSense**: marcá "Activar anuncios" y pegá tu ID `ca-pub-XXXXXXXXXXXXXXXX`. Con eso se carga el script de verificación y se genera `/ads.txt`.
4. Cuando Google apruebe el sitio, creá bloques de anuncios **Display** y pegá sus IDs (`data-ad-slot`) en los campos de bloque superior, entre avisos y detalle. También podés activar los "Anuncios automáticos" desde AdSense.

## Configurar el envío de emails (alertas)

Definí `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM` (sirve Gmail con contraseña de aplicación, Brevo, Mailgun, Amazon SES, etc.). El servidor envía la cola cada 5 minutos; desde **Panel → Notificaciones** podés mandar un email de prueba o procesar la cola al momento. Sin SMTP, los emails quedan guardados en cola y visibles en el panel.

## Estructura

```
server.js            arranque, tareas periódicas de envío
src/app.js           rutas web y API (pública y de administración)
src/listings.js      búsqueda, filtros, orden, paginación y validación
src/notify.js        alertas por email y resúmenes
src/db.js            esquema SQLite y ajustes
src/categories.js    secciones, localidades y departamentos
public/              sitio público (HTML/CSS/JS sin frameworks)
public/admin/        panel de administración
test/                pruebas (npm test)
```

Para agregar o cambiar secciones, localidades o tipos, editá `src/categories.js`.
