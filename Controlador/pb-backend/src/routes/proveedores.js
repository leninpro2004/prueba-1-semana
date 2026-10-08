const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/proveedoresController');
const { authMiddleware, soloGerencia, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',     ctrl.listar);
// CU-63: ruta fija ANTES de /:id, o la captura el parámetro
router.get('/metricas', ctrl.metricas);
router.get('/:id',  ctrl.obtener);
// CU-61: historial de precios del proveedor. Montos: solo gerencia
router.get('/:id/precios', soloGerencia, ctrl.precios);
// CU-62: plazo real de entrega y cumplimiento (sin montos)
router.get('/:id/cumplimiento', ctrl.cumplimiento);
// D62: crear exige rol operativo; editar, activar/desactivar y eliminar, gerencia (como la pantalla)
router.post('/',    soloOperativo, ctrl.crear);
router.put('/:id',  soloGerencia, ctrl.actualizar);
// Activar / desactivar: aparte de actualizar, para no arrastrar el resto del formulario
router.put('/:id/estado', soloGerencia, ctrl.cambiarEstado);
router.delete('/:id', soloGerencia, ctrl.eliminar);

module.exports = router;
