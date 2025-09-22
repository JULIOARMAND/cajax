// transacciones.js (Backend - Complete Optimized Code)
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

const transaccionSchema = Joi.object({
  tipo: Joi.string().valid('COMPRA', 'VENTA').required(),
  divisa_id: Joi.number().integer().min(2).required(),
  cliente_id: Joi.number().integer().min(1).allow(null),
  monto: Joi.number().positive().precision(2).required(),
  tasa: Joi.number().positive().precision(4).required(),
  total_soles: Joi.number().positive().precision(2).required(),
  comision: Joi.number().min(0).precision(2).default(0).optional(), // Cambiado de .positive() a .min(0)
});

const transaccionQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(5)
});

// GET /api/transacciones - Retrieve recent transactions
router.get('/', auth, async (req, res) => {
  const { error, value } = transaccionQuerySchema.validate(req.query, { convert: true });
  if (error) {
    logger.error(`Validación fallida en GET /api/transacciones: ${error.details.map(d => d.message).join(', ')}`, { user: req.user.id });
    return res.status(400).json({ success: false, msg: error.details.map(d => d.message).join(', ') });
  }

  const { limit } = value;

  try {
    logger.info(`Obteniendo ${limit} transacciones recientes`, { user: req.user.id });
    const [transacciones] = await pool.query(
      `SELECT 
         t.id, 
         t.caja_id, 
         t.tipo, 
         t.divisa_id, 
         d.codigo AS divisa_codigo, 
         d.nombre AS divisa_nombre, 
         t.cliente_id, 
         c.nombre AS cliente_nombre, 
         t.monto, 
         t.comision, 
         t.tipo_cambio, 
         t.total_soles, 
         t.utilidad, 
         t.fecha, 
         u.email AS usuario_email
       FROM transacciones t
       JOIN divisas d ON t.divisa_id = d.id
       LEFT JOIN clientes c ON t.cliente_id = c.id
       JOIN usuarios u ON t.usuario_id = u.id
       WHERE t.caja_id IN (SELECT id FROM caja WHERE usuario_id = ? AND estado = 'ABIERTA')
       ORDER BY t.fecha DESC
       LIMIT ?`,
      [req.user.id, limit]
    );

    const formattedTransacciones = transacciones.map(t => ({
      id: t.id,
      caja_id: t.caja_id,
      tipo: t.tipo.toUpperCase(), // 🆕 Estandarizar a mayúsculas para consistencia
      divisa_id: t.divisa_id,
      divisa_codigo: t.divisa_codigo,
      divisa_nombre: t.divisa_nombre,
      cliente_id: t.cliente_id,
      cliente_nombre: t.cliente_nombre || 'Sin cliente',
      monto: Number(t.monto).toFixed(2),
      comision: Number(t.comision).toFixed(2),
      tipo_cambio: Number(t.tipo_cambio).toFixed(4),
      total_soles: Number(t.total_soles).toFixed(2),
      utilidad: t.utilidad !== null ? Number(t.utilidad).toFixed(2) : null,
      fecha: new Date(t.fecha).toLocaleString('es-PE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'America/Lima', // 🆕 Formatear fecha para consistencia
      }),
      usuario_email: t.usuario_email
    }));

    logger.info(`Transacciones obtenidas exitosamente`, { count: transacciones.length, user: req.user.id });
    res.json({ success: true, data: formattedTransacciones });
  } catch (err) {
    logger.error(`Error obteniendo transacciones: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, msg: `Error: ${err.message}` });
  }
});

// POST /api/transacciones - Create a new transaction
router.post('/', auth, async (req, res) => {
  const { error, value } = transaccionSchema.validate(req.body, { convert: true });
  if (error) {
    logger.error(`Validación fallida: ${error.details.map(d => d.message).join(', ')}`, { user: req.user.id });
    return res.status(400).json({ success: false, msg: error.details.map(d => d.message).join(', ') });
  }

  const { tipo, divisa_id, cliente_id, monto, tasa, total_soles: total_soles_input, comision = 0 } = value; // 🆕 Manejar comision del frontend o default 0
  if (divisa_id === 1) {
    return res.status(400).json({ success: false, msg: 'No se pueden realizar transacciones con PEN. Usa ajustes en Caja.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    logger.info(`Iniciando transacción ${tipo}`, { user: req.user.id, divisa_id, monto, tasa, comision });

    // Verificar caja abierta
    const [caja] = await connection.query(
      'SELECT id FROM caja WHERE estado = "ABIERTA" AND usuario_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [req.user.id]
    );
    if (!caja.length) {
      throw new Error('No hay caja abierta');
    }
    const caja_id = caja[0].id;

    // Obtener datos de divisa
    const [divisa] = await connection.query(
      'SELECT d.id, d.codigo, d.nombre, d.tasa_compra, d.tasa_venta, dc.costo_base_moneda ' +
      'FROM divisas d LEFT JOIN divisas_costos dc ON d.id = dc.divisa_id WHERE d.id = ?',
      [divisa_id]
    );
    if (!divisa.length) {
      throw new Error('Divisa no encontrada');
    }
    const { codigo: divisa_codigo, tasa_compra, tasa_venta, costo_base_moneda } = divisa[0];

    // Validar tasa
    const tasaRef = tipo === 'COMPRA' ? parseFloat(tasa_compra) : parseFloat(tasa_venta);
    if (!isNaN(tasaRef) && Math.abs(tasa - tasaRef) > 0.1) {
      logger.warn(`Tasa fuera de rango: ${tasa} vs ${tasaRef}`, { divisa_id, tipo });
      throw new Error(`Tasa fuera de rango. Sugerida: ${tasaRef.toFixed(4)}`);
    }

    // Validar total_soles
    const totalCalculado = Number((monto * tasa).toFixed(2));
    if (Math.abs(totalCalculado - total_soles_input) > 0.01) {
      throw new Error(`Total soles inconsistente. Calculado: ${totalCalculado}`);
    }
    const total_soles = totalCalculado;

    // Inicializar y obtener saldos
    const divisasInvolucradas = [1, divisa_id];
    const saldoMap = {};
    for (const dId of divisasInvolucradas) {
      const [exists] = await connection.query(
        'SELECT id, saldo_actual FROM caja_saldos WHERE caja_id = ? AND divisa_id = ? FOR UPDATE',
        [caja_id, dId]
      );
      if (!exists.length) {
        await connection.query(
          'INSERT INTO caja_saldos (caja_id, divisa_id, saldo_inicial, saldo_actual) VALUES (?, ?, 0, 0)',
          [caja_id, dId]
        );
        saldoMap[dId] = 0;
      } else {
        saldoMap[dId] = Number(exists[0].saldo_actual);
      }
    }

    // Validar saldos (ahora como advertencia, permite negativos)
    if (tipo === 'COMPRA' && saldoMap[1] < total_soles) {
      logger.warn(`Saldo insuficiente en PEN: S/ ${saldoMap[1].toFixed(2)} - Procediendo con balance negativo por fluctuaciones/estrategia`, { user: req.user.id });
    }
    if (tipo === 'VENTA' && saldoMap[divisa_id] < monto) {
      logger.warn(`Saldo insuficiente en ${divisa_codigo}: ${saldoMap[divisa_id].toFixed(2)} - Procediendo with balance negativo por fluctuaciones/estrategia`, { user: req.user.id });
    }
    if (total_soles > 10000 && !cliente_id) {
      throw new Error('Cliente requerido para transacciones > S/10,000');
    }

    // Calcular utilidad (solo para ventas) y manejar comision
    let utilidad = null;
    let comisionFinal = comision; // 🆕 Usar comision del frontend o 0
    if (tipo === 'VENTA') {
      let costoTotal = 0;
      const [lotes] = await connection.query(
        'SELECT id, monto, costo_base FROM divisas_inventario WHERE divisa_id = ? AND caja_id = ? AND disponible = TRUE',
        [divisa_id, caja_id]
      );
      logger.info(`Inventario disponible para ${divisa_codigo}:`, { lotes: lotes, caja_id, divisa_id });
      if (lotes.length) {
        const totalMonto = lotes.reduce((sum, lote) => sum + Number(lote.monto), 0);
        if (totalMonto >= monto) {
          const costoPonderado = lotes.reduce((sum, lote) => sum + Number(lote.monto) * Number(lote.costo_base), 0) / totalMonto;
          costoTotal = monto * costoPonderado;
          let montoRestante = monto;
          for (const lote of lotes) {
            if (montoRestante <= 0) break;
            const montoUsado = Math.min(montoRestante, Number(lote.monto));
            await connection.query(
              'UPDATE divisas_inventario SET monto = monto - ?, disponible = IF(monto - ? <= 0, FALSE, TRUE) WHERE id = ?',
              [montoUsado, montoUsado, lote.id]
            );
            montoRestante -= montoUsado;
            logger.info(`Consumiendo lote: ID ${lote.id}, monto usado: ${montoUsado}, costo base: ${lote.costo_base}`, { divisa_id });
          }
        } else {
          logger.warn(`Inventario insuficiente para divisa ${divisa_id}, usando tasa_compra`, { caja_id, user: req.user.id });
          costoTotal = monto * tasa_compra;
        }
      } else {
        costoTotal = monto * tasa_compra;
      }
      utilidad = Number((total_soles - costoTotal).toFixed(2));
      comisionFinal = utilidad; // Para VENTA, comision = utilidad
      if (utilidad < 0) {
        logger.warn(`Utilidad negativa registrada: S/ ${utilidad}`, { divisa_id, tasa, costoTotal });
      }
    } else {
      // Para compras, registrar en el inventario
      await connection.query(
        'INSERT INTO divisas_inventario (divisa_id, caja_id, monto, costo_base, fecha_adquisicion) VALUES (?, ?, ?, ?, NOW())',
        [divisa_id, caja_id, monto, tasa]
      );
      logger.info(`Lote registrado en inventario: ${monto} ${divisa_codigo}, costo base: ${tasa}`, { divisa_id, caja_id });
    }

    // Insertar transacción
    const [result] = await connection.query(
      'INSERT INTO transacciones (caja_id, tipo, divisa_id, cliente_id, monto, comision, tipo_cambio, total_soles, utilidad, usuario_id, fecha) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [caja_id, tipo, divisa_id, cliente_id, monto, comisionFinal, tasa, total_soles, utilidad, req.user.id]
    );
    const transaccion_id = result.insertId;

    // Actualizar saldos
    const saldoUpdates = [
      { divisa_id: 1, delta: tipo === 'COMPRA' ? -total_soles : total_soles },
      { divisa_id: divisa_id, delta: tipo === 'COMPRA' ? monto : -monto }
    ];
    for (const { divisa_id, delta } of saldoUpdates) {
      await connection.query(
        'UPDATE caja_saldos SET saldo_actual = saldo_actual + ? WHERE caja_id = ? AND divisa_id = ?',
        [delta, caja_id, divisa_id]
      );
    }

    // Registrar movimientos
    const movimientos = [
      {
        tipo: tipo === 'COMPRA' ? 'EGRESO' : 'INGRESO',
        divisa_id: 1,
        monto: total_soles,
        descripcion: tipo === 'COMPRA' ? `Pago cliente: ${tipo} de ${divisa_codigo} (Tx #${transaccion_id})` : `Recibido cliente: ${tipo} de ${divisa_codigo} (Tx #${transaccion_id})`
      },
      {
        tipo: tipo === 'COMPRA' ? 'INGRESO' : 'EGRESO',
        divisa_id: divisa_id,
        monto: monto,
        descripcion: tipo === 'COMPRA' ? `Recibido: ${tipo} de ${divisa_codigo} (Tx #${transaccion_id})` : `Entregado: ${tipo} de ${divisa_codigo} (Tx #${transaccion_id})`
      }
    ];
    if (tipo === 'VENTA' && utilidad !== null) {
      movimientos.push({
        tipo: utilidad >= 0 ? 'INGRESO' : 'EGRESO',
        divisa_id: 1,
        monto: Math.abs(utilidad),
        descripcion: utilidad >= 0 
          ? `Utilidad: ${tipo} de ${divisa_codigo} (Tx #${transaccion_id}) (+${utilidad})`
          : `Pérdida: ${tipo} de ${divisa_codigo} (Tx #${transaccion_id}) (${utilidad})`
      });
    }
    await connection.query(
      'INSERT INTO movimientos_caja (caja_id, tipo, divisa_id, monto, descripcion, usuario_id, fecha) VALUES ' +
      movimientos.map(() => '(?, ?, ?, ?, ?, ?, NOW())').join(','),
      movimientos.flatMap(m => [caja_id, m.tipo, m.divisa_id, m.monto, m.descripcion, req.user.id])
    );

    // Actualizar utilidad total
    if (tipo === 'VENTA' && utilidad !== null) {
      await connection.query('UPDATE caja SET utilidad_total = utilidad_total + ? WHERE id = ?', [utilidad, caja_id]);
    }

    // Log saldos finales
    const [newSaldos] = await connection.query(
      'SELECT d.codigo, cs.saldo_actual FROM caja_saldos cs JOIN divisas d ON cs.divisa_id = d.id WHERE cs.caja_id = ?',
      [caja_id]
    );
    logger.info(`Saldos después - Caja ${caja_id}`, { saldos: newSaldos });

    await connection.commit();
    res.json({ success: true, data: { transaccion_id, utilidad } });
  } catch (err) {
    await connection.rollback();
    logger.error(`Error registrando transacción: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, msg: `Error: ${err.message}` });
  } finally {
    connection.release();
  }
});

// 🆕 GET /api/transacciones/recientes - Lista últimos recibos (ahora sin filtro por caja abierta, con paginación)
router.get('/recientes', auth, async (req, res) => {
  const transaccionQuerySchema = Joi.object({
    limit: Joi.number().integer().min(1).max(100).default(10),
    offset: Joi.number().integer().min(0).default(0),
  });

  const { error, value } = transaccionQuerySchema.validate(req.query, { convert: true });
  if (error) {
    logger.error(`Validación fallida en GET /api/transacciones/recientes: ${error.details.map(d => d.message).join(', ')}`, { user: req.user.id });
    return res.status(400).json({ success: false, msg: error.details.map(d => d.message).join(', ') });
  }

  const { limit, offset } = value;

  try {
    logger.info(`Obteniendo ${limit} recibos recientes (offset: ${offset})`, { user: req.user.id });
    const [recibos] = await pool.query(
      `SELECT 
         t.id, t.tipo, t.divisa_id, d.codigo AS divisa_codigo, d.nombre AS divisa_nombre,
         t.cliente_id, c.nombre AS cliente_nombre, c.whatsapp,
         t.monto, t.comision, t.tipo_cambio AS tasa, t.total_soles, t.utilidad, t.fecha
       FROM transacciones t
       JOIN divisas d ON t.divisa_id = d.id
       LEFT JOIN clientes c ON t.cliente_id = c.id
       WHERE t.usuario_id = ? 
       ORDER BY t.fecha DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    const formattedRecibos = recibos.map(t => ({
      id: t.id,
      tipo: t.tipo.toUpperCase(),
      divisa: { id: t.divisa_id, codigo: t.divisa_codigo, nombre: t.divisa_nombre },
      cliente_id: t.cliente_id,
      cliente_nombre: t.cliente_nombre || 'Sin cliente',
      whatsapp: t.whatsapp || null,
      monto: Number(t.monto).toFixed(2),
      comision: Number(t.comision || 0).toFixed(2),
      tasa: Number(t.tasa).toFixed(3),
      total_soles: Number(t.total_soles).toFixed(2),
      utilidad: t.utilidad !== null ? Number(t.utilidad).toFixed(2) : null,
      fecha: new Date(t.fecha).toLocaleString('es-PE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'America/Lima',
      }),
    }));

    logger.info(`Recibos recientes obtenidos exitosamente`, { count: recibos.length, user: req.user.id });
    res.json({ success: true, data: formattedRecibos, total: recibos.length });
  } catch (err) {
    logger.error(`Error obteniendo recibos recientes: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, msg: `Error: ${err.message}` });
  }
});

// GET /api/transacciones/:id - Detalles de un recibo específico (sin filtro por caja abierta)
router.get('/:id', auth, async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    logger.error(`ID de recibo inválido: ${id}`, { user: req.user.id });
    return res.status(400).json({ success: false, msg: 'ID de recibo inválido' });
  }
  try {
    logger.info(`Obteniendo detalles de recibo ${id}`, { user: req.user.id });
    const [recibo] = await pool.query(
      `SELECT 
         t.id, t.tipo, t.divisa_id, d.codigo AS divisa_codigo, d.nombre AS divisa_nombre,
         t.cliente_id, c.nombre AS cliente_nombre, c.whatsapp,
         t.monto, t.comision, t.tipo_cambio AS tasa, t.total_soles, t.utilidad, t.fecha
       FROM transacciones t
       JOIN divisas d ON t.divisa_id = d.id
       LEFT JOIN clientes c ON t.cliente_id = c.id
       WHERE t.id = ? AND t.usuario_id = ?`,
      [id, req.user.id]
    );

    if (!recibo.length) {
      logger.warn(`Recibo ${id} no encontrado o no autorizado`, { user: req.user.id });
      return res.status(404).json({ success: false, msg: 'Recibo no encontrado' });
    }

    const formattedRecibo = {
      id: recibo[0].id,
      tipo: recibo[0].tipo.toUpperCase(),
      divisa: { id: recibo[0].divisa_id, codigo: recibo[0].divisa_codigo, nombre: recibo[0].divisa_nombre },
      cliente_id: recibo[0].cliente_id,
      cliente_nombre: recibo[0].cliente_nombre || 'Sin cliente',
      whatsapp: recibo[0].whatsapp || null,
      monto: Number(recibo[0].monto).toFixed(2),
      comision: Number(recibo[0].comision || 0).toFixed(2),
      tasa: Number(recibo[0].tasa).toFixed(3),
      total_soles: Number(recibo[0].total_soles).toFixed(2),
      utilidad: recibo[0].utilidad !== null ? Number(recibo[0].utilidad).toFixed(2) : null,
      fecha: new Date(recibo[0].fecha).toLocaleString('es-PE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'America/Lima',
      }),
    };

    logger.info(`Detalles de recibo ${id} obtenidos exitosamente`, { user: req.user.id });
    res.json({ success: true, data: formattedRecibo });
  } catch (err) {
    logger.error(`Error obteniendo detalles de recibo ${id}: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, msg: `Error: ${err.message}` });
  }
});

module.exports = router;