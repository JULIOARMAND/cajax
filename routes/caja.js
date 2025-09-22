const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const auth = require('../middlewares/auth');
const PDFDocument = require('pdfkit');
const Joi = require('joi');
const winston = require('winston');

// Configuración del logger
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

// Esquemas de validación con Joi
const aperturaSchema = Joi.object({
  saldos: Joi.object()
    .pattern(Joi.string().valid('PEN', 'USD', 'EUR'), Joi.number().min(0))
    .optional()
    .default({ PEN: 0, USD: 0, EUR: 0 }),
  descripcion_ajuste: Joi.string().max(255).optional()
});

const ajusteSchema = Joi.object({
  moneda: Joi.string().valid('PEN', 'USD', 'EUR').required(),
  tipo: Joi.string().valid('INGRESO', 'EGRESO').required(),
  monto: Joi.number().positive().required(),
  descripcion: Joi.string().max(255).required()
});

// Función auxiliar para obtener caja con saldos
async function getCajaWithSaldos(id, userId) {
  try {
    const [caja] = await pool.query(
      `SELECT id, usuario_id, usuario_cierre_id, estado, fecha_apertura, fecha_cierre, utilidad_total 
       FROM caja WHERE id = ? AND usuario_id = ?`,
      [id, userId]
    );
    if (!caja[0]) return null;

    const [saldos] = await pool.query(
      `SELECT d.codigo, COALESCE(cs.saldo_inicial, 0) as saldo_inicial, COALESCE(cs.saldo_actual, 0) as saldo_actual 
       FROM divisas d 
       LEFT JOIN caja_saldos cs ON d.id = cs.divisa_id AND cs.caja_id = ?`,
      [id]
    );

    const saldosMap = saldos.reduce((acc, s) => {
      acc[s.codigo.toLowerCase()] = {
        inicial: Number(s.saldo_inicial).toFixed(2),
        actual: Number(s.saldo_actual).toFixed(2)
      };
      return acc;
    }, { pen: { inicial: '0.00', actual: '0.00' }, usd: { inicial: '0.00', actual: '0.00' }, eur: { inicial: '0.00', actual: '0.00' } });

    return {
      id: caja[0].id,
      usuario_id: caja[0].usuario_id,
      usuario_cierre_id: caja[0].usuario_cierre_id,
      estado: caja[0].estado,
      fecha_apertura: caja[0].fecha_apertura,
      fecha_cierre: caja[0].fecha_cierre,
      utilidad_total: Number(caja[0].utilidad_total || 0).toFixed(2),
      saldos: saldosMap
    };
  } catch (err) {
    logger.error('Error en getCajaWithSaldos:', { error: err.message, caja_id: id, user_id: userId });
    throw err;
  }
}

// Función auxiliar para obtener tasas de cambio SBS (mock)
async function getSbsExchangeRate(currencyCode) {
  const rates = { USD: 3.4805, EUR: 4.070 }; // Tasas promedio SBS 19/09/2025
  logger.info(`Tasa SBS consultada: ${currencyCode} = ${rates[currencyCode] || 1}`);
  return rates[currencyCode] || 1;
}

// Ruta para listar todas las cajas
router.get('/', auth, async (req, res) => {
  try {
    logger.info('Obteniendo lista de cajas para usuario:', { user: req.user.id });
    const [rows] = await pool.query(
      `SELECT id, estado, fecha_apertura, fecha_cierre, utilidad_total 
       FROM caja 
       WHERE usuario_id = ? 
       ORDER BY id DESC`,
      [req.user.id]
    );
    res.json(rows.map(row => ({
      id: row.id,
      estado: row.estado,
      fecha_apertura: row.fecha_apertura,
      fecha_cierre: row.fecha_cierre,
      utilidad_total: Number(row.utilidad_total || 0).toFixed(2)
    })));
  } catch (err) {
    logger.error('Error obteniendo lista de cajas:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo lista de cajas: ' + err.message });
  }
});

// Ruta para obtener caja actual
router.get('/actual', auth, async (req, res) => {
  try {
    logger.info('Obteniendo caja actual para usuario:', { user: req.user.id });
    const [rows] = await pool.query(
      `SELECT id FROM caja 
       WHERE estado = 'ABIERTA' AND usuario_id = ? 
       ORDER BY id DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ msg: 'No hay caja abierta' });

    const caja = await getCajaWithSaldos(rows[0].id, req.user.id);
    res.json(caja);
  } catch (err) {
    logger.error('Error obteniendo caja actual:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo caja actual: ' + err.message });
  }
});

// Ruta para obtener última caja cerrada
router.get('/ultima-cerrada', auth, async (req, res) => {
  try {
    logger.info('Obteniendo última caja cerrada para usuario:', { user: req.user.id });
    const [rows] = await pool.query(
      `SELECT id FROM caja 
       WHERE estado = 'CERRADA' AND usuario_id = ? 
       ORDER BY id DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.json({});

    const caja = await getCajaWithSaldos(rows[0].id, req.user.id);
    res.json(caja);
  } catch (err) {
    logger.error('Error obteniendo última caja cerrada:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo última caja cerrada: ' + err.message });
  }
});

// Ruta para obtener saldos de caja actual
router.get('/saldos', auth, async (req, res) => {
  try {
    logger.info('Obteniendo saldos para usuario:', { user: req.user.id });
    const [caja] = await pool.query(
      `SELECT id FROM caja 
       WHERE estado = 'ABIERTA' AND usuario_id = ? 
       ORDER BY id DESC LIMIT 1`,
      [req.user.id]
    );
    if (!caja.length) return res.status(404).json({ msg: 'No hay caja para mostrar saldos' });

    const [saldos] = await pool.query(
      `SELECT d.codigo, COALESCE(cs.saldo_inicial, 0) as saldo_inicial, COALESCE(cs.saldo_actual, 0) as saldo_actual 
       FROM divisas d 
       LEFT JOIN caja_saldos cs ON d.id = cs.divisa_id AND cs.caja_id = ?`,
      [caja[0].id]
    );

    const saldosMap = saldos.reduce((acc, s) => {
      acc[s.codigo.toLowerCase()] = {
        inicial: Number(s.saldo_inicial).toFixed(2),
        actual: Number(s.saldo_actual).toFixed(2)
      };
      return acc;
    }, { pen: { inicial: '0.00', actual: '0.00' }, usd: { inicial: '0.00', actual: '0.00' }, eur: { inicial: '0.00', actual: '0.00' } });

    res.json(saldosMap);
  } catch (err) {
    logger.error('Error obteniendo saldos:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo saldos: ' + err.message });
  }
});

// Ruta para abrir caja
router.post('/abrir', auth, async (req, res) => {
  const { error, value } = aperturaSchema.validate(req.body);
  if (error) {
    logger.error(`Validación fallida en abrir caja: ${error.details.map(d => d.message).join(', ')}`, { user: req.user.id });
    return res.status(400).json({ msg: error.details.map(d => d.message).join(', ') });
  }

  const { saldos, descripcion_ajuste } = value;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    logger.info('Abriendo nueva caja para usuario:', { user: req.user.id, saldos, descripcion_ajuste });

    // Verificar si ya hay caja abierta
    const [cajaAbierta] = await connection.query(
      `SELECT id FROM caja 
       WHERE estado = 'ABIERTA' AND usuario_id = ? FOR UPDATE`,
      [req.user.id]
    );
    if (cajaAbierta.length) {
      await connection.rollback();
      logger.warn('Intento de abrir caja con una abierta', { user: req.user.id });
      return res.status(400).json({ msg: 'Ya hay una caja abierta' });
    }

    // Insertar nueva caja
    const [result] = await connection.query(
      `INSERT INTO caja (usuario_id, estado, fecha_apertura, utilidad_total, created_at, updated_at) 
       VALUES (?, 'ABIERTA', NOW(), 0, NOW(), NOW())`,
      [req.user.id]
    );
    const caja_id = result.insertId;

    // Insertar saldos iniciales
    const [divisas] = await connection.query('SELECT id, codigo FROM divisas');
    const divisaMap = divisas.reduce((acc, d) => {
      acc[d.codigo.toUpperCase()] = d.id;
      return acc;
    }, { PEN: 1 });

    for (const [codigo, saldo] of Object.entries(saldos)) {
      const divisa_id = divisaMap[codigo.toUpperCase()];
      if (!divisa_id) continue;
      await connection.query(
        `INSERT INTO caja_saldos (caja_id, divisa_id, saldo_inicial, saldo_actual) 
         VALUES (?, ?, ?, ?)`,
        [caja_id, divisa_id, saldo, saldo]
      );
    }

    // Si hay ajuste, registrar movimiento
    if (descripcion_ajuste) {
      await connection.query(
        `INSERT INTO movimientos_caja (caja_id, tipo, divisa_id, monto, descripcion, usuario_id, fecha) 
         VALUES (?, 'AJUSTE', 1, 0, ?, ?, NOW())`,
        [caja_id, descripcion_ajuste, req.user.id]
      );
    }

    await connection.commit();
    const cajaNueva = await getCajaWithSaldos(caja_id, req.user.id);
    res.json({ msg: 'Caja abierta exitosamente', caja: cajaNueva });
  } catch (err) {
    await connection.rollback();
    logger.error('Error abriendo caja:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error abriendo caja: ' + err.message });
  } finally {
    connection.release();
  }
});

// Ruta para ajustar caja
router.post('/ajustar', auth, async (req, res) => {
  const { error, value } = ajusteSchema.validate(req.body);
  if (error) {
    logger.error(`Validación fallida en ajustar caja: ${error.details.map(d => d.message).join(', ')}`, { user: req.user.id });
    return res.status(400).json({ msg: error.details.map(d => d.message).join(', ') });
  }

  const { moneda, tipo, monto, descripcion } = value;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    logger.info('Ajustando caja para usuario:', { user: req.user.id, moneda, tipo, monto, descripcion });

    // Obtener caja abierta
    const [cajaAbierta] = await connection.query(
      `SELECT id FROM caja 
       WHERE estado = 'ABIERTA' AND usuario_id = ? 
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [req.user.id]
    );
    if (!cajaAbierta.length) {
      await connection.rollback();
      return res.status(404).json({ msg: 'No hay caja abierta para ajustar' });
    }
    const caja_id = cajaAbierta[0].id;

    // Obtener divisa_id
    const [divisa] = await connection.query('SELECT id FROM divisas WHERE codigo = ?', [moneda]);
    if (!divisa.length) {
      await connection.rollback();
      return res.status(400).json({ msg: `Moneda ${moneda} no encontrada` });
    }
    const divisa_id = divisa[0].id;

    // Verificar saldo actual
    const [saldo] = await connection.query(
      'SELECT saldo_actual FROM caja_saldos WHERE caja_id = ? AND divisa_id = ?',
      [caja_id, divisa_id]
    );
    const saldo_actual = Number(saldo[0]?.saldo_actual || 0);
    const nuevo_saldo = tipo === 'INGRESO' ? saldo_actual + monto : saldo_actual - monto;
    if (nuevo_saldo < 0) {
      await connection.rollback();
      return res.status(400).json({ msg: `El ajuste resultaría en saldo negativo en ${moneda}` });
    }

    if (saldo.length) {
      await connection.query(
        `UPDATE caja_saldos SET saldo_actual = ? 
         WHERE caja_id = ? AND divisa_id = ?`,
        [nuevo_saldo, caja_id, divisa_id]
      );
    } else {
      await connection.query(
        `INSERT INTO caja_saldos (caja_id, divisa_id, saldo_inicial, saldo_actual) 
         VALUES (?, ?, 0, ?)`,
        [caja_id, divisa_id, nuevo_saldo]
      );
    }

    await connection.query(
      `INSERT INTO movimientos_caja (caja_id, tipo, divisa_id, monto, descripcion, usuario_id, fecha) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [caja_id, tipo, divisa_id, monto, descripcion, req.user.id]
    );

    await connection.commit();
    const cajaActualizada = await getCajaWithSaldos(caja_id, req.user.id);
    res.json({ msg: 'Ajuste registrado exitosamente', caja: cajaActualizada });
  } catch (err) {
    await connection.rollback();
    logger.error('Error ajustando caja:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error ajustando caja: ' + err.message });
  } finally {
    connection.release();
  }
});

// Ruta para obtener movimientos de caja
router.get('/movimientos', auth, async (req, res) => {
  try {
    logger.info('Obteniendo movimientos para usuario:', { user: req.user.id });
    const { incluirCerradas = false } = req.query;
    const incluirCerradasBool = incluirCerradas === 'true' || incluirCerradas === true;

    // Selecciona movimientos de todas las cajas si incluirCerradas=true, solo de la caja abierta si no
    const whereClause = incluirCerradasBool
      ? 'c.usuario_id = ?'
      : 'c.usuario_id = ? AND c.estado = "ABIERTA"';

    const [movimientos] = await pool.query(
      `SELECT m.*, d.codigo AS divisa_codigo, c.id AS caja_id, c.fecha_apertura, c.estado 
       FROM movimientos_caja m 
       JOIN divisas d ON m.divisa_id = d.id 
       JOIN caja c ON m.caja_id = c.id 
       WHERE ${whereClause} 
       ORDER BY m.fecha DESC LIMIT 50`,
      [req.user.id]
    );

    res.json(movimientos.map(m => ({
      id: m.id,
      caja_id: m.caja_id,
      tipo: m.tipo,
      monto: Number(m.monto).toFixed(2),
      divisa_codigo: m.divisa_codigo,
      descripcion: m.descripcion,
      fecha: new Date(m.fecha).toLocaleString('es-PE'),
      usuario_id: m.usuario_id
    })));
  } catch (err) {
    logger.error('Error obteniendo movimientos:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo movimientos: ' + err.message });
  }
});

// Ruta para obtener utilidad de caja
router.get('/utilidad', auth, async (req, res) => {
  try {
    logger.info('Obteniendo utilidad para usuario:', { user: req.user.id });
    const { incluirCerradas = false } = req.query;
    const whereClause = incluirCerradas ? 'usuario_id = ?' : 'estado = "ABIERTA" AND usuario_id = ?';
    const [rows] = await pool.query(
      `SELECT SUM(utilidad_total) as utilidad_total FROM caja WHERE ${whereClause}`,
      [req.user.id]
    );
    res.json({ utilidad: Number(rows[0].utilidad_total || 0).toFixed(2) });
  } catch (err) {
    logger.error('Error obteniendo utilidad:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo utilidad: ' + err.message });
  }
});

// Ruta para cerrar una caja
router.post('/cerrar', auth, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    logger.info('Cerrando caja para usuario:', { user: req.user.id });

    // Corregida: Eliminado alias redundante 'caja caja'
    const [cajaAbierta] = await connection.query(
      `SELECT id FROM caja 
       WHERE estado = 'ABIERTA' AND usuario_id = ? 
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [req.user.id]
    );
    if (!cajaAbierta.length) {
      await connection.rollback();
      logger.warn('No hay caja abierta para cerrar', { user: req.user.id });
      return res.status(404).json({ msg: 'No hay caja abierta para cerrar' });
    }
    const caja_id = cajaAbierta[0].id;

    // Validar transacciones pendientes (opcional, ajusta según schema)
    const [transaccionesPendientes] = await connection.query(
      `SELECT COUNT(*) as count FROM transacciones WHERE caja_id = ? AND estado = 'PENDIENTE'`,
      [caja_id]
    );
    if (transaccionesPendientes[0].count > 0) {
      await connection.rollback();
      logger.warn('Intento de cerrar caja con transacciones pendientes', { user: req.user.id, caja_id });
      return res.status(400).json({ msg: 'No se puede cerrar la caja con transacciones pendientes' });
    }

    // Actualizar caja a cerrada
    await connection.query(
      `UPDATE caja 
       SET estado = 'CERRADA', fecha_cierre = NOW(), usuario_cierre_id = ?, updated_at = NOW(), closed_at = NOW() 
       WHERE id = ?`,
      [req.user.id, caja_id]
    );

    const cajaCerrada = await getCajaWithSaldos(caja_id, req.user.id);

    // Generar PDF de cierre
    const doc = new PDFDocument();
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="cierre_caja_${caja_id}.pdf"`,
        'Content-Length': pdfData.length
      });
      res.end(pdfData);
    });

    // Contenido del PDF
    doc.fontSize(16).text(`Reporte de Cierre de Caja #${caja_id}`, { align: 'center' });
    doc.fontSize(10).text(`Fecha de Cierre: ${new Date().toLocaleString('es-PE')}`, { align: 'center' });
    doc.text(`Usuario: ${req.user.email}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text('Saldos Finales:', { underline: true });
    Object.entries(cajaCerrada.saldos).forEach(([codigo, saldo]) => {
      doc.text(`${codigo.toUpperCase()}: ${Number(saldo.actual).toLocaleString('es-PE', { style: 'currency', currency: codigo.toUpperCase() })}`);
    });
    doc.moveDown();
    doc.text(`Utilidad Total: S/ ${cajaCerrada.utilidad_total}`);
    doc.moveDown(0.5);
    doc.text('Movimientos Recientes:', { underline: true });
    const [movimientos] = await connection.query(
      `SELECT m.tipo, d.codigo, m.monto, m.descripcion, m.fecha 
       FROM movimientos_caja m 
       JOIN divisas d ON m.divisa_id = d.id 
       WHERE m.caja_id = ? ORDER BY m.fecha DESC LIMIT 10`,
      [caja_id]
    );
    movimientos.forEach((m) => {
      doc.text(`• ${new Date(m.fecha).toLocaleString('es-PE')} - ${m.tipo} ${Number(m.monto).toLocaleString('es-PE', { style: 'currency', currency: m.codigo })}: ${m.descripcion}`);
    });
    doc.end();

    await connection.commit();
    logger.info('Caja cerrada exitosamente:', { caja_id, user: req.user.id });
  } catch (err) {
    await connection.rollback();
    logger.error('Error cerrando caja:', { error: err.message, user: req.user.id, query: `SELECT id FROM caja WHERE estado = 'ABIERTA' AND usuario_id = ? ORDER BY id DESC LIMIT 1` });
    res.status(500).json({ msg: 'Error cerrando caja: ' + err.message });
  } finally {
    connection.release();
  }
});

// Ruta para transacciones históricas
router.get('/transacciones', auth, async (req, res) => {
  try {
    const { incluirCerradas = false } = req.query;
    const incluirCerradasBool = incluirCerradas === 'true' || incluirCerradas === true;
    const whereClause = incluirCerradasBool ? 'c.usuario_id = ?' : 'c.usuario_id = ? AND c.estado = "ABIERTA"';
    const [transacciones] = await pool.query(
      `SELECT t.id, t.tipo, t.monto, t.total_soles, t.fecha, d.codigo AS divisa, t.estado 
       FROM transacciones t 
       JOIN divisas d ON t.divisa_id = d.id 
       JOIN caja c ON t.caja_id = c.id 
       WHERE ${whereClause} 
       ORDER BY t.fecha DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(transacciones);
  } catch (err) {
    logger.error('Error obteniendo transacciones:', { error: err.message, user: req.user.id });
    res.status(500).json({ msg: 'Error obteniendo transacciones: ' + err.message });
  }
});

module.exports = router;











