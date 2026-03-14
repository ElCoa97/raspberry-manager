let raspberries = [];

async function cargarRaspberry() {

    const res = await fetch("/api/raspberries");
    raspberries = await res.json();

    renderTabla(raspberries);

}

function renderTabla(lista){

    const tbody = document.getElementById("table");
    tbody.innerHTML = "";

    let online = 0;
    let offline = 0;

    const ahora = Date.now();

    lista.forEach(r => {

        let estado = "Offline";
        let badge = "bg-danger";

        if (r.last_seen) {

            const ultima = new Date(r.last_seen).getTime();
            const diferencia = (ahora - ultima) / 1000;

            if (diferencia < 60) {
                estado = "Online";
                badge = "bg-success";
                online++;
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
                <button class="btn btn-sm btn-dark" onclick="ssh('${r.id}')">SSH</button>
                <button class="btn btn-sm btn-secondary" onclick="abrirWeb('${r.id}')">WEB</button>
            </td>
        `;

        tbody.appendChild(fila);

    });

    document.getElementById("onlineCount").innerText = "Online: " + online;
    document.getElementById("offlineCount").innerText = "Offline: " + offline;

}

function buscarRaspberry(texto){

    const filtro = raspberries.filter(r =>
        r.id.toLowerCase().includes(texto.toLowerCase())
    );

    renderTabla(filtro);

}

async function addRaspberry() {

    const id = prompt("Ingrese el ID de la Raspberry");

    if (!id) return;

    await fetch("/api/raspberry", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ id })
    });

    cargarRaspberry();
}

function ssh(id){

    alert("Conectar por SSH a: " + id);

}

function abrirWeb(id){

    alert("Abrir interfaz web de: " + id);

}

setInterval(cargarRaspberry, 5000);

cargarRaspberry();