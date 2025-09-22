const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const auth = require('../middlewares/auth');
const Joi = require('joi');
const winston = require('winston');

// Configuración de Winston para logging
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

// Middleware de autorización por rol
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      logger.warn(`Acceso denegado para usuario ${req.user?.id || 'desconocido'} con rol ${req.user?.rol || 'ninguno'}`, {
        rolesPermitidos: roles
      });
      return res.status(403).json({ msg: 'Acceso denegado' });
    }
    next();
  };
}

// Esquema de validación para divisas
const divisaSchema = Joi.object({
  codigo: Joi.string().length(3).uppercase().required(),
  nombre: Joi.string().min(3).max(50).required(),
  tasa_compra: Joi.number().positive().precision(4).min(1).max(10).required(),
  tasa_venta: Joi.number().positive().precision(4).min(1).max(10).required(),
  costo_base_moneda: Joi.number().positive().precision(4).min(1).max(10).required()
});

// Esquema para actualización de tasas
const tasaSchema = Joi.object({
  tasa_compra: Joi.number().positive().precision(4).min(1).max(10).required(),
  tasa_venta: Joi.number().positive().precision(4).min(1).max(10).required(),
  costo_base_moneda: Joi.number().positive().precision(4).min(1).max(10).optional()
});

// 📌 GET una divisa específica (Admin, Auditor, Cajero)
router.get('/:id', auth, authorize('Admin', 'Auditor', 'Cajero'), async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT d.id, d.codigo, d.nombre, d.tasa_compra, d.tasa_venta, dc.costo_base_moneda
       FROM divisas d
       LEFT JOIN divisas_costos dc ON d.id = dc.divisa_id
       WHERE d.id = ?`,
      [id]
    );
    if (!rows.length) {
      logger.warn(`Divisa no encontrada: ID ${id}`);
      return res.status(404).json({ msg: 'Divisa no encontrada' });
    }
    logger.info(`Divisa obtenida: ID ${id}`, { divisa: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    logger.error(`Error obteniendo divisa: ${err.message}`, { stack: err.stack });
    res.status(500).json({ msg: 'Error al obtener divisa' });
  }
});

// 📌 GET todas las divisas (Admin o Auditor)
router.get('/', auth, authorize('Admin', 'Auditor'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.id, d.codigo, d.nombre, d.tasa_compra, d.tasa_venta, dc.costo_base_moneda
       FROM divisas d
       LEFT JOIN divisas_costos dc ON d.id = dc.divisa_id
       ORDER BY d.codigo ASC`
    );
    logger.info('Divisas obtenidas exitosamente', { count: rows.length });
    res.json(rows);
  } catch (err) {
    logger.error(`Error obteniendo divisas: ${err.message}`, { stack: err.stack });
    res.status(500).json({ msg: 'Error al obtener divisas' });
  }
});

// 📌 POST crear nueva divisa (solo Admin)
router.post('/', auth, authorize('Admin'), async (req, res) => {
  const { error, value } = divisaSchema.validate(req.body, { convert: true });
  if (error) {
    logger.error(`Validación fallida al crear divisa: ${error.details.map(d => d.message).join(', ')}`);
    return res.status(400).json({ msg: error.details.map(d => d.message).join(', ') });
  }

  const { codigo, nombre, tasa_compra, tasa_venta, costo_base_moneda } = value;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Verificar si el código ya existe
    const [existing] = await connection.query('SELECT 1 FROM divisas WHERE codigo = ?', [codigo]);
    if (existing.length > 0) {
      await connection.rollback();
      logger.warn(`Intento de crear divisa con código existente: ${codigo}`);
      return res.status(400).json({ msg: 'El código de divisa ya existe' });
    }

    // Insertar divisa
    const [result] = await connection.query(
      'INSERT INTO divisas (codigo, nombre, tasa_compra, tasa_venta) VALUES (?, ?, ?, ?)',
      [codigo, nombre, tasa_compra, tasa_venta]
    );
    const divisa_id = result.insertId;

    // Insertar costo base
    await connection.query(
      'INSERT INTO divisas_costos (divisa_id, costo_base_moneda) VALUES (?, ?)',
      [divisa_id, costo_base_moneda]
    );

    await connection.commit();
    logger.info(`Divisa creada: ${codigo}`, { id: divisa_id, tasa_compra, tasa_venta, costo_base_moneda });
    res.status(201).json({ msg: 'Divisa creada exitosamente', id: divisa_id });
  } catch (err) {
    await connection.rollback();
    logger.error(`Error creando divisa: ${err.message}`, { stack: err.stack });
    res.status(500).json({ msg: 'Error al crear divisa' });
  } finally {
    connection.release();
  }
});

// 📌 PUT actualizar divisa (solo Admin)
router.put('/:id', auth, authorize('Admin'), async (req, res) => {
  const { error, value } = tasaSchema.validate(req.body, { convert: true });
  if (error) {
    logger.error(`Validación fallida al actualizar divisa: ${error.details.map(d => d.message).join(', ')}`);
    return res.status(400).json({ msg: error.details.map(d => d.message).join(', ') });
  }

  const { tasa_compra, tasa_venta, costo_base_moneda } = value;
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Verificar si la divisa existe
    const [divisa] = await connection.query('SELECT 1 FROM divisas WHERE id = ?', [id]);
    if (!divisa.length) {
      await connection.rollback();
      return res.status(404).json({ msg: 'Divisa no encontrada' });
    }

    // Actualizar tasas
    const [result] = await connection.query(
      'UPDATE divisas SET tasa_compra = ?, tasa_venta = ? WHERE id = ?',
      [tasa_compra, tasa_venta, id]
    );

    // Actualizar o insertar costo base
    if (costo_base_moneda) {
      const [exists] = await connection.query('SELECT 1 FROM divisas_costos WHERE divisa_id = ?', [id]);
      if (exists.length) {
        await connection.query(
          'UPDATE divisas_costos SET costo_base_moneda = ?, updated_at = NOW() WHERE divisa_id = ?',
          [costo_base_moneda, id]
        );
      } else {
        await connection.query(
          'INSERT INTO divisas_costos (divisa_id, costo_base_moneda) VALUES (?, ?)',
          [id, costo_base_moneda]
        );
      }
    }

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ msg: 'Divisa no encontrada' });
    }

    await connection.commit();
    logger.info(`Divisa actualizada: ID ${id}`, { tasa_compra, tasa_venta, costo_base_moneda });
    res.json({ msg: 'Divisa actualizada exitosamente' });
  } catch (err) {
    await connection.rollback();
    logger.error(`Error actualizando divisa: ${err.message}`, { stack: err.stack });
    res.status(500).json({ msg: 'Error al actualizar divisa' });
  } finally {
    connection.release();
  }
});

// 📌 DELETE eliminar divisa (solo Admin)
router.delete('/:id', auth, authorize('Admin'), async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Verificar si la divisa está en uso
    const [transacciones] = await connection.query('SELECT 1 FROM transacciones WHERE divisa_id = ?', [id]);
    if (transacciones.length > 0) {
      await connection.rollback();
      logger.warn(`Intento de eliminar divisa en uso: ID ${id}`);
      return res.status(400).json({ msg: 'No se puede eliminar una divisa con transacciones asociadas' });
    }

    // Verificar si la divisa tiene inventario
    const [inventario] = await connection.query('SELECT 1 FROM divisas_inventario WHERE divisa_id = ?', [id]);
    if (inventario.length > 0) {
      await connection.rollback();
      logger.warn(`Intento de eliminar divisa con inventario: ID ${id}`);
      return res.status(400).json({ msg: 'No se puede eliminar una divisa con inventario asociado' });
    }

    // Eliminar costo base
    await connection.query('DELETE FROM divisas_costos WHERE divisa_id = ?', [id]);

    // Eliminar divisa
    const [result] = await connection.query('DELETE FROM divisas WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ msg: 'Divisa no encontrada' });
    }

    await connection.commit();
    logger.info(`Divisa eliminada: ID ${id}`);
    res.json({ msg: 'Divisa eliminada exitosamente' });
  } catch (err) {
    await connection.rollback();
    logger.error(`Error eliminando divisa: ${err.message}`, { stack: err.stack });
    res.status(500).json({ msg: 'Error al eliminar divisa' });
  } finally {
    connection.release();
  }
});

// 📌 GET costo base de una divisa (Admin o Cajero)
router.get('/:id/costo-base', auth, authorize('Admin', 'Cajero'), async (req, res) => {
  try {
    const [result] = await pool.query('SELECT costo_base_moneda FROM divisas_costos WHERE divisa_id = ?', [req.params.id]);
    if (!result.length) {
      logger.warn(`Costo base no encontrado para divisa ID ${req.params.id}`);
      return res.status(404).json({ msg: 'Costo base no definido para esta divisa' });
    }
    logger.info(`Costo base obtenido para divisa ID ${req.params.id}`, { costo_base_moneda: result[0].costo_base_moneda });
    res.json(result[0]);
  } catch (err) {
    logger.error(`Error obteniendo costo base: ${err.message}`, { stack: err.stack });
    res.status(500).json({ msg: 'Error al obtener costo base' });
  }
});

// 📌 GET costo base promedio ponderado desde inventario (optimizado con fallback y validaciones adicionales)
router.get('/:id/costo-base-promedio', auth, authorize('Admin', 'Cajero'), async (req, res) => {
  const { id } = req.params;
  if (isNaN(id) || parseInt(id) < 2) {
    logger.warn(`ID de divisa inválido para costo-base-promedio: ${id}`, { user: req.user.id });
    return res.status(400).json({ success: false, msg: 'ID de divisa inválido (no puede ser PEN)' });
  }

  const connection = await pool.getConnection();
  try {
    // Verificar si la divisa existe
    const [divisaCheck] = await connection.query('SELECT id, tasa_compra FROM divisas WHERE id = ?', [id]);
    if (!divisaCheck.length) {
      logger.warn(`Divisa no encontrada: ID ${id}`, { user: req.user.id });
      return res.status(404).json({ success: false, msg: 'Divisa no encontrada' });
    }

    // Intentar WAC desde inventario disponible (filtrado por caja abierta)
    const [lotes] = await connection.query(
      `SELECT monto, costo_base 
       FROM divisas_inventario 
       WHERE divisa_id = ? AND disponible = TRUE 
         AND caja_id IN (SELECT id FROM caja WHERE usuario_id = ? AND estado = 'ABIERTA')`,
      [id, req.user.id]
    );

    if (lotes.length) {
      // Validar que todos los montos y costos sean numéricos
      const validLotes = lotes.filter(lote => {
        const monto = Number(lote.monto);
        const costo_base = Number(lote.costo_base);
        if (isNaN(monto) || isNaN(costo_base)) {
          logger.warn(`Datos inválidos en divisas_inventario: monto=${lote.monto}, costo_base=${lote.costo_base}`, { divisa_id: id, user: req.user.id });
          return false;
        }
        return true;
      });

      if (validLotes.length) {
        const totalMonto = validLotes.reduce((sum, lote) => sum + Number(lote.monto), 0);
        if (totalMonto > 0) {
          const costoPonderado = validLotes.reduce((sum, lote) => sum + Number(lote.monto) * Number(lote.costo_base), 0) / totalMonto;
          logger.info(`WAC calculado para divisa ID ${id}: ${costoPonderado.toFixed(4)}`, { user: req.user.id, lotes: validLotes.length });
          return res.json({ success: true, data: { costo_base_promedio: Number(costoPonderado.toFixed(4)) } });
        }
      }
      logger.warn(`No hay lotes válidos o monto total = 0 para divisa ID ${id}`, { user: req.user.id });
    }

    // Fallback: Usar divisas_costos
    const [costoBase] = await connection.query('SELECT costo_base_moneda FROM divisas_costos WHERE divisa_id = ?', [id]);
    if (costoBase.length) {
      const costoBaseMoneda = Number(costoBase[0].costo_base_moneda);
      if (!isNaN(costoBaseMoneda) && costoBaseMoneda > 0) {
        logger.info(`Usando costo_base_moneda de divisas_costos para divisa ID ${id}: ${costoBaseMoneda.toFixed(4)}`, { user: req.user.id });
        return res.json({ success: true, data: { costo_base_promedio: Number(costoBaseMoneda.toFixed(4)) } });
      }
      logger.warn(`costo_base_moneda inválido o nulo en divisas_costos para divisa ID ${id}: ${costoBase[0].costo_base_moneda}`, { user: req.user.id });
    }

    // Fallback final: Usar tasa_compra de divisas
    const tasaCompra = Number(divisaCheck[0].tasa_compra);
    if (isNaN(tasaCompra) || tasaCompra <= 0) {
      logger.warn(`No hay tasa_compra válida para divisa ID ${id}`, { user: req.user.id });
      return res.status(404).json({ success: false, msg: 'No hay tasa de compra definida ni inventario disponible' });
    }

    logger.info(`Usando tasa_compra como costo base inicial para divisa ID ${id}: ${tasaCompra.toFixed(4)}`, { user: req.user.id });
    res.json({ success: true, data: { costo_base_promedio: Number(tasaCompra.toFixed(4)) } });
  } catch (err) {
    logger.error(`Error calculando costo base promedio para divisa ID ${id}: ${err.message}`, { stack: err.stack, user: req.user.id });
    res.status(500).json({ success: false, msg: 'Error al calcular costo base promedio' });
  } finally {
    connection.release();
  }
});

module.exports = router;