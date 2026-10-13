const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/usuariosController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

router.use(authMiddleware);
router.use(soloGerencia); // Todos los endpoints de usuarios son solo gerencia

router.get('/',                                ctrl.listar);
router.get('/auditoria',                       ctrl.auditoria);
// F-11: todo cambio de usuarios y permisos pide la firma de un gerente (salvo procesar-programaciones,
// que la llama el sistema)
const firma = requiereFirma('usuarios');
router.post('/',                               firma, ctrl.crear);
router.put('/:id/permisos',                    firma, ctrl.editarPermisos);
router.post('/:id/recuperar-password',         firma, ctrl.recuperarPassword);
router.post('/:id/reasignar-ot',               requiereFirma('ot_responsable'), ctrl.reasignarOT);   // B-03: sus OT abiertas a otro responsable
// Incremento 2 — CU-83.1, CU-83.2
router.post('/:id/programar-desactivacion',    firma, ctrl.programarDesactivacion);
router.post('/:id/programar-activacion',       firma, ctrl.programarActivacion);
router.delete('/:id/programacion',              firma, ctrl.cancelarProgramacion);
router.post('/procesar-programaciones',        ctrl.procesarProgramaciones);

module.exports = router;
