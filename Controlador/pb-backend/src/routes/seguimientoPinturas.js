const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/seguimientoPinturasController');
const { authMiddleware, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

// OPUS-11 (Req #3). Las rutas fijas van ANTES de las parametrizadas.
router.get('/reporte',            ctrl.reporteConsumo);
router.get('/catalogo',           ctrl.catalogo);
router.get('/material/:sku',      ctrl.historialPorMaterial);
router.get('/',                   ctrl.listar);
// D62: todas mueven stock: exigen rol operativo
router.post('/',                  soloOperativo, ctrl.registrar);
router.put('/:id/devolver',       soloOperativo, ctrl.devolver);
// OPUS-16: correccion y anulacion, las dos mueven stock por la DIFERENCIA
router.put('/:id/anular',         soloOperativo, ctrl.anular);
router.put('/:id',                soloOperativo, ctrl.corregir);

module.exports = router;
