const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/usuariosController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

router.use(authMiddleware);
router.use(soloGerencia); // Todos los endpoints de usuarios son solo gerencia

router.get('/',                                ctrl.listar);
router.get('/auditoria',                       ctrl.auditoria);
router.post('/',                               ctrl.crear);
router.put('/:id/permisos',                    ctrl.editarPermisos);
router.post('/:id/recuperar-password',         ctrl.recuperarPassword);
// Incremento 2 — CU-83.1, CU-83.2
router.post('/:id/programar-desactivacion',    ctrl.programarDesactivacion);
router.post('/:id/programar-activacion',       ctrl.programarActivacion);
router.delete('/:id/programacion',              ctrl.cancelarProgramacion);
router.post('/procesar-programaciones',        ctrl.procesarProgramaciones);

module.exports = router;
