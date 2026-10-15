#!/usr/bin/env bash
# One-shot setup on a fresh Ubuntu 22.04/24.04 VPS (run as root from the repo checkout):
#   sudo bash server/deploy/setup.sh [domain]
# Installs: signaling server (systemd, 127.0.0.1:8787) behind Caddy (auto HTTPS on 443) + coturn (STUN/TURN on 3478).
# Without a domain it uses <ip>.sslip.io, which resolves to the server's IP and gets a real Let's Encrypt cert.
# Optional env: ALLOWED_ORIGINS, PUSH_NOTIFY_URL, PUSH_NOTIFY_SECRET (must equal the Worker's NOTIFY_SECRET).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IP="$(curl -4fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="${1:-${IP//./-}.sslip.io}"
ENVF=/etc/p2p-voice.env

apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -yq nodejs npm coturn debian-keyring debian-archive-keyring apt-transport-https curl gnupg ufw
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

# --- secrets/env (kept across re-runs) ---
if [ ! -f "$ENVF" ]; then
  install -m 600 /dev/null "$ENVF"
  cat > "$ENVF" <<EOF
PORT=8787
HOST=127.0.0.1
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://filippov-au.github.io}
TURN_SECRET=$(openssl rand -hex 32)
TURN_URLS=stun:$DOMAIN:3478,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
PUSH_NOTIFY_URL=${PUSH_NOTIFY_URL:-https://p2p-voice-signal.tmn-sun.workers.dev/api/push/joined}
PUSH_NOTIFY_SECRET=${PUSH_NOTIFY_SECRET:-}
EOF
fi
# shellcheck disable=SC1090
. "$ENVF"

# --- signaling server ---
id -u p2pvoice >/dev/null 2>&1 || useradd --system --home /opt/p2p-voice --shell /usr/sbin/nologin p2pvoice
mkdir -p /opt/p2p-voice && cp "$REPO/server/index.mjs" "$REPO/server/package.json" "$REPO/server/package-lock.json" /opt/p2p-voice/
(cd /opt/p2p-voice && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root /opt/p2p-voice && chmod -R u=rwX,go=rX /opt/p2p-voice
cat > /etc/systemd/system/p2p-voice-signal.service <<EOF
[Unit]
Description=p2p-voice signaling
After=network-online.target
[Service]
EnvironmentFile=$ENVF
ExecStart=$(command -v node) /opt/p2p-voice/index.mjs
User=p2pvoice
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF

# --- coturn (TURN REST credentials, shared secret with the signaling server) ---
cat > /etc/turnserver.conf <<EOF
listening-port=3478
external-ip=$IP
realm=$DOMAIN
use-auth-secret
static-auth-secret=$TURN_SECRET
fingerprint
min-port=49152
max-port=65535
no-tls
no-dtls
no-cli
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
total-quota=100
user-quota=12
log-file=syslog
EOF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true

# --- Caddy: HTTPS + WebSocket proxy ---
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:8787
}
EOF

# --- firewall ---
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 3478 && ufw allow 49152:65535/udp && ufw --force enable

systemctl daemon-reload
systemctl enable --now p2p-voice-signal coturn caddy
systemctl restart p2p-voice-signal coturn caddy
echo
echo "Done. Signaling URL for docs/app.js SIGNALS:  wss://$DOMAIN/room/"
