[Unit]
Description=Deploy only AliceRealm API from origin/main without migrations
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/
ExecStart=/usr/local/sbin/alicerealm-deploy-main --api-only
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
TimeoutStartSec=infinity
