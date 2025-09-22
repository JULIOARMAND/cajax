const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const log = require('../middlewares/log');
const db = require('../config/db');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

router.get('/', auth, log, async (req, res) => {
  try {
    logger.info('Obteniendo estadísticas del dashboard', { user: req.user.id });

    // Parámetros de query
    const { incluirCerradas = false, limit = 15, dias } = req.query;
    const incluirCerradasBool = incluirCerradas === 'true' || incluirCerradas === true;
    const whereClause = incluirCerradasBool ? 'c.usuario_id = ?' : 'c.usuario_id = ? AND c.estado = "ABIERTA"';

    // Para dailyUtilidad: si se pasa dias, filtra por ese rango, si no, histórico
    let dailyUtilidadWhere = whereClause;
    let dailyUtilidadDateFilter = '';
    if (dias && !isNaN(Number(dias))) {
      dailyUtilidadDateFilter = `AND t.fecha >= DATE_SUB(CURDATE(), INTERVAL ${Number(dias)} DAY)`;
    }

    const [usersResult, transactionsResult, utilidadResult, cajaResult, saldosResult, recentTransResult, comprasVentasResult, dailyUtilidadResult] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM users'),
      db.query(
        `SELECT COUNT(*) as count, COALESCE(SUM(total_soles), 0) as total_soles FROM transacciones t JOIN caja c ON t.caja_id = c.id WHERE ${whereClause}`,
        [req.user.id]
      ),
      db.query(
        `SELECT COALESCE(SUM(utilidad), 0) as utilidad FROM transacciones t JOIN caja c ON t.caja_id = c.id WHERE ${whereClause}`,
        [req.user.id]
      ),
      db.query('SELECT id, utilidad_total, fecha_apertura FROM caja WHERE estado = "ABIERTA" AND usuario_id = ? LIMIT 1', [req.user.id]),
      db.query(
        `SELECT d.codigo, COALESCE(cs.saldo_actual, 0) as saldo_actual FROM divisas d LEFT JOIN caja_saldos cs ON d.id = cs.divisa_id AND cs.caja_id = (SELECT id FROM caja WHERE estado = "ABIERTA" AND usuario_id = ? LIMIT 1)`,
        [req.user.id]
      ),
      db.query(
        `SELECT t.id, t.tipo, d.codigo AS divisa_codigo, t.monto, t.total_soles, t.utilidad, t.fecha FROM transacciones t JOIN divisas d ON t.divisa_id = d.id JOIN caja c ON t.caja_id = c.id WHERE ${whereClause} ORDER BY t.fecha DESC${limit ? ` LIMIT ${parseInt(limit)}` : ''}`,
        [req.user.id]
      ),
      db.query(
        `SELECT d.codigo AS divisa_codigo, SUM(CASE WHEN t.tipo = "COMPRA" THEN t.total_soles ELSE 0 END) AS compras, SUM(CASE WHEN t.tipo = "VENTA" THEN t.total_soles ELSE 0 END) AS ventas FROM transacciones t JOIN divisas d ON t.divisa_id = d.id JOIN caja c ON t.caja_id = c.id WHERE ${whereClause} GROUP BY d.codigo`,
        [req.user.id]
      ),
      db.query(
        `SELECT DATE(t.fecha) AS date, SUM(t.utilidad) AS utilidad FROM transacciones t JOIN caja c ON t.caja_id = c.id WHERE ${dailyUtilidadWhere} ${dailyUtilidadDateFilter} GROUP BY DATE(t.fecha) ORDER BY DATE(t.fecha)`
        , [req.user.id]
      )
    ]);

    const caja = cajaResult[0][0] || null;
    const saldos = saldosResult[0].reduce((acc, s) => {
      acc[s.codigo.toLowerCase()] = { actual: Number(s.saldo_actual).toFixed(2) };
      return acc;
    }, {});
    const recentTrans = recentTransResult[0].map(t => ({
      ...t,
      monto: Number(t.monto).toFixed(2),
      total_soles: Number(t.total_soles).toFixed(2),
      utilidad: Number(t.utilidad || 0).toFixed(2)
    }));
    const comprasVentas = comprasVentasResult[0].reduce((acc, cv) => {
      acc[cv.divisa_codigo] = {
        compras: Number(cv.compras).toFixed(2),
        ventas: Number(cv.ventas).toFixed(2)
      };
      return acc;
    }, {});
    const dailyUtilidad = dailyUtilidadResult[0].map(du => ({
      date: du.date,
      utilidad: Number(du.utilidad || 0).toFixed(2)
    }));

    const stats = {
      usuarios: usersResult[0][0].count,
      transacciones: transactionsResult[0][0].count,
      total_soles: Number(transactionsResult[0][0].total_soles).toFixed(2),
      utilidad: Number(utilidadResult[0][0].utilidad).toFixed(2),
      caja: caja ? { ...caja, utilidad_total: Number(caja.utilidad_total).toFixed(2), saldos } : null,
      recentTrans,
      comprasVentas,
      dailyUtilidad
    };

    logger.info('Estadísticas obtenidas', { stats, user: req.user.id });
    res.json({ stats });
  } catch (err) {
    logger.error(`Error en dashboard: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ msg: 'Error al cargar estadísticas', error: err.message });
  }
});

module.exports = router;



