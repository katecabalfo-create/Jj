# Maldonado Oportunidades — Control de Entradas y Gastos

Aplicación web simple para registrar y controlar las entradas (ingresos) y gastos de Maldonado Oportunidades.

## Funcionalidades

- Registrar transacciones de tipo **Entrada** o **Gasto**, con fecha, categoría, descripción y monto.
- Ver el historial completo con filtros por tipo, categoría, mes y texto de búsqueda.
- Editar o eliminar transacciones existentes.
- Totales automáticos de entradas, gastos y balance.
- Resumen mensual con comparación visual de entradas vs. gastos.
- Exportar el historial (filtrado) a CSV.
- Los datos se guardan localmente en el navegador (`localStorage`), sin necesidad de servidor ni conexión a internet.

## Uso

Abrí `index.html` directamente en el navegador, o servilo con cualquier servidor estático, por ejemplo:

```bash
python3 -m http.server 8000
```

y luego entrá a `http://localhost:8000`.

## Estructura

```
index.html      # Estructura de la aplicación
css/styles.css  # Estilos
js/app.js       # Lógica de la aplicación (sin dependencias externas)
```
