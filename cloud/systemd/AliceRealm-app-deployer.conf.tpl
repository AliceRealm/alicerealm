[Service]
WorkingDirectory=/var/lib/alicerealm-deployer/current/source
EnvironmentFile=/etc/alicerealm/runtime.env
ExecStartPre=
ExecStart=
ExecStartPre=/usr/bin/test -x /var/lib/alicerealm-deployer/current/bin/%i
ExecStart=/var/lib/alicerealm-deployer/current/bin/%i
