const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/ordenesTrabajoController');
const { authMiddleware, soloGerencia, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

// CU-103: finalizar la OT y procesar sus diferenciales (actor jop; también gerencia)
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

router.get('/',                       ctrl.listar);
router.get('/:id/consumos',           ctrl.consultarConsumos);
router.get('/:id/movimientos',        ctrl.movimientosOT);
// D62: registrar o corregir consumos (mueven stock) exige rol operativo
router.post('/:id/consumos',          soloOperativo, ctrl.registrarConsumo);
router.put('/:id/consumos/:sku',      soloOperativo, ctrl.editarConsumo);
router.put('/:id/estimados',          soloOperativo, ctrl.registrarEstimados);
router.put('/:id/consumo',            soloOperativo, ctrl.guardarConsumo);   // R1: pestaña Consumo (receta + real, todo junto)
router.put('/:id/correccion',         soloGerencia, ctrl.corregirConsumoCerrada);   // D54: OT cerrada, con motivo
router.delete('/:id/materiales/:sku', soloOperativo, ctrl.eliminarMaterial);
router.put('/:id/empleado-tentativo', soloOperativo, ctrl.asignarEmpleadoTentativo);
router.get('/:id/comparativo',        ctrl.comparativo);
router.get('/:id/costos',    soloGerencia, ctrl.costos);
router.get('/:id/rentabilidad', soloGerencia, ctrl.rentabilidad);
router.put('/:id/finalizar',          soloGerenciaOJop, ctrl.finalizar);               // CU-103
router.get('/:id/diferenciales',      soloGerenciaOJop, ctrl.consultarDiferenciales);  // CU-103
router.post('/:id/diferenciales',     soloGerenciaOJop, ctrl.procesarDiferenciales);   // CU-103

module.exports = router;
