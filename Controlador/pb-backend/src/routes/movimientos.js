const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/movimientosController');
const { authMiddleware, soloGerencia, soloOperativo } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

router.use(authMiddleware);

router.get('/',            ctrl.listar);
router.get('/catalogos',   ctrl.catalogos);
// D62: mover stock exige rol operativo
router.post('/entrada',    soloOperativo, requiereFirma('movimiento_manual'), ctrl.registrarEntrada);
// F-11 (D73): una salida con fecha pasada pide su propia firma, más estricta que la del movimiento manual
router.post('/salida',     soloOperativo,
  requiereFirma(req => (ctrl.esFechaPasada(req.body?.fecha) ? 'salida_fecha_pasada' : 'movimiento_manual')), ctrl.registrarSalida);
router.post('/traslado',   soloOperativo, requiereFirma('movimiento_manual'), ctrl.registrarTraslado);   // D60: salida + entrada en una transacción
// CU-74 CP3: Verificar mermas pendientes >24h (debe ir antes de /:id)
router.post('/verificar-mermas-pendientes', soloOperativo, ctrl.verificarMermasPendientes);
// OPUS-9 paso 4: backfill del vinculo OT <-> movimientos (simula salvo ?aplicar=true)
router.post('/vincular-ot', soloGerencia, requiereFirma('corregir_consumo'), ctrl.vincularOrdenesTrabajo);
// CU-42/44 (F-11): lo que no se puede revertir se rechaza ANTES de pedir la firma, para no gastarla
router.post('/:id/revertir',       soloGerencia, ctrl.validarReversible, requiereFirma('revertir_movimiento'), ctrl.revertir);
// Incremento 2 — CU-68.1
router.put('/:id/aprobar-merma',   soloGerencia, requiereFirma('aprobar_merma'), ctrl.aprobarMerma);
router.put('/:id/rechazar-merma',  soloGerencia, requiereFirma('aprobar_merma'), ctrl.rechazarMerma);

module.exports = router;
