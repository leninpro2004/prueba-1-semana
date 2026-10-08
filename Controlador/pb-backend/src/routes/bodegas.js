const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/bodegasController');
const { authMiddleware, soloOperativo, soloGerenciaOAdministrador } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',                           ctrl.listar);
router.get('/:id',                        ctrl.obtener);
router.get('/:id/stock-consolidado',      ctrl.stockConsolidado);
// D62: escribir exige rol operativo; borrar, gerencia o administrador (como la pantalla)
router.post('/',                          soloOperativo, ctrl.crear);
router.put('/:id',                        soloOperativo, ctrl.actualizar);
router.delete('/:id',                     soloGerenciaOAdministrador, ctrl.eliminar);
// Incremento 2 — Anaqueles
router.post('/:id/anaqueles',             soloOperativo, ctrl.crearAnaquel);
router.put('/:id/anaqueles/:anaquelId',    soloOperativo, ctrl.editarAnaquel);
router.delete('/:id/anaqueles/:anaquelId', soloGerenciaOAdministrador, ctrl.eliminarAnaquel);

module.exports = router;
