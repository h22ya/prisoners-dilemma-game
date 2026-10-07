const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const rooms = new Map();

function roomCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makePairs(playerIds) {
  const ids = shuffle(playerIds);
  const pairs = [];
  for (let i = 0; i + 1 < ids.length; i += 2) pairs.push([ids[i], ids[i + 1]]);
  const bye = ids.length % 2 ? ids[ids.length - 1] : null;
  return { pairs, bye };
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, nickname: p.nickname, connected: p.connected,
    total: p.total,
    choices: room.roundChoices[p.id] || null
  }));
}

function teacherState(room) {
  return {
    phase: room.phase,
    round: room.round,
    players: publicPlayers(room),
    results: room.results,
    bye: room.bye
  };
}

function studentState(room, socketId) {
  const me = room.players.get(socketId);
  const opponentId = room.pairs.find(pair => pair.includes(socketId))?.find(id => id !== socketId) || null;
  const opponent = opponentId ? room.players.get(opponentId) : null;
  const myChoice = room.roundChoices[socketId] || null;
  const result = room.results[room.round - 1]?.find(r => r.a === socketId || r.b === socketId) || null;

  return {
    phase: room.phase,
    round: room.round,
    me: me ? { id: me.id, nickname: me.nickname, total: me.total } : null,
    opponent: opponent ? { id: opponent.id, nickname: opponent.nickname } : null,
    myChoice,
    result,
    bye: room.bye === socketId
  };
}

function emitRoom(room) {
  if (room.teacher) io.to(room.teacher).emit("teacherState", teacherState(room));
  for (const [id, p] of room.players) {
    if (p.connected) io.to(id).emit("studentState", studentState(room, id));
  }
}

function resolveRound(room) {
  const roundResults = [];
  for (const [a, b] of room.pairs) {
    const ca = room.roundChoices[a];
    const cb = room.roundChoices[b];
    if (!ca || !cb) continue;

    let pa, pb;
    if (ca === "C" && cb === "C") [pa, pb] = [3, 3];
    else if (ca === "C" && cb === "D") [pa, pb] = [0, 5];
    else if (ca === "D" && cb === "C") [pa, pb] = [5, 0];
    else [pa, pb] = [1, 1];

    room.players.get(a).total += pa;
    room.players.get(b).total += pb;
    roundResults.push({
      a, b,
      aNickname: room.players.get(a).nickname,
      bNickname: room.players.get(b).nickname,
      aChoice: ca, bChoice: cb, aPoints: pa, bPoints: pb
    });
  }
  room.results.push(roundResults);
  room.phase = room.round >= 3 ? "finished" : "roundResult";
  emitRoom(room);
}

function allChoicesMade(room) {
  return room.pairs.every(([a,b]) => room.roundChoices[a] && room.roundChoices[b]);
}

io.on("connection", socket => {
  socket.on("createRoom", async (_, cb) => {
    const code = roomCode();
    const room = {
      code,
      teacher: socket.id,
      players: new Map(),
      round: 0,
      phase: "lobby",
      pairs: [],
      bye: null,
      roundChoices: {},
      results: []
    };
    rooms.set(code, room);
    const url = `${process.env.PUBLIC_URL || ""}/?room=${code}`;
    const qrData = await QRCode.toDataURL(url);
    socket.join(code);
    cb({ ok: true, code, qr: qrData, url });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, nickname }, cb) => {
    code = String(code || "").trim().toUpperCase();
    nickname = String(nickname || "").trim().slice(0, 20);
    const room = rooms.get(code);
    if (!room) return cb({ ok:false, error:"방을 찾을 수 없습니다." });
    if (!nickname) return cb({ ok:false, error:"닉네임을 입력해주세요." });
    if (room.phase !== "lobby") return cb({ ok:false, error:"이미 게임이 시작된 방입니다." });
    const duplicate = [...room.players.values()].some(p => p.nickname.toLowerCase() === nickname.toLowerCase());
    if (duplicate) return cb({ ok:false, error:"이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요." });

    room.players.set(socket.id, { id:socket.id, nickname, total:0, connected:true });
    socket.join(code);
    cb({ ok:true, code });
    emitRoom(room);
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.teacher !== socket.id) return cb({ok:false, error:"권한이 없습니다."});
    if (room.players.size < 2) return cb({ok:false, error:"학생이 2명 이상 필요합니다."});

    room.round = 1;
    room.phase = "playing";
    room.roundChoices = {};
    const made = makePairs([...room.players.keys()]);
    room.pairs = made.pairs;
    room.bye = made.bye;
    emitRoom(room);
    cb({ok:true});
  });

  socket.on("choose", ({ code, choice }, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "playing") return cb({ok:false, error:"지금은 선택할 수 없습니다."});
    if (!["C","D"].includes(choice)) return cb({ok:false, error:"잘못된 선택입니다."});
    if (!room.players.has(socket.id)) return cb({ok:false, error:"참가자를 찾을 수 없습니다."});
    room.roundChoices[socket.id] = choice;
    emitRoom(room);
    if (allChoicesMade(room)) resolveRound(room);
    cb({ok:true});
  });

  socket.on("nextRound", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.teacher !== socket.id) return cb({ok:false, error:"권한이 없습니다."});
    if (room.round >= 3) return cb({ok:false, error:"마지막 라운드입니다."});

    room.round += 1;
    room.phase = "playing";
    room.roundChoices = {};
    // Every round is independently randomized.
    const made = makePairs([...room.players.keys()]);
    room.pairs = made.pairs;
    room.bye = made.bye;
    emitRoom(room);
    cb({ok:true});
  });

  socket.on("reset", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.teacher !== socket.id) return cb({ok:false, error:"권한이 없습니다."});
    for (const p of room.players.values()) p.total = 0;
    room.round = 0; room.phase = "lobby"; room.pairs = []; room.bye = null; room.roundChoices = {}; room.results = [];
    emitRoom(room); cb({ok:true});
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.teacher === socket.id) {
        room.teacher = null;
        continue;
      }
      const p = room.players.get(socket.id);
      if (p) p.connected = false;
      emitRoom(room);
    }
  });
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
