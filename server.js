require("dotenv").config();

const zlib = require("zlib");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "CLAVE_SUPER_SECRETA_CAMBIAR";

const clients = {};
const terminals = {};
const { Client } = require("ssh2");

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mysql = require("mysql2");

const app = express();
const server = http.createServer(app);

/* IMPORTANTE: Configuración de IP Proxy y Body */
app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));
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

  if (!db2) {
    return res.status(500).json({ error: "Falta configurar BD Externa (DB2) para login." });
  }

  const sql = "SELECT * FROM usuarios WHERE usuario = ? AND activo = 1 AND tipo_usuario_id = 1";

  db2.query(sql, [username], async (err, results) => {

    if (err) return res.status(500).json({ error: err });

    if (results.length === 0) {
      return res.json({ success: false, message: "Usuario inexistente o sin permisos." });
    }

    const user = results[0];

    // Lógica Híbrida: Soporta Bcrypt Antiguo, SHA-1 (40 caracteres) o Texto Plano
    let match = false;
    if (user.psw && (user.psw.startsWith("$2a$") || user.psw.startsWith("$2b$") || user.psw.startsWith("$2y$"))) {
      // Si está encriptada con Bcrypt
      match = await bcrypt.compare(password, user.psw);
    } else if (user.psw && user.psw.length === 40) {
      // Si la BD externa usa SHA-1 en crudo (típico de sistemas legacy/AppSheet para 40 letras)
      const crypto = require('crypto');
      const hashSHA1 = crypto.createHash('sha1').update(password).digest('hex');
      match = (hashSHA1 === user.psw);
    } else {
      // Si DB2 lo guardó en texto plano o tiene otra longitud
      match = (password === user.psw);
    }

    if (!match) {
      return res.json({ success: false, message: "Contraseña incorrecta." });
    }

    const token = jwt.sign(
      { username: user.usuario, api_token: user.api_token },
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

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// BASE DE DATOS 2 (SIOMA ESTOMAS Y FINCAS)
// Se activará sola cuando añadas DB2_HOST al archivo .env
let db2 = null;
if (process.env.DB2_HOST) {
  db2 = mysql.createPool({
    host: process.env.DB2_HOST,
    user: process.env.DB2_USER,
    password: process.env.DB2_PASSWORD,
    database: process.env.DB2_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true
  });
  console.log("Conectado a Base de Datos 2 (Sioma Externo)");
}

/* -------------------------
   FUNCIONES AUXILIARES LOGS DE CONEXION
-------------------------- */
function getClientIp(req) {
  let ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || "Desconocida";

  if (ip && typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip && typeof ip === 'string' && ip.startsWith("::ffff:")) ip = ip.substring(7);

  return ip;
}

function registrarLogConexion(estomaId, usuario, tipoOperacion, comandoEjecutado, ip) {
  if (!db) return;
  const sql = `
    INSERT INTO bascula_connection_logs 
    (estoma, usuario, tipo_operacion, comando_ejecutado, fecha, direccion_ip) 
    VALUES (?, ?, ?, ?, NOW(), ?)
  `;
  db.query(sql, [estomaId, usuario, tipoOperacion, comandoEjecutado, ip], (err) => {
    if (err) console.error("Error guardando log de conexión:", err);

    // Autopurga de registros antiguos (Más de 30 días)
    const sqlClean = `DELETE FROM bascula_connection_logs WHERE fecha < DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    db.query(sqlClean);
  });
}

/* -------------------------
   SERVIDOR WEB / INTERCEPTOR
-------------------------- */

app.use((req, res, next) => {
  // Rutas que exigen token válido a nivel de HTML
  const protectedRoutes = ["/", "/index.html", "/terminal.html"];

  if (protectedRoutes.includes(req.path)) {
    const token = req.cookies.token;
    if (!token) return res.redirect("/login.html");
    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      return res.redirect("/login.html");
    }
  }

  // Prevenir que un usuario ya logueado vea el login de nuevo
  if (req.path === "/login.html") {
    const token = req.cookies.token;
    if (token) {
      try {
        jwt.verify(token, JWT_SECRET);
        return res.redirect("/");
      } catch { }
    }
  }

  next();
});

app.use(express.static("public"));

/* LISTAR RASPBERRIES */

app.get("/api/raspberries", auth, (req, res) => {
  // Si la BD2 EXISTE (Arquitectura Maestra de Estomas)
  if (db2) {
    const sql2 = `
      SELECT 
        e.nombre AS id, 
        f.nombre AS finca, 
        t.nombre AS tipo,
        v.fecha AS fecha_viaje,
        b.fecha AS fecha_bandeja,
        val.fecha AS fecha_validacion
      FROM estomas e
      LEFT JOIN fincas f ON e.finca_id = f.finca_id
      LEFT JOIN tipo_estomas t ON e.tipo_estoma_id = t.tipo_estoma_id
      LEFT JOIN viajes v ON e.ultimo_viaje_id = v.viaje_id
      LEFT JOIN bandejas b ON e.ultimo_bandeja_id = b.bandeja_id
      LEFT JOIN validacions val ON e.ultimo_validacion_id = val.validacion_id
    `;
    db2.query(sql2, (err2, db2_results) => {
      if (err2) {
        console.error("Error consultando Mestro Estomas DB2:", err2);
        return res.status(500).json({ error: err2 });
      }

      // Ahora pedimos la telemetría viva a la BD1
      const sql1 = `
        SELECT d.*, r.mac_wlan0 
        FROM device_heartbeat d 
        LEFT JOIN raspberries r ON d.mac_eth0 = r.mac_eth0 
      `;
      db.query(sql1, (err1, db1_results) => {
        if (err1) return res.status(500).json({ error: err1 });

        // Mapa de Vida (Quien esta vivo ahorita)
        const runtimeMap = {};
        db1_results.forEach(row => {
          runtimeMap[row.id] = row;
        });

        // Construimos la lista final con absolutamente todos los estomas
        const listadoFinal = db2_results.map(estoma => {
          const vivo = runtimeMap[estoma.id];

          // Calcular última subida de datos según si son racimos o bandejas
          let ultima_subida = null;
          const tipoStr = (estoma.tipo || "").toLowerCase();
          if (tipoStr.includes("racimo") && estoma.fecha_viaje) {
            ultima_subida = estoma.fecha_viaje;
          } else if (tipoStr.includes("bandeja") && estoma.fecha_bandeja) {
            ultima_subida = estoma.fecha_bandeja;
          }

          return {
            id: estoma.id,
            finca: estoma.finca,
            tipo: estoma.tipo,
            ultima_subida: ultima_subida,
            ultima_validacion: estoma.fecha_validacion,
            // Datos de vida (Si no se ha conectado nunca, van nulos o -)
            mac_eth0: vivo ? vivo.mac_eth0 : "-",
            mac_wlan0: vivo ? vivo.mac_wlan0 : "-",
            last_seen: vivo ? vivo.last_seen : null,
            port_tunnel: vivo ? vivo.port_tunnel : null
          };
        });

        res.json(listadoFinal);
      });
    });
  } else {
    // FALLBACK: Si no has configurado el .env aún, arranca a la antigua (DB1)
    const sqlNormal = `
      SELECT d.*, r.mac_wlan0 
      FROM device_heartbeat d 
      LEFT JOIN raspberries r ON d.mac_eth0 = r.mac_eth0 
      ORDER BY d.last_seen DESC
    `;
    db.query(sqlNormal, (err, db1_results) => {
      if (err) return res.status(500).json({ error: err });
      res.json(db1_results);
    });
  }
});

/* INFORMACION DE DISPOSITIVO */
app.get("/api/device_info", auth, (req, res) => {
  const id = req.query.id;
  const client = clients[id];

  if (!client) {
    return res.json({ success: false, message: "Offline" });
  }

  // Extraer IP cruda
  let ip = client._socket.remoteAddress || "Desconocida";
  if (ip.startsWith("::ffff:")) ip = ip.substring(7);

  const reqId = Date.now().toString() + Math.random().toString();

  const timeout = setTimeout(() => {
    client.removeListener("message", handler);
    res.json({ success: false, message: "Timeout" });
  }, 5000);

  const handler = (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "info_response" && data.reqId === reqId) {
        clearTimeout(timeout);
        client.removeListener("message", handler);
        res.json({
          success: true,
          ip: data.ip || ip,
          temperatura: data.temperatura,
          red: data.red
        });
      }
    } catch (e) { }
  };

  client.on("message", handler);
  client.send(JSON.stringify({ type: "get_info", reqId }));
});

/* HISTORIAL DE AUDITORÍA */
app.get("/api/logs/:id", auth, (req, res) => {
  const estomaId = req.params.id;
  if (!db) return res.status(500).json({ success: false, message: "Sin conexión a Base de Datos" });

  const sql = `
    SELECT usuario, tipo_operacion, comando_ejecutado, direccion_ip, fecha 
    FROM bascula_connection_logs 
    WHERE estoma = ? 
    ORDER BY fecha DESC 
    LIMIT 50
  `;
  db.query(sql, [estomaId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, logs: results });
  });
});

/* ENVIAR COMANDOS */

app.post("/api/command", auth, (req, res) => {

  const { id, command } = req.body;
  const client = clients[id];

  const usuarioLog = req.user ? req.user.username : "Desconocido";
  const ipLog = getClientIp(req);

  let tipoOp = "COMANDO_CUSTOM";
  if (command === "abrir_tunel" || command === "cerrar_tunel") tipoOp = "WEB_TUNNEL";
  else if (command === "reboot") tipoOp = "REBOOT";

  registrarLogConexion(id, usuarioLog, tipoOp, command, ipLog);

  if (!client) return res.json({ success: false, message: "Raspberry offline" });

  if (command === "abrir_tunel") {

    // Generar puerto aleatorio
    const MIN_PORT = 9000;
    const MAX_PORT = 9999;
    const puerto = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;

    // Guardar en DB
    const sql = `UPDATE device_heartbeat SET port_tunnel = ? WHERE id = ?`;
    db.query(sql, [puerto, id], (err) => {
      if (err) {
        console.error("Error guardando puerto:", err);
        return res.json({ success: false, message: "Error DB" });
      }

      // Enviar comando al WebSocket de la Raspberry
      client.send(JSON.stringify({ type: "abrir_tunel", puerto }));

      // Responder al frontend
      return res.json({ success: true, puerto });
    });

    return; // terminar aquí
  }

  if (command === "cerrar_tunel") {
    // Limpiar el puerto en la Base de Datos para que el Frontend desactive el botón visualmente
    const sqlNull = `UPDATE device_heartbeat SET port_tunnel = NULL WHERE id = ?`;
    db.query(sqlNull, [id], () => {
      client.send(JSON.stringify({ type: "command", command }));
      res.json({ success: true });
    });
    return;
  }

  // Para otros comandos (reboot, etc)
  client.send(JSON.stringify({ type: "command", command }));
  res.json({ success: true });

});

/* -------------------------
   GESTOR DE ARCHIVOS (API)
-------------------------- */
app.get("/api/files/list", auth, (req, res) => {
  const { id, path } = req.query;
  const client = clients[id];
  if (!client) return res.json({ success: false, error: "Raspberry offline" });

  const reqId = Date.now().toString() + Math.random().toString();

  const timeout = setTimeout(() => {
    client.removeListener("message", handler);
    res.json({ success: false, error: "Timeout solicitando lista de archivos" });
  }, 10000);

  const handler = (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "list_dir_response" && data.reqId === reqId) {
        clearTimeout(timeout);
        client.removeListener("message", handler);
        if (data.error) {
          res.json({ success: false, error: data.error });
        } else {
          res.json({ success: true, entries: data.entries });
        }
      }
    } catch (e) { }
  };

  client.on("message", handler);
  client.send(JSON.stringify({ type: "list_dir", reqId, path }));
});

app.get("/api/files/download", auth, (req, res) => {
  const { id, path } = req.query;
  const client = clients[id];
  if (!client) return res.status(404).send("Raspberry offline");

  const reqId = Date.now().toString() + Math.random().toString();
  const fileName = path.split('/').pop() || 'descarga';

  const usuarioLog = req.user ? req.user.username : "Desconocido";
  const ipLog = getClientIp(req);
  registrarLogConexion(id, usuarioLog, "DOWNLOAD_FILE", path, ipLog);

  res.setHeader('Content-disposition', 'attachment; filename=' + fileName);
  res.setHeader('Content-type', 'application/octet-stream');

  let lastChunkTime = Date.now();
  let monitorInterval = setInterval(() => {
    if (Date.now() - lastChunkTime > 15000) {
      clearInterval(monitorInterval);
      client.removeListener("message", handler);
      if (!res.headersSent) res.status(504).send("Timeout de descarga");
      res.end();
    }
  }, 5000);

  const handler = (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "read_file_chunk" && data.reqId === reqId) {
        lastChunkTime = Date.now();

        if (data.error) {
          clearInterval(monitorInterval);
          client.removeListener("message", handler);
          if (!res.headersSent) res.status(500).send(data.error);
          return res.end();
        }

        if (data.data) {
          res.write(Buffer.from(data.data, 'base64'));
        }

        if (data.eof) {
          clearInterval(monitorInterval);
          client.removeListener("message", handler);
          res.end();
        }
      }
    } catch (e) { }
  };

  client.on("message", handler);
  client.send(JSON.stringify({ type: "read_file_start", reqId, path }));

  req.on('close', () => {
    clearInterval(monitorInterval);
    client.removeListener("message", handler);
    client.send(JSON.stringify({ type: "read_file_stop", reqId }));
  });
});

app.post("/api/files/upload_init", auth, (req, res) => {
  const { id, path } = req.body;
  const client = clients[id];
  if (!client) return res.json({ success: false, message: "Raspberry offline" });

  const usuarioLog = req.user ? req.user.username : "Desconocido";
  const ipLog = getClientIp(req);
  registrarLogConexion(id, usuarioLog, "UPLOAD_FILE", path, ipLog);

  const reqId = Date.now().toString() + Math.random().toString();

  const timeout = setTimeout(() => {
    client.removeListener("message", handler);
    res.json({ success: false, message: "Timeout iniciando subida" });
  }, 5000);

  const handler = (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "write_file_init_response" && data.reqId === reqId) {
        clearTimeout(timeout);
        client.removeListener("message", handler);
        if (data.error) res.json({ success: false, message: data.error });
        else res.json({ success: true });
      }
    } catch (e) { }
  };

  client.on("message", handler);
  client.send(JSON.stringify({ type: "write_file_init", reqId, path }));
});

app.post("/api/files/upload_chunk", auth, (req, res) => {
  const { id, path, chunkData } = req.body;
  const client = clients[id];
  if (!client) return res.json({ success: false, message: "Raspberry offline" });

  const reqId = Date.now().toString() + Math.random().toString();

  const timeout = setTimeout(() => {
    client.removeListener("message", handler);
    res.json({ success: false, message: "Timeout escribiendo parte del archivo" });
  }, 5000);

  const handler = (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "write_file_chunk_response" && data.reqId === reqId) {
        clearTimeout(timeout);
        client.removeListener("message", handler);
        if (data.error) res.json({ success: false, message: data.error });
        else res.json({ success: true });
      }
    } catch (e) { }
  };

  client.on("message", handler);
  client.send(JSON.stringify({ type: "write_file_chunk", reqId, path, data: chunkData }));
});

/* -------------------------
   WEBSOCKET RASPBERRY
-------------------------- */

wss.on("connection", (ws) => {

  console.log("Raspberry conectada");

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      return; // Ignorar el mensaje basura en lugar de que el servidor se caiga
    }

    /* REGISTER */

    if (data.type === "register") {

      const id = data.id;
      const mac = data.mac_eth0 || "";

      // Si existe Base Externa DB2, Validar ID en ESTOMAS primero
      if (db2) {
        const sqlEstomas = "SELECT finca_id FROM estomas WHERE nombre = ?";
        db2.query(sqlEstomas, [id], (err2, resEstomas) => {
          if (err2 || resEstomas.length === 0) {
            console.log(`Conexión EXPULSADA: El ID [${id}] no existe en la BD externa de Estomas.`);
            ws.close();
            return;
          }
          // Si pasó la DB2, ahora validamos la MAC en DB1
          validarMACDatabaseLocal();
        });
      } else {
        validarMACDatabaseLocal();
      }

      function validarMACDatabaseLocal() {
        // Verificar estrictamente en la tabla de hardware 'raspberries'
        const sqlCheck = "SELECT mac_eth0 FROM raspberries WHERE mac_eth0 = ?";

        db.query(sqlCheck, [mac], (err, results) => {
          if (err) {
            console.error("Error validando MAC en DB:", err);
            ws.close();
            return;
          }

          if (results.length === 0) {
            console.log(`Registro denegado para ID: ${id}. MAC Falsa o Desconocida: ${mac}`);
            ws.close();
            return;
          }

          clients[id] = ws;
          console.log("Raspberry autorizada, MAC e ID Válidos:", id);

          // Actualizar bitácora de telemetría runtime
          const sqlUpdate = `
            INSERT INTO device_heartbeat (id, last_seen, created_at, mac_eth0)
            VALUES (?, NOW(), NOW(), ?)
            ON DUPLICATE KEY UPDATE last_seen = NOW(), mac_eth0 = ?
          `;
          db.query(sqlUpdate, [id, mac, mac], (errInsert) => {
            if (errInsert) console.log("Error insertando device_heartbeat:", errInsert.message);
          });
        });
      }
    }

    if (data.type === "command" && data.command === "abrir_tunel") {

      // Generar puerto aleatorio
      const MIN_PORT = 9000;
      const MAX_PORT = 9999;
      const puerto = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;

      console.log("Guardando puerto", puerto, "para Raspberry ID:", data.id);

      // Guardar puerto en DB
      const sql = `UPDATE device_heartbeat SET port_tunnel = ? WHERE id = ?`;
      db.query(sql, [puerto, data.id], (err) => {
        if (err) {
          console.error("Error guardando puerto:", err);
          ws.send(JSON.stringify({
            type: "abrir_tunel_response",
            success: false,
            message: "Error al guardar puerto"
          }));
          return;
        }

        // Enviar al cliente Raspberry para que abra el túnel
        const client = clients[data.id];
        if (client) {
          client.send(JSON.stringify({
            type: "abrir_tunel",
            puerto: puerto
          }));
        }

        // Confirmar al frontend
        ws.send(JSON.stringify({
          type: "abrir_tunel_response",
          success: true,
          puerto: puerto
        }));

        console.log(`Puerto ${puerto} enviado a Raspberry ${data.id}`);
      });
    }

    /* -------------------
       REGISTRO DE CLAVE SSH PARA TUNEL
    ------------------- */
    if (data.type === "register_key") {

      const id = data.id;
      const pubKey = data.key;

      // Validar tipo de clave
      if (!/^ssh-(ed25519|rsa)\s+[A-Za-z0-9+/=]+\s*.*$/.test(pubKey) || pubKey.includes('\n')) {
        console.log("Clave rechazada: formato peligroso o no permitido");
        ws.send(JSON.stringify({ type: "register_key_response", success: false, message: "Clave no válida" }));
        return;
      }

      try {
        // Actualizar la clave pública en la tabla device_heartbeat
        const sql = `
            UPDATE device_heartbeat
            SET \`key\` = ?
            WHERE id = ?
        `;
        db.query(sql, [pubKey, id], (err) => {
          if (err) {
            console.error("Error actualizando clave en DB:", err);
            ws.send(JSON.stringify({ type: "register_key_response", success: false, message: "Error DB" }));
            return;
          }

          // Agregar a authorized_keys con permisos de solo túnel (Evitando duplicados)
          const line = `\n# ${id}\ncommand="echo Túnel conectado",no-agent-forwarding,no-X11-forwarding,no-pty ${pubKey}\n`;
          const AUTH_KEYS_PATH = "/home/ubuntu/.ssh/authorized_keys";
          const fs = require("fs");

          let existe = false;
          if (fs.existsSync(AUTH_KEYS_PATH)) {
            const currentKeys = fs.readFileSync(AUTH_KEYS_PATH, "utf8");
            if (currentKeys.includes(pubKey)) existe = true;
          }

          if (!existe) {
            fs.appendFileSync(AUTH_KEYS_PATH, line);
            console.log(`Clave registrada fisicamente para Raspberry ${id} con permisos de túnel`);
          } else {
            console.log(`La clave de Raspberry ${id} ya estaba autorizada previamente en Linux. Cero duplicados.`);
          }

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
        UPDATE device_heartbeat
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

    if (data.type === "terminal_exited") {
      const terminal = terminals[data.id];
      if (terminal) {
        try {
          terminal.send("\r\n\r\n[⚠️ Sesión terminada localmente. Desconectando...]\r\n");
          terminal.close();
        } catch (e) { }
        delete terminals[data.id];
      }
    }

    if (data.type === "register_port") {
      const id = data.id;
      const port = data.port;

      const sql = `UPDATE device_heartbeat SET port_tunnel = ? WHERE id = ?`;
      db.query(sql, [port, id], (err) => {
        if (err) {
          console.error("Error guardando puerto:", err);
          ws.send(JSON.stringify({ type: "register_port_response", success: false }));
          return;
        }
        console.log(`Puerto registrado para Raspberry ${id}: ${port}`);
        ws.send(JSON.stringify({ type: "register_port_response", success: true }));
      });
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

      req.user = jwt.verify(token, JWT_SECRET);

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

  const usuarioLog = req.user ? req.user.username : "Desconocido";
  const ipLog = getClientIp(req);

  registrarLogConexion(id, usuarioLog, "SSH", "Apertura de terminal SSH", ipLog);

  console.log("ID solicitado:", id);
  console.log("Clientes conectados:", Object.keys(clients));

  const client = clients[id];

  if (!client) {

    ws.send("Raspberry offline");

    ws.close();

    return;

  }

  // Si ya hay una terminal abierta para esta Raspberry, la cerramos limpiamente
  if (terminals[id]) {
    try {
      terminals[id].send("\r\n\r\n[⚠️ Conexión transferida a una nueva pestaña o ventana]\r\n");
      terminals[id].close();
    } catch (e) { }
  }

  terminals[id] = ws;

  console.log("Iniciando terminal en:", id);

  client.send(JSON.stringify({
    type: "terminal_start"
  }));

  ws.cmdBuffer = "";

  ws.on("message", (data) => {
    try {
      const msgStr = data.toString();
      if (msgStr.startsWith('{')) {
        const msg = JSON.parse(msgStr);
        if (msg.type === "input") {
          client.send(JSON.stringify({ type: "terminal_input", data: msg.data }));

          /* --- AUDITORIA DE COMANDOS SSH --- */
          for (let i = 0; i < msg.data.length; i++) {
            const char = msg.data[i];
            if (char === '\r' || char === '\n') {
              const cmd = ws.cmdBuffer.trim();
              if (cmd.length > 0) {
                registrarLogConexion(id, usuarioLog, "SSH_CMD", cmd, ipLog);
              }
              ws.cmdBuffer = "";
            } else if (char === '\u007f' || char === '\b') { // Backspace
              ws.cmdBuffer = ws.cmdBuffer.slice(0, -1);
            } else if (char === '\x03') { // Ctrl+C canceló el comando
              ws.cmdBuffer = "";
            } else if (char === '\t') {   // Atrapamos el Autocompletado del usuario
              ws.cmdBuffer += "[TAB]";
            } else if (char >= ' ' && char <= '~') { // Solo imprimibles
              ws.cmdBuffer += char;
            }
          }
          /* ---------------------------------- */

          return;
        } else if (msg.type === "resize") {
          client.send(JSON.stringify({ type: "terminal_resize", cols: msg.cols, rows: msg.rows }));
          return;
        }
      }
    } catch (e) { }

    // Fallback for raw text
    client.send(JSON.stringify({
      type: "terminal_input",
      data: data.toString()
    }));
  });

  ws.on("close", () => {
    console.log("Terminal cerrada por el cliente web (pestaña cerrada):", id);
    if (terminals[id] === ws) {
      delete terminals[id];

      // Si la Raspberry todavía está conectada, ordenarle matar ese shell
      const piClient = clients[id];
      if (piClient && piClient.readyState === WebSocket.OPEN) {
        piClient.send(JSON.stringify({
          type: "terminal_stop"
        }));
      }
    }
  });

});

/* -------------------------
   INICIAR SERVIDOR
-------------------------- */

// 🔥 Asegurarnos de que el proxy trague CUALQUIER tipo de contenido en formato Buffer RAW
app.all(/^\/web\/([^\/]+)(.*)/, auth, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {

  const id = req.params[0];
  // 🔥 Extraer la ruta original limpia y SIEMPRE ponerle un '/' enfrente para que lo entienda Nginx/Apache 
  const basePathMatch = `/web/${id}`;
  let path = req.originalUrl.substring(req.originalUrl.indexOf(basePathMatch) + basePathMatch.length);
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  const client = clients[id];

  if (!client) {
    return res.status(404).send("Raspberry offline");
  }

  const requestId = Date.now() + Math.random();

  const headers = { ...req.headers };
  headers.host = "127.0.0.1";

  // 🔥 Le pasamos el buffer tal cual esté, sin convertir a JSON.
  const body = req.body && Buffer.isBuffer(req.body)
    ? req.body.toString("base64")
    : (req.body ? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)).toString("base64") : "");

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

    const encoding = data.headers ? data.headers["content-encoding"] : undefined;

    if (encoding === "gzip") {
      try {
        buffer = zlib.gunzipSync(buffer);
        res.removeHeader("content-encoding");
      } catch (e) {
        console.log("Error al descomprimir gzip:", e);
      }
    }

    const contentType = data.headers["content-type"] || "";

    // Enviar headers al cliente (excluyendo set-cookie y content-encoding que ya procesamos)
    Object.entries(data.headers || {}).forEach(([k, v]) => {
      const key = k.toLowerCase();
      if (key !== "set-cookie" && key !== "content-encoding" && key !== "transfer-encoding" && key !== "connection") {
        res.setHeader(k, v);
      }
    });

    if (contentType.includes("text/html")) {

      let html = buffer.toString("utf-8");

      const basePath = `/web/${id}`;

      // 🔥 EXTREMO: Reescribir rutas absolutas y relativas (./ o ../) en atributos comunes
      html = html.replace(/(href|src|action)=["'](\/?(?!\/)[^"']+)["']/gi, (match, attr, rutita) => {
        // Ignorar enlaces externos completos o javascript:
        if (rutita.startsWith('http') || rutita.startsWith('data:') || rutita.startsWith('javascript:')) return match;

        // Si ya tiene /web/ID/ no lo tocamos
        if (rutita.startsWith(basePath)) return match;

        // Si empieza con barra, se le agrega el basePath, de lo contrario lo dejamos relativo
        if (rutita.startsWith('/')) {
          return `${attr}="${basePath}${rutita}"`;
        }

        return match;
      });

      // 🔥 EXTREMO 2: Reescribir llamadas de estilo url('/assets/...') o un fetch/XHR ('/api/...') en el JS inline
      html = html.replace(/url\(['"]?(\/(?!\/)[^'")]+)['"]?\)/gi, (match, rutita) => {
        if (rutita.startsWith(basePath)) return match;
        return `url('${basePath}${rutita}')`;
      });

      // 🔥 agregar base tag (MUY IMPORTANTE para AJAX y rutas relativas)
      // Ajustamos la lógica para insertarlo justo despues del <head> abierto (si existe)
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/(<head[^>]*>)/i, `$1\n<base href="${basePath}/">`);
      } else {
        html = `<head><base href="${basePath}/"></head>\n` + html;
      }

      res.send(html);

    } else {
      res.send(buffer);
    }

    client.removeListener("message", handler);
  };

  client.on("message", handler);

  client.send(JSON.stringify({
    type: "web_request",
    requestId,
    method: req.method,
    path: path,
    headers,
    body
  }));

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});