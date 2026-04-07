# 🍇 Raspberry Manager - Guía de Implementación Maestra

**NOTA: recuerda reemplazar el dominio raspberrymanager.duckdns.org por el dominio que desees usar.**

Este repositorio contiene el sistema centralizado para la gestión, auditoría y control remoto de dispositivos Raspberry Pi (Básculas SIOMA). 

> [!IMPORTANT]
> Esta guía documenta los pasos exactos a ejecutar directamente en la terminal SSH de tu servidor Amazon (Ubuntu) para blindar todas las conexiones con cifrado TLS/SSL militar.

---

## 🛠️ Requisitos del Servidor (Backend)

### 1. Instalación de Dependencias Base
En el servidor Ubuntu de AWS, primero instala las herramientas necesarias para el tráfico web y la seguridad:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx nodejs npm
```

### 2. Configuración del Proyecto y Dependencias
Clona o sube tu proyecto al servidor, entra a la carpeta y ejecuta:

```bash
sudo npm install
sudo npm install -g pm2
sudo nano .env
```
Pegar el siguiente contenido (recuerda reemplazar los datos de las bases de datos):

```env
# Configuración de Base de Datos SoporteApp (Principal)
DB_HOST=tu_host_mysql
DB_USER=tu_usuario
DB_PASSWORD=tu_password
DB_NAME=tu_base_de_datos

# Configuración de Base de Datos SIOMA (Externa)
DB2_HOST=tu_host_sioma
DB2_USER=tu_usuario_sioma
DB2_PASSWORD=tu_password_sioma
DB2_NAME=tu_base_datos_sioma

# Configuración de Seguridad
JWT_SECRET=d18w651phbn4sadaqwdbgolk745asdc7x1a8sdfa87q85az4vb814mfg
PORT=3000
```

### 3. Iniciar el Servidor de Fondo (PM2)
Usaremos el administrador de procesos PM2 para mantener Node.js encendido 24/7 y que reviva automáticamente si el servidor se reinicia:

```bash
sudo pm2 start server.js --name "raspberry-manager"
sudo pm2 save
sudo pm2 startup
```

---

## 🔒 Certificación de Seguridad (HTTPS y WSS)

### Paso 1: Configurar Nginx como Puerta de Enlace (Proxy Inverso)
Nginx recibirá el tráfico de internet (puerto 80/443) y lo pasará internamente a Node.js (puerto 3000), permitiendo el flujo de WebSockets para las terminales SSH.

1. **Crear el archivo de configuración:**
   ```bash
   sudo nano /etc/nginx/sites-available/raspberrymanager
   ```

2. **Pegar el bloque de configuración (Optimizado para SSH y Auditoría):**
```nginx
# Bloque para conexiones HTTPS (Seguras, Nivel 443)
server {
    server_name raspberrymanager.duckdns.org;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Soporte para WebSockets de Node y terminales SSH
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        
        # Identidad del servidor
        proxy_set_header Host $host;

        # Herramientas de Auditoría (Envían la IP real exterior)
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ------- CERTIFICACIONES DE SEGURIDAD SSL (CERTBOT LET'S ENCRYPT) -------------
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/raspberrymanager.duckdns.org/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/raspberrymanager.duckdns.org/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

# Bloque redireccionador: Convierte HTTP a HTTPS automáticamente
server {
    if ($host = raspberrymanager.duckdns.org) {
        return 301 https://$host$request_uri;
    }

    listen 80;
    server_name raspberrymanager.duckdns.org;
    return 404;
}
```

3. **Activar la configuración y reiniciar Nginx:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/raspberrymanager /etc/nginx/sites-enabled/
   sudo nginx -t  # Verificar sintaxis
   sudo systemctl restart nginx
   ```

### Paso 2: Encender el Cifrado SSL (El "Candadito Verde")
Usa Certbot para generar y renovar automáticamente los certificados de Let's Encrypt:

```bash
sudo certbot --nginx -d raspberrymanager.duckdns.org
```

> [!TIP]
> Te pedirá un Email para avisos de renovación. Certbot inyectará las llaves secretas automáticamente en tu configuración de Nginx.

---

## 🛰️ Despliegue de Clientes (Raspberry Pi)
Para instalar el agente en una nueva Raspberry, solo ejecuta este comando desde su terminal:

```bash
wget -O install_client.sh https://raspberrymanager.duckdns.org/install_client.sh && chmod +x install_client.sh && ./install_client.sh
```

---

## 🚨 Configuración Final en AWS
Asegúrate obligatoriamente de que tu panel de **AWS EC2 (Security Groups)** tenga abiertos los siguientes puertos hacia internet:
- **Puertos 80 (HTTP) y 443 (HTTPS)**: Para el acceso web y API.
- **Rango 9000-9999 (Opcional)**: Si utilizas túneles SSH de retorno directo.

---
© 2026 SIOMA - Sistema de Gestión de Básculas Inteligentes.
