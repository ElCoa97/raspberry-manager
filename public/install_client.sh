#!/bin/bash
set -e

echo "=========================================="
echo " Instalador del Cliente Raspberry Manager "
echo "        (Versión Nativa Python 3)         "
echo "=========================================="

echo "[1/4] Preparando entorno y Claves SSH..."
mkdir -p /home/pi/cliente_gestor
mkdir -p /home/pi/.ssh

if [ ! -f /home/pi/.ssh/id_ed25519 ]; then
    ssh-keygen -t ed25519 -N "" -f /home/pi/.ssh/id_ed25519
    echo "Clave SSH generada exitosamente."
else
    echo "La clave SSH ya existía, saltando generación."
fi

touch /home/pi/tunel_port.txt

echo "Buscando y eliminando AnyDesk para ahorrar memoria RAM..."
sudo systemctl stop anydesk || true
sudo systemctl disable anydesk || true
sudo apt-get purge -y anydesk || true
sudo apt-get autoremove -y || true

echo "[2/4] Descargando la última versión del código Python..."
cd /home/pi/cliente_gestor
wget -O client.py https://raspberrymanager.duckdns.org/client.py

echo "[3/4] Instalando librería de WebSocket para Python..."
# Descargamos el paquete de forma local a través de nuestro propio servidor (Para fincas sin internet abierto)
wget https://raspberrymanager.duckdns.org/libraries/websocket_client-1.3.3-py3-none-any.whl
# Lo instalamos localmente garantizando compatibilidad con versiones antiguas
pip3 install ./websocket_client-1.3.3-py3-none-any.whl --user || sudo pip3 install ./websocket_client-1.3.3-py3-none-any.whl
# Limpiamos
rm websocket_client-1.3.3-py3-none-any.whl

echo "[4/4] Instalando Auto-Arranque Nativo de Linux (SystemD)..."
# Dejamos de depender del gordo PM2 de Node y usamos el corazón nativo de Linux
SERVICE_FILE="/etc/systemd/system/cliente-sioma.service"
sudo bash -c "cat > $SERVICE_FILE" <<EOF
[Unit]
Description=Cliente Python Raspberry Manager (Sioma)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/cliente_gestor
ExecStart=/usr/bin/python3 /home/pi/cliente_gestor/client.py
Restart=always
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=cliente-sioma

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cliente-sioma.service
sudo systemctl restart cliente-sioma.service

echo "=========================================="
echo "    INSTALACIÓN COMPLETADA CON ÉXITO      "
echo "=========================================="
echo "Tu agente Python está corriendo de fondo invisible."
