const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/movimientosController');
const { authMiddleware, soloGerencia, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',            ctrl.listar);
router.get('/catalogos',   ctrl.catalogos);
// D62: mover stock exige rol operativo
router.post('/entrada',    soloOperativo, ctrl.registrarEntrada);
router.post('/salida',     soloOperativo, ctrl.registrarSalida);
router.post('/traslado',   soloOperativo, ctrl.registrarTraslado);   // D60: salida + entrada en una transacción
// CU-74 CP3: Verificar mermas pendientes >24h (debe ir antes de /:id)
router.post('/verificar-mermas-pendientes', soloOperativo, ctrl.verificarMermasPendientes);
// OPUS-9 paso 4: backfill del vinculo OT <-> movimientos (simula salvo ?aplicar=true)
router.post('/vincular-ot', soloGerencia, ctrl.vincularOrdenesTrabajo);
router.post('/:id/revertir',       soloGerencia, ctrl.revertir);
// Incremento 2 — CU-68.1
router.put('/:id/aprobar-merma',   soloGerencia, ctrl.aprobarMerma);
router.put('/:id/rechazar-merma',  soloGerencia, ctrl.rechazarMerma);

module.exports = router;
