#!/usr/bin/env python3
import base64
import json
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get('PORT', 8080))
AUTH_USER = os.environ.get('AUTH_USER', os.environ.get('AUTH_USERNAME', ''))
AUTH_PASS = os.environ.get('AUTH_PASS', os.environ.get('AUTH_PASSWORD', ''))
API_TOKEN = os.environ.get('API_TOKEN', '')
RATE_ORDER = os.environ.get('RATE_ORDER', 'down/up').lower()


def parse_rate_to_bps(val_str):
    """Mengubah format rate (contoh: 20480, 20M, 10G, 10240K) ke satuan bps"""
    val_str = val_str.strip().lower()
    if not val_str or val_str == '-':
        return 0

    match = re.match(r'^([\d\.]+)\s*([kmg])?b?$', val_str)
    if not match:
        return 0

    num = float(match.group(1))
    unit = match.group(2)

    if unit == 'g':
        return int(num * 1_000_000_000)
    elif unit == 'm':
        return int(num * 1_000_000)
    elif unit == 'k':
        return int(num * 1_000)
    else:
        # Pada Accel-PPP shaper, angka tanpa unit umumnya dalam satuan Kbit
        return int(num * 1_000) if num < 1_000_000 else int(num)


def get_accel_sessions():
    """Menjalankan accel-cmd show sessions dan mem-parsing hasilnya ke JSON"""
    try:
        cmd = ['accel-cmd', 'show', 'sessions', 'username,ip,rate-limit']
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )

        if result.returncode != 0:
            return {
                'error': f'accel-cmd failed with code {result.returncode}: {result.stderr.strip()}'
            }, 500

        lines = [
            line.strip()
            for line in result.stdout.strip().splitlines()
            if line.strip()
        ]
        # Minimal ada 2 baris (header dan pemisah)
        if len(lines) < 2:
            return [], 200

        sessions = []
        # Baris 0 = header, Baris 1 = separator garis (----+----+----)
        # Baris 2 ke atas adalah data sesi
        for line in lines[2:]:
            cols = [c.strip() for c in line.split('|')]
            if len(cols) < 2:
                continue

            username = cols[0]
            ip = cols[1]
            rate_limit_raw = cols[2] if len(cols) > 2 else ''

            max_limit = 'Tidak ada limit'

            if '/' in rate_limit_raw:
                parts = rate_limit_raw.split('/')
                rate1 = parse_rate_to_bps(parts[0])
                rate2 = parse_rate_to_bps(parts[1])

                # Sesuaikan urutan: format standar monitor adalah upload/download (bps)
                if RATE_ORDER == 'up/down':
                    up_bps = rate1
                    down_bps = rate2
                else:
                    # Default shaper Accel-PPP adalah down/up
                    down_bps = rate1
                    up_bps = rate2

                max_limit = f'{up_bps}/{down_bps}'

            sessions.append({
                'username': username,
                'ip': ip,
                'max_limit': max_limit,
            })

        return sessions, 200
    except subprocess.TimeoutExpired:
        return {'error': 'accel-cmd command timed out'}, 504
    except FileNotFoundError:
        return {'error': 'accel-cmd binary not found on system PATH'}, 500
    except Exception as e:
        return {'error': str(e)}, 500


class AccelAgentHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/sessions':
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Not Found'}).encode('utf-8'))
            return

        # Validasi Autentikasi (Basic Auth atau Bearer Token)
        auth_header = self.headers.get('Authorization', '')
        is_authenticated = True

        if AUTH_USER or AUTH_PASS:
            is_authenticated = False
            if auth_header.startswith('Basic '):
                try:
                    encoded = auth_header.split(' ', 1)[1].strip()
                    decoded = base64.b64decode(encoded).decode('utf-8')
                    if ':' in decoded:
                        u, p = decoded.split(':', 1)
                        if u == AUTH_USER and p == AUTH_PASS:
                            is_authenticated = True
                except Exception:
                    is_authenticated = False

        if not is_authenticated and API_TOKEN:
            if auth_header == f'Bearer {API_TOKEN}' or auth_header == API_TOKEN:
                is_authenticated = True

        if not is_authenticated:
            self.send_response(401)
            if AUTH_USER or AUTH_PASS:
                self.send_header(
                    'WWW-Authenticate', 'Basic realm="Accel-PPP Agent"'
                )
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(
                json.dumps({'error': 'Unauthorized'}).encode('utf-8')
            )
            return

        sessions, status = get_accel_sessions()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(sessions).encode('utf-8'))

    def log_message(self, format, *args):
        # Mute logging default untuk menjaga kebersihan output
        pass


def main():
    server_address = ('0.0.0.0', PORT)
    httpd = HTTPServer(server_address, AccelAgentHandler)
    auth_mode = 'Basic Auth' if (AUTH_USER or AUTH_PASS) else ('Bearer Token' if API_TOKEN else 'None')
    print(f'Accel-PPP Agent berjalan di http://0.0.0.0:{PORT}/sessions (Auth: {auth_mode})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nMematikan Accel-PPP Agent...')
        httpd.server_close()
        sys.exit(0)


if __name__ == '__main__':
    main()
