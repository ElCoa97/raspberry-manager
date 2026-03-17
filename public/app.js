let raspberries = [];
let filtroBusqueda = "";

async function verificarSesion() {

    const res = await fetch("/api/me");

    if (res.status !== 200) {

        location.href = "/login.html";
        return false;

    }

    return true;

}

async function cargarRaspberry() {

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

        aplicarFiltro();

    } catch (error) {

        console.error("Error cargando raspberries:", error);

    }

}

function renderTabla(lista) {

    const tbody = document.getElementById("table");
    tbody.innerHTML = "";

    let online = 0;
    let offline = 0;

    const ahora = Date.now();

    lista.forEach(r => {

        let estado = "Offline";
        let badge = "bg-danger";
        let botones = "disabled";

        if (r.last_seen) {

            const ultima = new Date(r.last_seen).getTime();
            const diferencia = (ahora - ultima) / 1000;

            if (diferencia < 60) {
                estado = "Online";
                badge = "bg-success";
                online++;
                botones = ""; // habilita botones
            } else {
                offline++;
            }

        } else {
            offline++;
        }

        const fila = document.createElement("tr");

        fila.innerHTML = `
            <td>${r.id}</td>
            <td><span class="badge ${badge}">${estado}</span></td>
            <td>${r.last_seen ? new Date(r.last_seen).toLocaleString() : "Nunca"}</td>
            <td>
            <button class="btn btn-sm btn-dark" ${botones} onclick="ssh('${r.id}')">SSH</button>
            <button class="btn btn-sm btn-secondary" ${botones} onclick="abrirWeb('${r.id}')">WEB</button>
            <button class="btn btn-sm btn-danger" ${botones} onclick="reboot('${r.id}')">Reiniciar</button>
            </td>
        `;

        tbody.appendChild(fila);

    });

    document.getElementById("onlineCount").innerText = "Online: " + online;
    document.getElementById("offlineCount").innerText = "Offline: " + offline;

}

function aplicarFiltro(){

    if (filtroBusqueda) {

        const filtro = raspberries.filter(r =>
            r.id.toLowerCase().includes(filtroBusqueda.toLowerCase())
        );

        renderTabla(filtro);

    } else {

        renderTabla(raspberries);

    }

}

function buscarRaspberry(texto) {

    filtroBusqueda = texto;

    aplicarFiltro();

}

async function logout() {

    await fetch("/api/logout", { method: "POST" });

    location.href = "/login.html";

}

async function addRaspberry() {

    const id = prompt("Ingrese el ID de la Raspberry");

    if (!id) return;

    await fetch("/api/raspberry", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ id })
    });

    cargarRaspberry();
}

async function reboot(id) {

    const confirmar = confirm("¿Seguro que quieres reiniciar " + id + "?");

    if (!confirmar) return;

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

function ssh(id) {

    alert("Conectar por SSH a: " + id);
    window.open("/terminal.html?id=" + id, "_blank");

}

function abrirWeb(id){
    window.open("https://raspberrymanager.duckdns.org:9001", "_blank");
}

async function iniciar() {

    const ok = await verificarSesion();

    if (!ok) return;

    document.getElementById("body").style.display = "block";

    cargarRaspberry();

    setInterval(cargarRaspberry, 5000);

}

iniciar();