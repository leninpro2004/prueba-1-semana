const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/materialesController');
const { soloGerencia, soloOperativo } = require('../middleware/auth');
const { authMiddleware } = require('../middleware/auth');

// Todos los endpoints requieren autenticación
router.use(authMiddleware);

// Catálogos para formularios (deben ir antes de /:sku)
router.get('/catalogos/unidades',   ctrl.listarUnidades);
router.get('/catalogos/categorias', ctrl.listarCategorias);

// Incremento 2: rutas especiales (antes de /:sku)
router.get('/pinturas-sobrantes',  ctrl.pinturasSobrantes);
router.post('/duplicar', soloGerencia, ctrl.duplicar);

// CRUD materiales
router.get('/',     ctrl.listar);
router.get('/:sku', ctrl.obtener);
router.post('/',    soloOperativo, ctrl.crear);      // D62
router.put('/:sku',    soloOperativo, ctrl.actualizar);   // D62
router.delete('/:sku', soloGerencia, ctrl.eliminar);

// Incremento 2: acciones sobre un material específico
router.put('/:sku/reactivar',       soloGerencia, ctrl.reactivar);
// CU-61: montos solo para gerencia, en el backend (antes se enviaban a todos los roles)
router.get('/:sku/historial-precios', soloGerencia, ctrl.historialPrecios);
router.get('/:sku/precios',           soloGerencia, ctrl.listarPrecios);
// CU-60: vincular o actualizar un proveedor con precio, plazo y cantidad minima
router.post('/:sku/proveedores', soloGerencia, ctrl.vincularProveedor);
// CU-65: comparativa de proveedores del producto (el precio no viaja al rol jop)
router.get('/:sku/comparar-proveedores', ctrl.compararProveedores);

module.exports = router;
