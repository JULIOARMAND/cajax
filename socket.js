// backend/socket.js
const { Server } = require("socket.io");

let io; // instancia global

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: [
        process.env.FRONTEND_URL || "http://localhost:5173",
        "http://localhost:3000",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  console.log("✅ Socket.IO inicializado");

  // Manejo de conexiones
  io.on("connection", (socket) => {
    console.log(`🔌 Usuario conectado: ${socket.id}`);

    // Unirse a una sala específica (ej: transacción, usuario, etc.)
    socket.on("joinRoom", (room) => {
      socket.join(room);
      console.log(`📌 Socket ${socket.id} se unió a la sala ${room}`);
    });

    // Salir de una sala
    socket.on("leaveRoom", (room) => {
      socket.leave(room);
      console.log(`🚪 Socket ${socket.id} salió de la sala ${room}`);
    });

    // Desconexión
    socket.on("disconnect", () => {
      console.log(`❌ Usuario desconectado: ${socket.id}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    throw new Error("⚠️ Socket.IO no ha sido inicializado. Llama a initSocket primero.");
  }
  return io;
}

module.exports = { initSocket, getIO };
