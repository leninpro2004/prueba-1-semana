const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/catalogosController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

// F-04: mantenedor de áreas, unidades y motivos (pantalla Catálogos, solo gerencia)
router.use(authMiddleware, soloGerencia);
// F-11: toda escritura del mantenedor pide la firma de un gerente
const firma = requiereFirma('catalogos');

router.get('/areas',      ctrl.listarAreas);
router.post('/areas',     firma, ctrl.crearArea);
router.put('/areas/:id',  firma, ctrl.actualizarArea);

router.get('/unidades',        ctrl.listarUnidades);
router.post('/unidades',       firma, ctrl.crearUnidad);
router.put('/unidades/:id',    firma, ctrl.actualizarUnidad);
router.delete('/unidades/:id', firma, ctrl.eliminarUnidad);

router.get('/motivos',            ctrl.listarMotivos);
router.post('/motivos/restaurar', firma, ctrl.restaurarMotivo);   // ruta fija antes de /:id
router.post('/motivos',           firma, ctrl.crearMotivo);
router.put('/motivos/:id',        firma, ctrl.actualizarMotivo);
// F-11: el que no se puede borrar (no existe o tiene movimientos) se rechaza antes de pedir la firma
router.delete('/motivos/:id',     ctrl.validarBorrableMotivo, firma, ctrl.eliminarMotivo);

module.exports = router;
