const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const auth = require('../middlewares/auth');
const Joi = require('joi');
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
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

const reportesQuerySchema = Joi.object({
  fecha_inicio: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .required()
    .custom((value, helpers) => {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return helpers.error('date.invalid', { message: 'Formato de fecha inválido. Usa YYYY-MM-DD.' });
      }
      return value;
    }, 'Validar formato de fecha'),
  fecha_fin: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .required()
    .custom((value, helpers) => {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return helpers.error('date.invalid', { message: 'Formato de fecha inválido. Usa YYYY-MM-DD.' });
      }
      return value;
    }, 'Validar formato de fecha'),
  detalle: Joi.boolean().default(false),
  divisa_id: Joi.number().integer().min(1).optional(),
  tipo: Joi.string().uppercase().valid('COMPRA', 'VENTA').optional(),
  cliente_id: Joi.number().integer().min(1).optional(),
  caja_id: Joi.number().integer().min(1).optional()
}).custom((obj, helpers) => {
  const fechaInicio = new Date(obj.fecha_inicio);
  const fechaFin = new Date(obj.fecha_fin);
  if (fechaInicio > fechaFin) {
    return helpers.error('any.custom', { message: 'La fecha de inicio debe ser anterior o igual a la fecha de fin.' });
  }
  return obj;
});

// GET /api/reportes
router.get('/', auth, async (req, res) => {
  const { error, value } = reportesQuerySchema.validate(req.query);
  if (error) {
    logger.error(`Validación fallida en GET /api/reportes: ${error.details.map(d => d.message).join(', ')}`, { user: req.user.id });
    return res.status(400).json({ msg: error.details.map(d => d.message).join(', ') });
  }

  const { fecha_inicio, fecha_fin, detalle, divisa_id, tipo, cliente_id, caja_id } = value;

  try {
    logger.info('Obteniendo reportes', { user: req.user.id, params: value });

    let query;
    let params = [req.user.id, `${fecha_inicio} 00:00:00`, `${fecha_fin} 23:59:59`];

    if (detalle) {
      query = `
        SELECT 
          t.id,
          t.tipo,
          d.codigo AS divisa_codigo,
          d.nombre AS divisa_nombre,
          t.monto,
          t.total_soles,
          t.utilidad,
          t.fecha,
          t.cliente_id,
          c.nombre AS cliente_nombre,
          t.caja_id,
          u.email AS usuario_email
        FROM transacciones t
        JOIN divisas d ON t.divisa_id = d.id
        LEFT JOIN clientes c ON t.cliente_id = c.id
        JOIN usuarios u ON t.usuario_id = u.id
        WHERE t.usuario_id = ?
          AND t.fecha >= ?
          AND t.fecha <= ?
      `;
    } else {
      query = `
        SELECT 
          t.tipo,
          d.codigo AS divisa_codigo,
          d.nombre AS divisa_nombre,
          SUM(t.monto) AS total_monto,
          SUM(t.total_soles) AS total_soles,
          COUNT(t.id) AS num_transacciones,
          AVG(t.utilidad) AS utilidad_promedio
        FROM transacciones t
        JOIN divisas d ON t.divisa_id = d.id
        WHERE t.usuario_id = ?
          AND t.fecha >= ?
          AND t.fecha <= ?
      `;
    }

    if (divisa_id) {
      query += ' AND t.divisa_id = ?';
      params.push(divisa_id);
    }
    if (tipo) {
      query += ' AND UPPER(t.tipo) = ?';
      params.push(tipo.toUpperCase());
    }
    if (cliente_id) {
      query += ' AND t.cliente_id = ?';
      params.push(cliente_id);
    }
    if (caja_id) {
      query += ' AND t.caja_id = ?';
      params.push(caja_id);
    }

    if (!detalle) {
      query += ' GROUP BY t.tipo, d.codigo, d.nombre ORDER BY d.codigo, t.tipo';
    } else {
      query += ' ORDER BY t.fecha DESC';
    }

    const [rows] = await pool.query(query, params);

    const formattedRows = detalle
      ? rows.map(r => ({
          id: r.id,
          tipo: r.tipo,
          divisa_codigo: r.divisa_codigo,
          divisa_nombre: r.divisa_nombre,
          monto: Number(r.monto).toFixed(2),
          total_soles: Number(r.total_soles).toFixed(2),
          utilidad: r.utilidad !== null ? Number(r.utilidad).toFixed(2) : null,
          fecha: r.fecha,
          cliente_id: r.cliente_id,
          cliente_nombre: r.cliente_nombre || 'Sin cliente',
          caja_id: r.caja_id,
          usuario_email: r.usuario_email
        }))
      : rows.map(r => ({
          tipo: r.tipo,
          divisa_codigo: r.divisa_codigo,
          divisa_nombre: r.divisa_nombre,
          total_monto: Number(r.total_monto).toFixed(2),
          total_soles: Number(r.total_soles).toFixed(2),
          num_transacciones: r.num_transacciones,
          utilidad_promedio: r.utilidad_promedio !== null ? Number(r.utilidad_promedio).toFixed(2) : null
        }));

    logger.info(`Reportes obtenidos exitosamente`, { count: rows.length, user: req.user.id });
    res.json(formattedRows);
  } catch (err) {
    logger.error(`Error obteniendo reportes: ${err.message}`, { user: req.user.id, stack: err.stack });
    if (err.message.includes('Incorrect DATETIME value')) {
      res.status(400).json({ msg: 'Formato de fecha inválido. Usa YYYY-MM-DD.' });
    } else {
      res.status(500).json({ msg: `Error: ${err.message}` });
    }
  }
});

module.exports = router;