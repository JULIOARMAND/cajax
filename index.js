const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const http = require("http");
require("dotenv").config();

// 🔹 Importar rutas
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const cajaRoutes = require("./routes/caja");
const divisasRoutes = require("./routes/divisas");
const transaccionesRoutes = require("./routes/transacciones");
const clientesRoutes = require("./routes/clientes");
const reportesRoutes = require("./routes/reportes");
const backupRoutes = require("./routes/backup");
const usuariosRoutes = require("./routes/usuarios");

// 🔹 Importar Socket.IO
const { initSocket } = require("./socket");
// 🔹 Importar conexión DB
const pool = require("./db");

const app = express();
const server = http.createServer(app);

// ===============================
// 🛡 Middlewares Globales
// ===============================
app.use(helmet()); // Seguridad básica
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL,
      "http://localhost:5173", // frontend Vite
      "http://localhost:3000", // CRA
    ].filter(Boolean),
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(compression()); // Comprimir respuestas
app.use(express.json()); // Parseo JSON
app.use(morgan("dev")); // Logs de requests

// ===============================
// 📌 Ruta raíz (bienvenida)
// ===============================
app.get("/", (req, res) => {
  res.json({
    msg: "✅ Backend CAJAX funcionando correctamente 🚀",
    version: "1.0.0",
    docs: "/api",
  });
});

// ===============================
// 📌 Ruta de salud (/api/health)
// ===============================
app.get("/api/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({
      status: "ok",
      db: rows[0].result === 2 ? "conectada" : "error",
      socket: "inicializado",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      msg: "Error conectando a la base de datos",
      error: err.message,
    });
  }
});

// ===============================
// 📌 Rutas principales
// ===============================
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/caja", cajaRoutes);
app.use("/api/divisas", divisasRoutes);
app.use("/api/transacciones", transaccionesRoutes);
app.use("/api/clientes", clientesRoutes);
app.use("/api/reportes", reportesRoutes);
app.use("/api/backup", backupRoutes);
app.use("/api/usuarios", usuariosRoutes);

// ===============================
// 🚫 Manejo de rutas no encontradas
// ===============================
app.use((req, res) => {
  res.status(404).json({ msg: "Ruta no encontrada" });
});

// ===============================
// 🚨 Middleware de errores global
// ===============================
app.use((err, req, res, next) => {
  console.error("🔥 Error interno:", err.stack);
  res.status(err.status || 500).json({
    msg: err.message || "Error interno del servidor",
    error: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// ===============================
// 🚀 Inicialización del servidor
// ===============================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});

// Inicializar Socket.IO
initSocket(server);

module.exports = app;

