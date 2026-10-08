# pb-backend — API REST Puertas Blindadas

## Requisitos
- Node.js 18+
- PostgreSQL con el schema `inventario` cargado

## Setup

```bash
# 1. Instalar dependencias
npm install

# 2. Crear archivo de entorno
cp .env.example .env
# Editar .env con tus datos de PostgreSQL

# 3. Arrancar en desarrollo (con auto-reload)
npm run dev

# 4. Arrancar en producción
npm start
```

## Estructura

```
pb-backend/
├── src/
│   ├── index.js              ← Entrada principal, Express + middlewares
│   ├── db/
│   │   └── pool.js           ← Conexión PostgreSQL (pg)
│   ├── middleware/
│   │   └── auth.js           ← JWT authMiddleware + soloGerencia
│   ├── controllers/
│   │   └── authController.js ← login, cambiarPassword
│   └── routes/
│       └── auth.js           ← POST /api/auth/login
├── .env.example
├── .gitignore
└── package.json
```

## Endpoints disponibles

### Auth
| Método | Ruta | Descripción | Auth |
|--------|------|-------------|------|
| POST | `/api/auth/login` | Login, devuelve JWT | No |
| POST | `/api/auth/cambiar-password` | Cambiar contraseña | Sí |
| GET | `/api/health` | Health check | No |

### Próximamente
- `/api/materiales` — CRUD materiales + stock consolidado
- `/api/bodegas` — Bodegas + stock por bodega
- `/api/movimientos` — Entradas, salidas, historial
- `/api/proveedores` — CRUD proveedores + tiempos entrega
- `/api/alertas` — Alertas de inventario
- `/api/reportes` — Movimientos y mermas
- `/api/usuarios` — Gestión de usuarios (solo gerencia)

## Notas del modelo

- El rol se deriva de los booleanos `usuario_es_gerencia` / `usuario_es_jop`
- Las contraseñas se almacenan con bcrypt en `usuario_contrasena`
- El schema de PostgreSQL es `inventario` — todas las queries lo setean automáticamente
- Las FKs a otros schemas (producción) no se resuelven en este módulo
