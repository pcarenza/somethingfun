import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { Room } from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000; // rooms vanish after 2h of no activity
const HOST_GONE_MS = 15 * 60 * 1000; // ...or 15 min after the host disconnects

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/healthz", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Room>} */
const rooms = new Map();
/** playerId -> socket id */
const sockets = new Map();

function newPin() {
  for (;;) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(pin)) return pin;
  }
}

function adapterFor(pin) {
  return {
    toRoom: (event, payload) => io.to(`room:${pin}`).emit(event, payload),
    toPlayer: (playerId, event, payload) => {
      const sid = sockets.get(playerId);
      if (sid) io.to(sid).emit(event, payload);
    },
  };
}

function validPlayerId(id) {
  return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

io.on("connection", (socket) => {
  let room = null;
  let playerId = null;

  function attach(r, id) {
    room = r;
    playerId = id;
    sockets.set(id, socket.id);
    socket.join(`room:${r.pin}`);
    r.touch();
  }

  // Wraps a handler so thrown errors go back to the caller via the ack callback.
  const handle = (fn, { hostOnly = false } = {}) =>
    (payload = {}, ack = () => {}) => {
      if (typeof ack !== "function") ack = () => {};
      try {
        if (hostOnly && (!room || !room.isHost(playerId))) throw new Error("Only the host can do that");
        const result = fn(payload);
        if (room) room.touch();
        ack({ ok: true, ...(result || {}) });
      } catch (err) {
        ack({ ok: false, error: err.message });
      }
    };

  socket.on(
    "createRoom",
    handle(({ playerId: id, name, emoji }) => {
      if (!validPlayerId(id)) throw new Error("Bad player id");
      if (room) throw new Error("Already in a room");
      const pin = newPin();
      const r = new Room(pin, { id, name, emoji }, adapterFor(pin));
      rooms.set(pin, r);
      attach(r, id);
      r.broadcastState();
      return { pin };
    }),
  );

  socket.on(
    "joinRoom",
    handle(({ pin, playerId: id, name, emoji }) => {
      if (!validPlayerId(id)) throw new Error("Bad player id");
      const r = rooms.get(String(pin ?? "").trim());
      if (!r) throw new Error("No game found with that PIN");
      if (!r.players.has(id) && r.players.size >= 100) throw new Error("This game is full");
      if (room && room !== r) throw new Error("Already in another room");
      r.addPlayer({ id, name, emoji });
      attach(r, id);
      r.broadcastState();
      return { pin: r.pin };
    }),
  );

  // Rejoin after refresh: only works if this player id is already in the room.
  socket.on(
    "resume",
    handle(({ pin, playerId: id }) => {
      const r = rooms.get(String(pin ?? ""));
      if (!r || !validPlayerId(id) || !r.players.has(id)) throw new Error("Session expired");
      r.setConnected(id, true);
      attach(r, id);
      r.broadcastState();
      return { pin: r.pin };
    }),
  );

  socket.on(
    "leaveRoom",
    handle(() => {
      if (!room) return;
      const r = room;
      socket.leave(`room:${r.pin}`);
      sockets.delete(playerId);
      if (r.isHost(playerId)) {
        r.io.toRoom("roomClosed", { reason: "The host ended the game" });
        r.destroy();
        rooms.delete(r.pin);
      } else {
        r.removePlayer(playerId);
        r.broadcastState();
      }
      room = null;
      playerId = null;
    }),
  );

  socket.on("updateSettings", handle((p) => room.updateSettings(p), { hostOnly: true }));
  socket.on(
    "addCategory",
    handle(({ topic, count }) => {
      room.addCategory(topic, count);
    }, { hostOnly: true }),
  );
  socket.on("removeCategory", handle(({ id }) => room.removeCategory(id), { hostOnly: true }));
  socket.on("startGame", handle(() => room.startGame(), { hostOnly: true }));
  socket.on("nextQuestion", handle(() => room.nextQuestion(), { hostOnly: true }));
  socket.on("backToMenu", handle(() => room.backToMenu(), { hostOnly: true }));

  socket.on("answer", (payload = {}, ack = () => {}) => {
    if (typeof ack !== "function") ack = () => {};
    if (!room) return ack({ ok: false, error: "Not in a game" });
    ack(room.submitAnswer(playerId, payload.choice));
  });

  socket.on("disconnect", () => {
    if (!room || !playerId) return;
    if (sockets.get(playerId) === socket.id) {
      sockets.delete(playerId);
      room.setConnected(playerId, false);
      if (room.isHost(playerId)) room.hostLeftAt = Date.now();
      room.broadcastState();
    }
  });
});

// Garbage-collect abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [pin, r] of rooms) {
    const host = r.players.get(r.hostId);
    const hostGone = !host?.connected && r.hostLeftAt && now - r.hostLeftAt > HOST_GONE_MS;
    if (hostGone || now - r.lastActivity > ROOM_IDLE_MS) {
      r.io.toRoom("roomClosed", { reason: "This game has expired" });
      r.destroy();
      rooms.delete(pin);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Trivia server listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("Note: ANTHROPIC_API_KEY is not set; topic questions will fall back to the built-in bank unless another credential source is configured.");
  }
});

