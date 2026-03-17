const zlib = require("zlib");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "CLAVE_SUPER_SECRETA_CAMBIAR";

const clients = {};
const terminals = {};
const { Client } = require("ssh2");

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mysql = require("mysql2");

const app = express();
const server = http.createServer(app);

/* IMPORTANTE: debe ir antes de las rutas */
app.use(express.json());
app.use(cookieParser());

const wss = new WebSocket.Server({ noServer: true });

function parseCookies(cookieHeader) {

  const list = {};

  if (!cookieHeader) return list;

  cookieHeader.split(";").forEach(cookie => {

    const parts = cookie.split("=");

    const key = parts[0].trim();
    const value = parts[1];

    list[key] = decodeURIComponent(value);

  });

  return list;

}

/* -------------------------
   endpoint de login
-------------------------- */

app.post("/api/login", (req, res) => {

  const { username, password } = req.body;

  const sql = "SELECT * FROM users WHERE username = ?";

  db.query(sql, [username], async (err, results) => {

    if (err) return res.status(500).json({ error: err });

    if (results.length === 0) {
      return res.json({ success: false });
    }

    const user = results[0];

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.json({ success: false });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: true, // true cuando usemos HTTPS
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000
    });

    res.json({ success: true });

  });

});

/* -------------------------
   endpoint logout
-------------------------- */

app.post("/api/logout", (req, res) => {

  res.clearCookie("token");

  res.json({ success: true });

});

/* -------------------------
   Middleware de autenticación
-------------------------- */

function auth(req, res, next) {

  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {

    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();

  } catch {

    return res.status(401).json({ error: "Token inválido" });

  }

}

app.get("/api/me", auth, (req, res) => {

  res.json({
    success: true,
    user: req.user
  });

});


/* TERMINAL WEBSOCKET */
const termWSS = new WebSocket.Server({ noServer: true });


/* -------------------------
   CONEXION A MYSQL
-------------------------- */

const db = mysql.createConnection({
  host: "localhost",
  user: "raspberry",
  password: "clave_segura",
  database: "raspberry_manager"
});

db.connect((err) => {
  if (err) {
    console.log("Error MySQL:", err);
    return;
  }

  console.log("MySQL conectado");
});

/* -------------------------
   SERVIDOR WEB
-------------------------- */

app.use(express.static("public"));

/* LISTAR RASPBERRIES */

app.get("/api/raspberries", auth, (req, res) => {

  const sql = "SELECT * FROM raspberries ORDER BY last_seen DESC";

  db.query(sql, (err, results) => {

    if (err) {
      res.status(500).json({ error: err });
      return;
    }

    res.json(results);

  });

});

/* ENVIAR COMANDOS */

app.post("/api/command", auth, (req, res) => {

  const { id, command } = req.body;

  const client = clients[id];

  if (!client) {
    return res.json({ success: false, message: "Raspberry offline" });
  }

  client.send(JSON.stringify({
    type: "command",
    command: command
  }));

  res.json({ success: true });

});

/* -------------------------
   WEBSOCKET RASPBERRY
-------------------------- */

wss.on("connection", (ws) => {

  console.log("Raspberry conectada");

  ws.on("message", (message) => {

    const data = JSON.parse(message);

    console.log("Mensaje:", data);

    /* REGISTER */

    if (data.type === "register") {

      const id = data.id;

      clients[id] = ws;

      console.log("Registrando Raspberry:", id);

      const sql = `
        INSERT INTO raspberries (id, last_seen, created_at)
        VALUES (?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE last_seen = NOW()
      `;

      db.query(sql, [id]);

    }

    /* -------------------
       REGISTRO DE CLAVE SSH PARA TUNEL
    ------------------- */
    if (data.type === "register_key") {

      const id = data.id;
      const pubKey = data.key;

      // Validar tipo de clave
      if (!/^ssh-(ed25519|rsa)/.test(pubKey)) {
        console.log("Clave rechazada: tipo no permitido");
        ws.send(JSON.stringify({ type: "register_key_response", success: false, message: "Clave no válida" }));
        return;
      }

      try {
        // Actualizar la clave pública en la tabla raspberries
        const sql = `
            UPDATE raspberries
            SET key_rsp = ?
            WHERE id = ?
        `;
        db.query(sql, [pubKey, id], (err) => {
          if (err) {
            console.error("Error actualizando clave en DB:", err);
            ws.send(JSON.stringify({ type: "register_key_response", success: false, message: "Error DB" }));
            return;
          }

          // Agregar a authorized_keys con permisos de solo túnel
          const line = `\n# ${id}\ncommand="echo Túnel conectado",no-agent-forwarding,no-X11-forwarding,no-pty ${pubKey}\n`;
          const AUTH_KEYS_PATH = "/home/ubuntu/.ssh/authorized_keys";
          const fs = require("fs");
          fs.appendFileSync(AUTH_KEYS_PATH, line);

          console.log(`Clave registrada para Raspberry ${id} con permisos de túnel`);
          ws.send(JSON.stringify({ type: "register_key_response", success: true }));
        });

      } catch (err) {
        console.error("Error registrando clave:", err);
        ws.send(JSON.stringify({ type: "register_key_response", success: false, message: "Error interno" }));
      }

    }

    /* HEARTBEAT */

    if (data.type === "heartbeat") {

      const id = data.id;

      const sql = `
        UPDATE raspberries
        SET last_seen = NOW()
        WHERE id = ?
      `;

      db.query(sql, [id]);

    }

    if (data.type === "terminal_output") {

      const terminal = terminals[data.id];

      if (terminal) {

        terminal.send(data.data);

      }

    }

  });

  ws.on("close", () => {
    console.log("Raspberry desconectada");
  });

});

/* -------------------------
   TERMINAL SSH
-------------------------- */

server.on("upgrade", (req, socket, head) => {

  if (req.url.startsWith("/terminal")) {

    /* leer cookies */

    const cookies = parseCookies(req.headers.cookie);

    const token = cookies.token;

    if (!token) {

      console.log("Terminal bloqueada: no token");

      socket.destroy();

      return;

    }

    try {

      jwt.verify(token, JWT_SECRET);

    } catch {

      console.log("Terminal bloqueada: token inválido");

      socket.destroy();

      return;

    }

    /* si el token es válido */

    termWSS.handleUpgrade(req, socket, head, (ws) => {
      termWSS.emit("connection", ws, req);
    });

  } else {

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });

  }

});

termWSS.on("connection", (ws, req) => {

  console.log("Nueva terminal request:", req.url);

  const url = new URL(req.url, "http://localhost");

  const id = url.searchParams.get("id");

  console.log("ID solicitado:", id);
  console.log("Clientes conectados:", Object.keys(clients));

  const client = clients[id];

  if (!client) {

    ws.send("Raspberry offline");

    ws.close();

    return;

  }

  terminals[id] = ws;

  console.log("Iniciando terminal en:", id);

  client.send(JSON.stringify({
    type: "terminal_start"
  }));

  ws.on("message", (data) => {

    client.send(JSON.stringify({
      type: "terminal_input",
      data: data.toString()
    }));

  });

});

/* -------------------------
   INICIAR SERVIDOR
-------------------------- */

app.all(/^\/web\/([^\/]+)\/?(.*)/, auth, (req, res) => {

  const id = req.params[0];
  const path = req.params[1] || "";

  const client = clients[id];

  if (!client) {
    return res.status(404).send("Raspberry offline");
  }

  const requestId = Date.now() + Math.random();

  const headers = { ...req.headers };
  headers.host = "127.0.0.1";

  const body = req.body
    ? Buffer.from(JSON.stringify(req.body)).toString("base64")
    : "";

  const timeout = setTimeout(() => {
    client.removeListener("message", handler);
    res.status(504).send("Timeout");
  }, 10000);

  const handler = (message) => {

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type !== "web_response") return;
    if (data.requestId !== requestId) return;

    clearTimeout(timeout);

    res.status(data.status);

    Object.entries(data.headers || {}).forEach(([k, v]) => {

      const key = k.toLowerCase();


      if (key === "set-cookie") {

        let cookies = Array.isArray(v) ? v : [v];

        cookies = cookies.map(c =>
          c.replace(/path=\//i, `path=/web/${id}/`)
        );

        res.setHeader("set-cookie", cookies);

        return;
      }

    });

    let buffer = Buffer.from(data.body, "base64");

    const encoding = data.headers["content-encoding"];

    if (encoding === "gzip") {
      try {
        buffer = zlib.gunzipSync(buffer);
        res.removeHeader("content-encoding");
      } catch (e) {
        console.log("Error al descomprimir gzip:", e);
      }
    }

    let contentType = data.headers["content-type"] || "";

    if (contentType.includes("text/html")) {

      let html = buffer.toString("utf-8");

      const basePath = `/web/${id}`;

      // 🔥 REESCRIBIR rutas absolutas
      html = html.replace(/(href|src)=["']\/(.*?)["']/g, (match, attr, path) => {
        return `${attr}="${basePath}/${path}"`;
      });

      // 🔥 agregar base tag (MUY IMPORTANTE)
      html = html.replace(
        "<head>",
        `<head><base href="${basePath}/">`
      );

      res.end(html);

    } else {
      res.end(buffer);
    }

    client.removeListener("message", handler);
  };

  client.on("message", handler);

  client.send(JSON.stringify({
    type: "web_request",
    requestId,
    method: req.method,
    path: "/" + path,
    headers,
    body
  }));

});

server.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});