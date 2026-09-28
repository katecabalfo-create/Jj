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

## Paneles para anunciantes y cobros

Además del panel de administración hay un **panel para anunciantes** en `/cuenta/`, con tres tipos de cuenta. Cada uno ve su propio panel y solo puede publicar en sus secciones:

| Cuenta | Panel | Puede publicar en |
|---|---|---|
| 🏢 Empresas | Panel de Empresas | Empleo Maldonado, Empleo resto del país, Avisos Maldonado, Avisos resto del país, Eventos |
| 🛠️ Servicios | Panel de Servicios | Avisos Maldonado, Avisos resto del país |
| 🏠 Alquileres (propietarios e inmobiliarias) | Panel de Alquileres | Alquileres |

Desde su panel cada anunciante puede:

- Registrarse, ingresar y recuperar la contraseña por email.
- Cargar avisos con foto (paso 1) y elegir plan y medio de pago (paso 2). El aviso se publica apenas se confirma el pago.
- Ver sus avisos con su estado (falta pagar, en revisión, publicado, pausado, vencido, rechazado), visitas y fecha de vencimiento.
- Editar, pausar/reactivar, renovar (los días se suman al vencimiento actual) y eliminar.
- Ver el historial de pagos y editar su perfil, que se muestra en su página pública (`/#/anunciante/ID`) con todos sus avisos.

**Medios de pago:**

- **Mercado Pago** (tarjetas, Abitab, Redpagos): se activa con `MP_ACCESS_TOKEN`. El anunciante paga en el sitio seguro de Mercado Pago y el pago se confirma automáticamente por webhook (`/api/payments/mercadopago/webhook`). Siempre se consulta el pago a la API de Mercado Pago y se verifica monto y moneda antes de publicar.
- **Transferencia bancaria a Itaú**: en **Admin → Ajustes** cargás tu cuenta Itaú en pesos y/o dólares, el tipo de cuenta (caja de ahorro o cuenta corriente), el titular y su RUT o CI. El anunciante ve una ficha con esos datos, el monto exacto y la referencia "Pago N", cada uno con botón **Copiar**. Transfiere desde Itaú o desde cualquier otro banco y **sube el comprobante** (imagen o PDF) desde su panel. Te llega un email, ves el comprobante en **Admin → Pagos**, tocás **Confirmar** y el aviso se publica solo. Los comprobantes se guardan fuera de la carpeta pública (`data/receipts/`) y solo los ven el anunciante y el administrador. La transferencia se ofrece únicamente para los planes cuya moneda tenga una cuenta cargada.

**En el panel de administración** se suman: **Anunciantes** (buscar, verificar con ✔️, suspender o eliminar cuentas), **Pagos** (ingresos, confirmar o rechazar transferencias, consultar Mercado Pago) y **Planes y precios** (crear o editar planes por tipo de cuenta: precio, moneda, días y si es destacado).

Los precios iniciales son ejemplos ($ 490 / $ 990 empresas, $ 290 / $ 590 servicios, $ 390 / $ 790 alquileres, por 30 días). Cambialos en **Admin → Planes y precios**.

La publicación gratuita sin cuenta queda desactivada. Si la querés, activala en **Admin → Ajustes**.

### Configurar Mercado Pago

1. Entrá a https://www.mercadopago.com.uy/developers → **Tus integraciones** → creá una aplicación (tipo "Pagos online", producto **Checkout Pro**).
2. Copiá el **Access Token de producción** en `MP_ACCESS_TOKEN`. Para probar, usá las credenciales de prueba con `MP_USE_SANDBOX=1`.
3. En **Webhooks**, configurá la URL `https://TU-DOMINIO/api/payments/mercadopago/webhook` con el evento **Pagos**, y copiá la clave secreta en `MP_WEBHOOK_SECRET`.
4. `BASE_URL` tiene que ser tu dominio con `https://`, para que Mercado Pago pueda avisar y devolver al anunciante a su panel.

Para probar todo el recorrido sin cobrar, arrancá con `PAYMENTS_DEMO=1`: aparece un "pago de prueba" que aprueba al instante. No lo dejes activo en producción.

## Cómo ejecutarlo

Requiere **Node.js 22.13 o superior** (usa la base SQLite incluida en Node; no hace falta instalar una base de datos).

```bash
npm install
cp .env.example .env        # editá los valores
ADMIN_PASSWORD=tu-clave npm start
```

- Sitio: http://localhost:3000
- Panel de administración: http://localhost:3000/admin/ (contraseña = `ADMIN_PASSWORD`; si no la definís es `admin`)
- Panel de anunciantes: http://localhost:3000/cuenta/

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
src/account.js       API de cuentas de anunciantes (registro, avisos propios, pagos)
src/payments.js      Mercado Pago, transferencias y aplicación de pagos
src/db.js            esquema SQLite y ajustes
src/categories.js    secciones, localidades y departamentos
public/              sitio público (HTML/CSS/JS sin frameworks)
public/admin/        panel de administración
public/cuenta/       panel de anunciantes (Empresas, Servicios, Alquileres)
test/                pruebas (npm test)
```

Para agregar o cambiar secciones, localidades o tipos, editá `src/categories.js`.
