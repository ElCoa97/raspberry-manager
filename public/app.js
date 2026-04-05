let raspberries = [];
let filtroBusqueda = "";
let filtroFincaVariable = "";

let currentPage = 1;
const PAGE_SIZE = 30; // Muestra 30 básculas por página
let listaFiltradaGlobal = [];

async function verificarSesion() {

    const res = await fetch("/api/me");

    if (res.status !== 200) {

        location.href = "/login.html";
        return false;

    }

    try {
        const data = await res.json();
        const userSpan = document.getElementById("userNameDisplay");
        if (userSpan && data.user && data.user.username) {
            userSpan.innerText = "👤 " + data.user.username;
        }
    } catch (e) { }

    return true;

}

async function cargarBascula() {

    try {

        const res = await fetch("/api/raspberries");

        if (res.status === 401) {

            location.href = "/login.html";
            return;

        }

        raspberries = await res.json();

        const ahora = Date.now();

        raspberries.sort((a, b) => {

            function estado(r) {
                if (!r.last_seen) return 1;

                const diff = (ahora - new Date(r.last_seen).getTime()) / 1000;

                return diff < 60 ? 0 : 1; // 0 = online, 1 = offline
            }

            const estadoA = estado(a);
            const estadoB = estado(b);

            if (estadoA !== estadoB) {
                return estadoA - estadoB;
            }

            return a.id.localeCompare(b.id);

        });

        // Poblar el Dropdown de Fincas estáticamente (1 sola vez)
        const selectFinca = document.getElementById("filtroFinca");
        if (selectFinca && selectFinca.options.length === 1) {
            const listadoFincas = [...new Set(raspberries.map(r => r.finca).filter(Boolean))].sort();
            listadoFincas.forEach(f => {
                const opt = document.createElement("option");
                opt.value = opt.innerText = f;
                selectFinca.appendChild(opt);
            });
        }

        aplicarFiltro();

    } catch (error) {

        console.error("Error cargando raspberries:", error);

    }

} function renderTabla(lista, resetPage = true) {

    if (resetPage) currentPage = 1;

    let online = 0;
    let offline = 0;
    const ahora = Date.now();

    // 1. Pre-calcular estado online y Totales
    lista.forEach(r => {
        r.isOnline = false;
        if (r.last_seen) {
            const ultima = new Date(r.last_seen).getTime();
            const diferencia = (ahora - ultima) / 1000;
            if (diferencia < 60) r.isOnline = true;
        }
        if (r.isOnline) online++; else offline++;
    });

    // 2. Ejecutar el Motor de Ordenamiento
    lista.sort((a, b) => {
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;

        const fincaA = (a.finca || "").toLowerCase();
        const fincaB = (b.finca || "").toLowerCase();
        if (fincaA < fincaB) return -1;
        if (fincaA > fincaB) return 1;

        const idA = (a.id || "").toLowerCase();
        const idB = (b.id || "").toLowerCase();
        if (idA < idB) return -1;
        if (idA > idB) return 1;

        return 0;
    });

    // Actualizar marcadores globales
    document.getElementById("onlineCount").innerText = "Online: " + online;
    document.getElementById("offlineCount").innerText = "Offline: " + offline;

    // Guardar para el Paginador
    listaFiltradaGlobal = lista;
    dibujarPagina();
}

function cambiarPagina(n) {
    currentPage = n;
    dibujarPagina();
}

function dibujarPagina() {
    // Evitar que el refresco automático cierre el menú si el usuario lo está usando
    const menuAbierto = document.querySelector("#table .dropdown-menu.show");
    if (menuAbierto) return;

    const tbody = document.getElementById("table");
    tbody.innerHTML = "";

    const totalPaginas = Math.ceil(listaFiltradaGlobal.length / PAGE_SIZE) || 1;
    if (currentPage > totalPaginas) currentPage = totalPaginas;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const itemsPagina = listaFiltradaGlobal.slice(startIdx, startIdx + PAGE_SIZE);

    itemsPagina.forEach(r => {
        let estado = r.isOnline ? "Online" : "Offline";
        let badge = r.isOnline ? "bg-success" : "bg-danger";
        let botones = r.isOnline ? "" : "disabled";

        let tunelAbierto = r.port_tunnel ? "" : "disabled text-muted";

        let alertaHtml = "";
        if (r.isOnline) {
            const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false });
            let horaColombia = parseInt(formatter.format(new Date()), 10);
            if (horaColombia === 24) horaColombia = 0;

            // Entre las 9 AM y 6 PM
            if (horaColombia >= 9 && horaColombia <= 18) {
                let diffMinutos = Infinity;
                if (r.ultima_subida && r.last_seen) {
                    diffMinutos = (new Date(r.last_seen).getTime() - new Date(r.ultima_subida).getTime()) / 60000;
                }

                if (diffMinutos >= 120) {
                    const textoHover = diffMinutos === Infinity
                        ? "¡Aviso! Equipo online sin registros de subida de datos."
                        : `¡Aviso! Equipo online, pero tiene ${Math.floor(diffMinutos)} minutos sin registrar pesajes.`;
                    alertaHtml = `<span style="cursor: help;" title="${textoHover}">⚠️</span>`;
                }
            }
        }

        const fila = document.createElement("tr");

        fila.innerHTML = `
            <td>${r.finca || '-'}</td>
            <td><strong>${r.id}</strong> ${alertaHtml}</td>
            <td>${r.tipo || '-'}</td>
            <td><span class="badge ${badge}">${estado}</span></td>
            <td>${r.last_seen ? new Date(r.last_seen).toLocaleString() : "Nunca"}</td>
            <td>
                <div class="btn-group">
                    <button class="btn btn-sm btn-info text-white" onclick="abrirDashboard('${r.id}')" title="Ver Detalles">📋</button>
                    <button type="button" class="btn btn-sm btn-secondary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false" ${botones}>
                        ⚙️ Opciones
                    </button>
                    <ul class="dropdown-menu shadow">
                        <li><a class="dropdown-item" href="#" onclick="event.preventDefault(); ssh('${r.id}', '${r.finca || 'Desconocida'}')">🖥️ Abrir terminal SSH</a></li>
                        <li><a class="dropdown-item" href="#" onclick="event.preventDefault(); archivos('${r.id}', '${r.finca || 'Desconocida'}')">📁 Gestor de Archivos</a></li>
                        <li><a class="dropdown-item" href="#" onclick="event.preventDefault(); abrirWeb('${r.id}', '${r.finca || 'Desconocida'}')">🌐 Abrir panel WEB</a></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><a class="dropdown-item text-warning ${tunelAbierto}" href="#" onclick="event.preventDefault(); cerrarWeb('${r.id}', '${r.finca || 'Desconocida'}')">🚫 Cerrar enlaces WEB</a></li>
                        <li><a class="dropdown-item text-danger" href="#" onclick="event.preventDefault(); reboot('${r.id}', '${r.finca || 'Desconocida'}')">🔄 Reiniciar Sistema</a></li>
                    </ul>
                </div>
            </td>
        `;

        tbody.appendChild(fila);
    });

    renderPaginacion(totalPaginas);
}

function renderPaginacion(totalPaginas) {
    const ul = document.getElementById("paginacionUI");
    if (!ul) return;
    ul.innerHTML = "";

    ul.innerHTML += `<li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
        <button class="page-link" onclick="cambiarPagina(${currentPage - 1})">Anterior</button>
    </li>`;

    let startP = Math.max(1, currentPage - 2);
    let endP = Math.min(totalPaginas, currentPage + 2);

    // Saltar a Página 1 si estamos muy lejos
    if (startP > 1) {
        ul.innerHTML += `<li class="page-item"><button class="page-link" onclick="cambiarPagina(1)">1</button></li>`;
        if (startP > 2) {
            ul.innerHTML += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        }
    }

    // Botones secuenciales al rededor de la página actual
    for (let i = startP; i <= endP; i++) {
        ul.innerHTML += `<li class="page-item ${i === currentPage ? 'active' : ''}">
            <button class="page-link" onclick="cambiarPagina(${i})">${i}</button>
        </li>`;
    }

    // Saltar a Última Página si quedan páginas escondidas adelante
    if (endP < totalPaginas) {
        if (endP < totalPaginas - 1) {
            ul.innerHTML += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        }
        ul.innerHTML += `<li class="page-item"><button class="page-link" onclick="cambiarPagina(${totalPaginas})">${totalPaginas}</button></li>`;
    }

    ul.innerHTML += `<li class="page-item ${currentPage === totalPaginas ? 'disabled' : ''}">
        <button class="page-link" onclick="cambiarPagina(${currentPage + 1})">Siguiente</button>
    </li>`;
}

function aplicarFiltro(resetPage = false) {
    let filtradas = raspberries;

    // 1. Filtro por Buscador (Incluye ID y también Finca temporal)
    if (filtroBusqueda) {
        const txt = filtroBusqueda.toLowerCase();
        filtradas = filtradas.filter(r =>
            (r.id && r.id.toLowerCase().includes(txt)) ||
            (r.finca && r.finca.toLowerCase().includes(txt))
        );
    }

    // 2. Filtro Estricto por Dropdown de Finca
    if (filtroFincaVariable) {
        filtradas = filtradas.filter(r => r.finca === filtroFincaVariable);
    }

    renderTabla(filtradas, resetPage);
}

function filtrarPorFinca(fincaEscogida) {
    filtroFincaVariable = fincaEscogida;
    aplicarFiltro(true);
}

function buscarBascula(texto) {

    filtroBusqueda = texto;

    // Cuando el usuario busca manualmente, forzamos regresar a la página 1
    aplicarFiltro(true);

}

async function logout() {

    await fetch("/api/logout", { method: "POST" });

    location.href = "/login.html";

}

async function reboot(id, finca) {

    const n1 = Math.floor(Math.random() * 10) + 1;
    const n2 = Math.floor(Math.random() * 10) + 1;
    const sumaCorrecta = n1 + n2;

    const respuesta = prompt(`⚠️ ¡ATENCIÓN! Vas a reiniciar físicamente la báscula ${id} ubicada en la finca ${finca}.\n\nPara confirmar que no fue un clic accidental, resuelve esta suma:\n¿Cuánto es ${n1} + ${n2}?`);

    if (respuesta === null) return; // Si el usuario le dio a "Cancelar"

    if (parseInt(respuesta.trim()) !== sumaCorrecta) {
        alert("❌ Respuesta incorrecta. El reinicio ha sido abortado por seguridad.");
        return;
    }

    await fetch("/api/command", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            id: id,
            command: "reboot"
        })
    });

}

function ssh(id, finca) {

    const confirmar = confirm(`¿Deseas conectarte a la terminal SSH de la báscula ${id} en la finca ${finca}?`);

    if (!confirmar) return; // Si el usuario presiona Cancelar, abortamos silenciosamente.

    window.open(`/terminal.html?id=${encodeURIComponent(id)}&finca=${encodeURIComponent(finca)}`, "_blank");

}

function archivos(id, finca) {
    window.open(`/files.html?id=${encodeURIComponent(id)}&finca=${encodeURIComponent(finca)}`, "_blank");
}

async function abrirWeb(id, finca) {

    const confirmar = confirm(`¿Deseas abrir la conexión del Escritorio Remoto (WEB) para la báscula ${id} en la finca ${finca}?`);

    if (!confirmar) return;

    // Enviar comando al servidor para abrir túnel con puerto dinámico
    const res = await fetch("/api/command", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            id: id,
            command: "abrir_tunel"
        })
    });

    const data = await res.json();

    if (data.success) {
        // Abrir la pestaña apuntando al puerto remoto asignado
        const puerto = data.puerto;
        window.open(`http://raspberrymanager.duckdns.org:${puerto}`, "_blank");
    } else {
        alert("Error al abrir túnel: " + (data.message || "Desconocido"));
    }

}

async function cerrarWeb(id, finca) {

    const confirmar = confirm(`¿Deseas cerrar el túnel web de la báscula ${id} en la finca ${finca}?`);
    if (!confirmar) return;

    await fetch("/api/command", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            id: id,
            command: "cerrar_tunel"
        })
    });

    alert("Comando de cierre de túnel enviado a la Raspberry.");

}

async function abrirDashboard(id) {
    const r = raspberries.find(x => x.id === id);
    if (!r) return;

    document.getElementById("infoSidebarLabel").innerText = "Info: " + id;
    const body = document.getElementById("sidebar-content");

    const formatearFechaBD = (fechaRaw) => {
        // En Safari/iOS fallaría new Date("2026-03-30 06:18:32"), lo pasamos a ISO estándar.
        // Forzamos explícitamente -05:00 para que cualquier dispositivo/navegador lo parsee fijo.
        let ISO = typeof fechaRaw === "string" ? fechaRaw.replace(" ", "T") : fechaRaw;
        if (typeof ISO === "string" && !ISO.includes("Z") && !ISO.includes("-")) {
            ISO += "-05:00";
        }
        const fn = new Date(ISO);
        return isNaN(fn.getTime()) ? fechaRaw : fn.toLocaleString();
    };

    let ultimaSubidaTexto = "Sin registros";
    if (r.ultima_subida) {
        ultimaSubidaTexto = formatearFechaBD(r.ultima_subida);
    }

    let ultimaValidacionTexto = "Sin validaciones";
    if (r.ultima_validacion) {
        ultimaValidacionTexto = formatearFechaBD(r.ultima_validacion);
    }

    body.innerHTML = `
        <ul class="list-group">
            <li class="list-group-item"><strong>ID:</strong> ${id}</li>
            <li class="list-group-item"><strong>Finca:</strong> ${r.finca || '-'}</li>
            <li class="list-group-item"><strong>Tipo:</strong> ${r.tipo || '-'}</li>
            <li class="list-group-item text-primary"><strong>Última subida:</strong> ${ultimaSubidaTexto}</li>
            <li class="list-group-item text-success"><strong>Última validación:</strong> ${ultimaValidacionTexto}</li>
            <li class="list-group-item"><strong>Último Heartbeat:</strong> ${r.last_seen ? new Date(r.last_seen).toLocaleString() : "Nunca"}</li>
            <li class="list-group-item"><strong>IP actual:</strong> <span id="dash_ip">Calculando...</span></li>
            <li class="list-group-item"><strong>MAC eth0:</strong> ${r.mac_eth0 || '<span class="text-muted">No registrada</span>'}</li>
            <li class="list-group-item"><strong>MAC wlan0:</strong> ${r.mac_wlan0 || '<span class="text-muted">No registrada</span>'}</li>
            <li class="list-group-item"><strong>Temperatura:</strong> <span id="dash_temp">Consultando...</span></li>
            <li class="list-group-item"><strong>Red actual:</strong> <span id="dash_net">Consultando...</span></li>
        </ul>

        <button class="btn btn-outline-primary mt-3 w-100 fw-bold shadow-sm" onclick="verHistorial('${id}')" id="btnHistorial">📑 Ver Historial de Movimientos</button>
        <div id="historialContainer" class="mt-3" style="max-height: 400px; overflow-y: auto;"></div>
    `;

    const sidebarNode = document.getElementById('infoSidebar');
    // Si ya existe instancia de Bootstrap Offcanvas, la usamos; si no, la creamos.
    let offcanvas = bootstrap.Offcanvas.getInstance(sidebarNode);
    if (!offcanvas) offcanvas = new bootstrap.Offcanvas(sidebarNode);

    offcanvas.show();

    // Validar si está offline según la tabla y evitar consultar sockets zombi
    let isOnline = false;
    if (r.last_seen) {
        const ultima = new Date(r.last_seen).getTime();
        const diferencia = (Date.now() - ultima) / 1000;
        if (diferencia < 60) isOnline = true;
    }

    if (!isOnline) {
        document.getElementById("dash_ip").innerText = "Offline";
        document.getElementById("dash_temp").innerText = "Offline";
        document.getElementById("dash_net").innerText = "Offline";
        return;
    }

    try {
        const res = await fetch("/api/device_info?id=" + id);
        const data = await res.json();
        if (data.success) {
            document.getElementById("dash_ip").innerText = data.ip;
            document.getElementById("dash_temp").innerText = data.temperatura;
            document.getElementById("dash_net").innerText = data.red;
        } else {
            document.getElementById("dash_ip").innerText = "Báscula Offline";
            document.getElementById("dash_temp").innerText = "Offline";
            document.getElementById("dash_net").innerText = "Offline";
        }
    } catch (e) {
        console.error("Error obteniendo info", e);
    }
}

async function verHistorial(id) {
    const btn = document.getElementById('btnHistorial');
    const container = document.getElementById('historialContainer');

    if (!btn || !container) return;

    // Toggle (Si está abierto, lo cierra)
    if (container.innerHTML.trim() !== "") {
        container.innerHTML = "";
        btn.innerText = "📑 Ver Historial de Movimientos";
        return;
    }

    btn.innerText = "⏳ Cargando historial...";
    btn.disabled = true;

    try {
        const res = await fetch("/api/logs/" + encodeURIComponent(id));
        const data = await res.json();

        btn.disabled = false;
        btn.innerText = "🔼 Ocultar Historial";

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger p-2 small">Error: ${data.message}</div>`;
            return;
        }

        if (data.logs.length === 0) {
            container.innerHTML = `<div class="alert alert-info p-2 small">Sin movimientos recientes (Últimos 30 días).</div>`;
            return;
        }

        let tablaHTML = `
            <table class="table table-sm table-striped table-bordered" style="font-size: 0.8rem">
                <thead class="table-dark">
                    <tr>
                        <th>Fecha</th>
                        <th>User</th>
                        <th>Op</th>
                        <th>Cmd/IP</th>
                    </tr>
                </thead>
                <tbody>
        `;

        data.logs.forEach(log => {
            const f = new Date(log.fecha).toLocaleString('es-CO', {
                day: '2-digit', month: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: true
            });

            // Recortar comandos si son muy largos
            let cmdDesc = log.comando_ejecutado || "-";
            if (cmdDesc.length > 50) cmdDesc = cmdDesc.substring(0, 50) + "...";

            // Resaltar atajo de tabulación
            cmdDesc = cmdDesc.replace(/\[TAB\]/g, '<span class="text-success fw-bold">[TAB]</span>');

            tablaHTML += `
                <tr>
                    <td class="text-nowrap">${f}</td>
                    <td><b>${log.usuario}</b></td>
                    <td><span class="badge bg-secondary">${log.tipo_operacion}</span></td>
                    <td class="text-break">
                        <div class="text-primary" style="font-size: 0.75rem">${log.direccion_ip}</div>
                        <code>${cmdDesc}</code>
                    </td>
                </tr>
            `;
        });

        tablaHTML += `</tbody></table>`;
        container.innerHTML = tablaHTML;

    } catch (e) {
        btn.disabled = false;
        btn.innerText = "❌ Error. Reintentar";
        console.error("Error obteniendo logs", e);
    }
}

async function iniciar() {

    const ok = await verificarSesion();

    if (!ok) return;

    document.getElementById("body").style.display = "block";

    cargarBascula();

    setInterval(cargarBascula, 5000);

}

iniciar();