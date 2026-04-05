import os
import sys
import json
import time
import threading
import subprocess
import socket
import pty
import select
import http.client
import base64
import signal

try:
    import websocket
except ImportError:
    print("Falta la libreria de WebSockets. Instálala ejecutando: pip3 install websocket-client")
    sys.exit(1)

SERVER = "wss://raspberrymanager.duckdns.org"

RASPBERRY_ID = "unknown"
ws_app = None

# --- LEER CLAVE PÚBLICA ---
PUB_KEY = ""
try:
    with open("/home/pi/.ssh/id_ed25519.pub", "r") as f:
        PUB_KEY = f.read().strip()
except Exception as e:
    print("No se pudo leer la clave publica:", e)

# --- BACKOFF ---
reconnect_delay = 5
max_reconnect_delay = 60

# --- LEER ID DESDE ARCHIVO ---
try:
    with open("/firmware/base/Codes/initbascula/info.txt", "r") as f:
        data = f.read()
        RASPBERRY_ID = data.split(",")[0].strip()
except Exception as e:
    print("Error leyendo archivo de ID:", e)

# MULTITHREAD TERMINAL VARS
shell_fd = None
shell_pid = None
terminal_thread = None

def get_mac_address():
    try:
        with open("/sys/class/net/eth0/address", "r") as f:
            return f.read().strip()
    except:
        return ""

def heartbeat_worker():
    while True:
        time.sleep(30)
        try:
            if ws_app and ws_app.sock and ws_app.sock.connected:
                ws_app.send(json.dumps({"type": "heartbeat", "id": RASPBERRY_ID}))
        except:
            pass

def terminal_read_worker(fd):
    global ws_app, shell_fd, shell_pid
    while True:
        try:
            r, _, _ = select.select([fd], [], [])
            if fd in r:
                data = os.read(fd, 2048)
                if not data:
                    # EOF detectado (usuario escribió 'exit' o proceso murió)
                    if ws_app and ws_app.sock and ws_app.sock.connected:
                        try:
                            ws_app.send(json.dumps({"type": "terminal_exited", "id": RASPBERRY_ID}))
                        except: pass
                    break # EOF
                if ws_app and ws_app.sock and ws_app.sock.connected:
                    ws_app.send(json.dumps({
                        "type": "terminal_output",
                        "id": RASPBERRY_ID,
                        "data": data.decode("utf-8", errors="replace")
                    }))
        except Exception as e:
            break
            
    # Auto-limpieza de recursos al morir el hilo
    try:
        os.close(fd)
    except: pass
    if shell_fd == fd:
        shell_fd = None
    if shell_pid is not None:
        shell_pid = None

def on_message(ws, message):
    global shell_fd, shell_pid, terminal_thread
    
    try:
        msg = json.loads(message)
    except:
        return
        
    msg_type = msg.get("type")
    
    # --- GET INFO ---
    if msg_type == "get_info":
        req_id = msg.get("reqId")
        local_ip = "Desconocida"
        red = "N/A"
        temp = "N/A"
        
        # IP
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except:
            pass
            
        # Temp
        try:
            out = subprocess.check_output(["vcgencmd", "measure_temp"]).decode()
            temp = out.replace("temp=", "").strip()
        except:
            try:
                with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                    t = int(f.read().strip())
                    temp = f"{t/1000:.1f}'C"
            except:
                pass
                
        # Red
        try:
            out = subprocess.check_output(["iwgetid", "-r"]).decode().strip()
            if out:
                red = f"{out} (WiFi)"
            else:
                red = f"Cableado ({local_ip})"
        except:
            red = "Cableado Ethernet"
            
        ws.send(json.dumps({
            "type": "info_response",
            "reqId": req_id,
            "temperatura": temp,
            "red": red,
            "ip": local_ip
        }))

    # --- TERMINAL ---
    elif msg_type == "terminal_start":
        print("Iniciando terminal PTY python")
        
        if shell_pid is not None:
            try:
                os.kill(shell_pid, signal.SIGKILL)
            except: pass
            shell_pid = None
            
        if shell_fd is not None:
            try:
                os.close(shell_fd)
            except: pass
            shell_fd = None
            
        pid, fd = pty.fork()
        if pid == 0:
            env = os.environ.copy()
            env["TERM"] = "xterm-color"
            os.chdir(os.environ.get("HOME", "/root"))
            os.execvpe("bash", ["bash"], env)
        else:
            shell_pid = pid
            shell_fd = fd
            terminal_thread = threading.Thread(target=terminal_read_worker, args=(fd,), daemon=True)
            terminal_thread.start()

    elif msg_type == "terminal_input":
        if shell_fd is not None:
            try:
                os.write(shell_fd, msg.get("data", "").encode("utf-8"))
            except Exception as e:
                pass

    elif msg_type in ["terminal_stop", "terminal_close"]:
        if shell_pid is not None:
            try:
                os.kill(shell_pid, signal.SIGTERM)
                time.sleep(0.1)
                os.kill(shell_pid, signal.SIGKILL)
            except: pass
            shell_pid = None
            
        if shell_fd is not None:
            try:
                os.close(shell_fd)
            except: pass
            shell_fd = None

    # --- COMANDOS ---
    elif msg_type == "command":
        cmd = msg.get("command")
        if cmd == "reboot":
            subprocess.Popen(["sudo", "reboot"])
        elif cmd == "cerrar_tunel":
            PORT_FILE = "/home/pi/tunel_port.txt"
            if os.path.exists(PORT_FILE):
                try:
                    with open(PORT_FILE, "r") as f:
                        old_port = f.read().strip()
                    subprocess.Popen(f"pkill -f 'ssh.*-R 0.0.0.0:{old_port}'", shell=True)
                    os.remove(PORT_FILE)
                except:
                    pass

    # --- TUNEL ---
    elif msg_type == "abrir_tunel":
        puerto = msg.get("puerto")
        PORT_FILE = "/home/pi/tunel_port.txt"
        if os.path.exists(PORT_FILE):
            try:
                with open(PORT_FILE, "r") as f:
                    old_port = f.read().strip()
                subprocess.Popen(f"pkill -f 'ssh.*-R 0.0.0.0:{old_port}'", shell=True)
            except:
                pass
                
        cmd = f"timeout 30m ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes -R 0.0.0.0:{puerto}:192.168.4.1:80 ubuntu@raspberrymanager.duckdns.org -N"
        subprocess.Popen(cmd, shell=True)
        with open(PORT_FILE, "w") as f:
            f.write(str(puerto))

    # --- GESTOR DE ARCHIVOS ---
    elif msg_type == "list_dir":
        req_id = msg.get("reqId")
        path = msg.get("path", "/home/pi")
        try:
            entries = []
            for entry in os.scandir(path):
                entries.append({
                    "name": entry.name,
                    "is_dir": entry.is_dir(),
                    "size": entry.stat().st_size,
                    "mtime": entry.stat().st_mtime
                })
            ws.send(json.dumps({
                "type": "list_dir_response",
                "reqId": req_id,
                "entries": entries
            }))
        except Exception as e:
            ws.send(json.dumps({"type": "list_dir_response", "reqId": req_id, "error": str(e)}))

    elif msg_type == "read_file_start":
        req_id = msg.get("reqId")
        path = msg.get("path")
        
        def download_worker(req_id, path):
            try:
                with open(path, "rb") as f:
                    while True:
                        chunk = f.read(512 * 1024)
                        if not chunk:
                            ws.send(json.dumps({"type": "read_file_chunk", "reqId": req_id, "data": "", "eof": True}))
                            break
                        
                        b64_data = base64.b64encode(chunk).decode("utf-8")
                        ws.send(json.dumps({"type": "read_file_chunk", "reqId": req_id, "data": b64_data, "eof": False}))
                        time.sleep(0.05)
            except Exception as e:
                try: ws.send(json.dumps({"type": "read_file_chunk", "reqId": req_id, "error": str(e), "eof": True}))
                except: pass

        t = threading.Thread(target=download_worker, args=(req_id, path), daemon=True)
        t.start()

    elif msg_type == "write_file_init":
        req_id = msg.get("reqId")
        path = msg.get("path")
        try:
            with open(path, "wb") as f:
                pass
            ws.send(json.dumps({"type": "write_file_init_response", "reqId": req_id}))
        except Exception as e:
            ws.send(json.dumps({"type": "write_file_init_response", "reqId": req_id, "error": str(e)}))

    elif msg_type == "write_file_chunk":
        req_id = msg.get("reqId")
        path = msg.get("path")
        b64_data = msg.get("data", "")
        try:
            chunk = base64.b64decode(b64_data)
            with open(path, "ab") as f:
                f.write(chunk)
            ws.send(json.dumps({"type": "write_file_chunk_response", "reqId": req_id}))
        except Exception as e:
            ws.send(json.dumps({"type": "write_file_chunk_response", "reqId": req_id, "error": str(e)}))

    # --- WEB PROXY ---
    elif msg_type == "web_request":
        path = msg.get("path")
        method = msg.get("method")
        headers = msg.get("headers", {})
        req_id = msg.get("requestId")
        body_b64 = msg.get("body", "")
        
        body_bytes = None
        if body_b64:
            try:
                body_bytes = base64.b64decode(body_b64)
            except:
                pass
                
        try:
            conn = http.client.HTTPConnection("127.0.0.1", 80, timeout=10)
            conn.request(method, path, body=body_bytes, headers=headers)
            res = conn.getresponse()
            resp_body = res.read()
            
            resp_headers = dict(res.getheaders())
            
            ws.send(json.dumps({
                "type": "web_response",
                "requestId": req_id,
                "status": res.status,
                "headers": resp_headers,
                "body": base64.b64encode(resp_body).decode("utf-8")
            }))
            conn.close()
        except Exception as e:
            ws.send(json.dumps({
                "type": "web_response",
                "requestId": req_id,
                "status": 500,
                "headers": {"content-type": "text/plain"},
                "body": base64.b64encode(b"Proxy error").decode("utf-8")
            }))

def on_error(ws, error):
    pass

def on_close(ws, close_status_code, close_msg):
    pass

def on_open(ws):
    print("Conectado al servidor")
    global reconnect_delay
    reconnect_delay = 5
    
    mac_eth0 = get_mac_address()
    
    ws.send(json.dumps({
        "type": "register",
        "id": RASPBERRY_ID,
        "mac_eth0": mac_eth0
    }))
    
    if PUB_KEY:
        ws.send(json.dumps({
            "type": "register_key",
            "id": RASPBERRY_ID,
            "key": PUB_KEY
        }))

def connect():
    global ws_app, reconnect_delay
    mac_eth0 = get_mac_address() # Just a warm up
    
    websocket.enableTrace(False)
    ws_app = websocket.WebSocketApp(SERVER,
                              on_open=on_open,
                              on_message=on_message,
                              on_error=on_error,
                              on_close=on_close)
                              
    ws_app.run_forever()

if __name__ == "__main__":
    t = threading.Thread(target=heartbeat_worker, daemon=True)
    t.start()
    
    while True:
        try:
            connect()
        except:
            pass
        
        import random
        jitter = random.randint(0, 2)
        delay = reconnect_delay + jitter
        print(f"Reconectando en {delay}s...")
        time.sleep(delay)
        reconnect_delay *= 2
        if reconnect_delay > max_reconnect_delay:
            reconnect_delay = max_reconnect_delay
