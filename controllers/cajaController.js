// controllers/cajaController.js
import db from "../config/db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * 📌 Obtener la caja actual (última abierta y no cerrada)
 */
export const getCajaActual = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT *
       FROM caja
       WHERE estado = 'ABIERTA'
       ORDER BY fecha_apertura DESC
       LIMIT 1`
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No hay caja abierta actualmente" });
    }

    res.status(200).json(rows[0]);
  } catch (err) {
    console.error("❌ Error getCajaActual:", err);
    res.status(500).json({ message: "Error al obtener la caja actual" });
  }
};

/**
 * 📌 Abrir caja
 */
export const abrirCaja = async (req, res) => {
  const { saldo_soles = 0, saldo_dolares = 0, saldo_euros = 0 } = req.body;
  const usuario_id = req.user.id;

  try {
    // Verificar si ya existe caja abierta
    const [rows] = await db.query(
      "SELECT * FROM caja WHERE estado = 'ABIERTA' ORDER BY fecha_apertura DESC LIMIT 1"
    );

    if (rows.length > 0) {
      return res.status(400).json({ message: "Ya existe una caja abierta" });
    }

    const [result] = await db.query(
      `INSERT INTO caja (
          id, usuario_id, saldo_soles, saldo_dolares, saldo_euros,
          saldo_soles_inicial, saldo_dolares_inicial, saldo_euros_inicial,
          estado, fecha_apertura
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ABIERTA', NOW())`,
      [
        uuidv4(),
        usuario_id,
        saldo_soles,
        saldo_dolares,
        saldo_euros,
        saldo_soles,
        saldo_dolares,
        saldo_euros,
      ]
    );

    res.status(201).json({ message: "✅ Caja abierta correctamente", id: result.insertId });
  } catch (err) {
    console.error("❌ Error abrirCaja:", err);
    res.status(500).json({ message: "Error al abrir la caja" });
  }
};

/**
 * 📌 Cerrar caja
 */
export const cerrarCaja = async (req, res) => {
  const usuario_id = req.user.id;

  try {
    const [rows] = await db.query(
      "SELECT * FROM caja WHERE estado = 'ABIERTA' ORDER BY fecha_apertura DESC LIMIT 1"
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: "No hay caja abierta para cerrar" });
    }

    const caja = rows[0];

    await db.query(
      "UPDATE caja SET estado = 'CERRADA', fecha_cierre = NOW() WHERE id = ?",
      [caja.id]
    );

    res.status(200).json({
      message: "✅ Caja cerrada correctamente",
      resumen: {
        saldo_soles: caja.saldo_soles,
        saldo_dolares: caja.saldo_dolares,
        saldo_euros: caja.saldo_euros,
      },
    });
  } catch (err) {
    console.error("❌ Error cerrarCaja:", err);
    res.status(500).json({ message: "Error al cerrar la caja" });
  }
};

/**
 * 📌 Utilidad del día
 */
export const getUtilidad = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
          SUM(saldo_soles_inicial) AS total_soles_inicial,
          SUM(saldo_dolares_inicial) AS total_dolares_inicial,
          SUM(saldo_euros_inicial) AS total_euros_inicial,
          SUM(saldo_soles) AS total_soles_actual,
          SUM(saldo_dolares) AS total_dolares_actual,
          SUM(saldo_euros) AS total_euros_actual
       FROM caja
       WHERE DATE(fecha_apertura) = CURDATE()`
    );

    res.status(200).json(rows[0]);
  } catch (err) {
    console.error("❌ Error getUtilidad:", err);
    res.status(500).json({ message: "Error al obtener la utilidad" });
  }
};

