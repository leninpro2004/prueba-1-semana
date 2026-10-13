const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/materialesController');
const clasificacion = require('../controllers/clasificacionController');
const { soloGerencia, soloOperativo } = require('../middleware/auth');
const { authMiddleware } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

// Todos los endpoints requieren autenticación
router.use(authMiddleware);

// Catálogos para formularios (deben ir antes de /:sku)
router.get('/catalogos/unidades',   ctrl.listarUnidades);
router.get('/catalogos/categorias', ctrl.listarCategorias);
// B-14: mantenedor de la clasificación (general, funcional y árbol categoría → subcategoría → nivel)
router.get('/catalogos/clasificacion',              soloGerencia, clasificacion.listar);
router.post('/catalogos/clasificacion/:tipo',       soloGerencia, requiereFirma('catalogos'), clasificacion.crear);
router.put('/catalogos/clasificacion/:tipo/:id',    soloGerencia, requiereFirma('catalogos'), clasificacion.actualizar);
router.delete('/catalogos/clasificacion/:tipo/:id', soloGerencia, requiereFirma('catalogos'), clasificacion.eliminar);

// Incremento 2: rutas especiales (antes de /:sku)
router.get('/pinturas-sobrantes',  ctrl.pinturasSobrantes);
router.post('/duplicar', soloGerencia, ctrl.duplicar);
router.post('/alta-rapida', soloOperativo, ctrl.altaRapida);   // F-23b: material de caja chica que no está en el catálogo

// CRUD materiales
router.get('/',     ctrl.listar);
router.get('/:sku', ctrl.obtener);
router.post('/',    soloOperativo, ctrl.crear);      // D62
router.put('/:sku',    soloOperativo, ctrl.actualizar);   // D62
router.delete('/:sku', soloGerencia, requiereFirma('eliminar_maestro'), ctrl.eliminar);

// Incremento 2: acciones sobre un material específico
router.put('/:sku/reactivar',       soloGerencia, requiereFirma('eliminar_maestro'), ctrl.reactivar);
// CU-61: montos solo para gerencia, en el backend (antes se enviaban a todos los roles)
router.get('/:sku/historial-precios', soloGerencia, ctrl.historialPrecios);
router.get('/:sku/precios',           soloGerencia, ctrl.listarPrecios);
// CU-60: vincular o actualizar un proveedor con precio, plazo y cantidad minima
router.post('/:sku/proveedores', soloGerencia, requiereFirma('precio_proveedor'), ctrl.vincularProveedor);
// CU-65: comparativa de proveedores del producto (el precio no viaja al rol jop)
router.get('/:sku/comparar-proveedores', ctrl.compararProveedores);

module.exports = router;
