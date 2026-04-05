const params = new URLSearchParams(window.location.search);
const basculaId = params.get("id");
const finca = params.get("finca");
let currentPath = "/home/pi";

if (!basculaId) {
    alert("Falta el ID de la báscula");
    window.close();
}

document.getElementById("titleText").innerText = (finca ? finca + " | " : "") + "Archivos - " + basculaId;

async function fetchSessionUser() {
    try {
        const res = await fetch("/api/me");
        if (res.status === 200) {
            const data = await res.json();
            if (data.user && data.user.username) {
                document.getElementById("userNameDisplay").innerText = "👤 " + data.user.username;
            }
        } else {
            location.href = "/login.html";
        }
    } catch (e) { }
}

async function cargarDirectorio() {
    const tableInfo = document.getElementById("fileTable");
    tableInfo.innerHTML = '<tr><td colspan="5" class="text-center">Cargando...</td></tr>';
    document.getElementById("currentPath").innerText = currentPath;

    try {
        const res = await fetch(`/api/files/list?id=${basculaId}&path=${encodeURIComponent(currentPath)}`);
        const data = await res.json();

        if (!data.success) {
            tableInfo.innerHTML = `<tr><td colspan="5" class="text-center text-danger">${data.error || 'Error leyendo ruta'}</td></tr>`;
            return;
        }

        tableInfo.innerHTML = '';
        let html = '';

        // Sort: directories first, then alphabetically
        data.entries.sort((a, b) => {
            if (a.is_dir && !b.is_dir) return -1;
            if (!a.is_dir && b.is_dir) return 1;
            return a.name.localeCompare(b.name);
        });

        if (data.entries.length === 0) {
            tableInfo.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Carpeta vacía</td></tr>';
        }

        data.entries.forEach(f => {
            const icon = f.is_dir ? '📁' : '📄';
            const size = f.is_dir ? '-' : formatBytes(f.size);
            const date = new Date(f.mtime * 1000).toLocaleString();

            const onclick = f.is_dir ? `onclick="entrarCarpeta('${f.name}')"` : '';
            const cursor = f.is_dir ? 'cursor-pointer text-primary fw-bold text-decoration-underline' : '';

            let botonAccion = '';
            if (!f.is_dir) {
                botonAccion = `<button class="btn btn-sm btn-outline-primary" onclick="descargarArchivo('${f.name}')">⬇ Descargar</button>`;
            }

            html += `
                <tr>
                    <td class="text-center fs-4">${icon}</td>
                    <td class="${cursor}" ${onclick}>${f.name}</td>
                    <td>${size}</td>
                    <td>${date}</td>
                    <td>${botonAccion}</td>
                </tr>
            `;
        });
        tableInfo.innerHTML = html;

    } catch (e) {
        tableInfo.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error de conexión con el servidor</td></tr>`;
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function entrarCarpeta(name) {
    if (currentPath === '/') {
        currentPath += name;
    } else {
        currentPath += '/' + name;
    }
    cargarDirectorio();
}

function subirNivel() {
    if (currentPath === '/' || currentPath === '') return;
    const parts = currentPath.split('/');
    // Elimina el ultimo (la carpeta actual)
    parts.pop();
    currentPath = parts.join('/');
    if (currentPath === '') currentPath = '/';
    cargarDirectorio();
}

function descargarArchivo(name) {
    let fullPath = currentPath;
    if (fullPath !== '/') fullPath += '/';
    fullPath += name;

    // Abrir endpoint de descarga que bajará como streaming
    window.location.href = `/api/files/download?id=${basculaId}&path=${encodeURIComponent(fullPath)}`;
}

async function iniciarSubida() {
    const fileInput = document.getElementById("fileInput");
    if (!fileInput.files.length) return;

    const file = fileInput.files[0];
    let fullPath = currentPath;
    if (fullPath !== '/') fullPath += '/';
    fullPath += file.name;

    const pbContainer = document.getElementById("progressContainer");
    const pb = document.getElementById("progressBar");

    pbContainer.classList.remove("d-none");
    pb.style.width = '0%';
    pb.innerText = 'Iniciando subida...';
    pb.classList.remove("bg-danger", "bg-success");
    pb.classList.add("progress-bar-animated");

    const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB chunk
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    let subidaFallida = false;

    // Primero reiniciamos el archivo (borrarSiExiste)
    try {
        const initRes = await fetch('/api/files/upload_init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: basculaId, path: fullPath })
        });
        const initData = await initRes.json();
        if (!initData.success) {
            throw new Error(initData.message);
        }
    } catch (e) {
        alert("Fallo inicializando subida: " + e.message);
        subidaFallida = true;
    }

    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    if (!subidaFallida) {
        for (let currentChunk = 0; currentChunk < totalChunks; currentChunk++) {
            const start = currentChunk * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);

            const buffer = await chunkBlob.arrayBuffer();
            const chunkBase64 = arrayBufferToBase64(buffer);

            try {
                const response = await fetch('/api/files/upload_chunk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: basculaId,
                        path: fullPath,
                        chunkData: chunkBase64
                    })
                });
                const resData = await response.json();
                if (!resData.success) {
                    throw new Error(resData.message);
                }

                const percent = Math.round(((currentChunk + 1) / totalChunks) * 100);
                pb.style.width = percent + '%';
                pb.innerText = percent + '%';

            } catch (e) {
                alert("Fallo de red durante la subida del chunk " + currentChunk + ": " + e.message);
                subidaFallida = true;
                break;
            }
        }
    }

    if (subidaFallida) {
        pb.classList.add("bg-danger");
        pb.innerText = "Error";
        pb.classList.remove("progress-bar-animated");
    } else {
        pb.classList.add("bg-success");
        pb.innerText = "Completado";
        pb.classList.remove("progress-bar-animated");
    }

    fileInput.value = "";
    cargarDirectorio();

    setTimeout(() => {
        pbContainer.classList.add("d-none");
        pb.classList.remove("bg-success", "bg-danger");
        pb.style.width = '0%';
    }, 3000);
}

// Iniciar aplicación
fetchSessionUser();
cargarDirectorio();
