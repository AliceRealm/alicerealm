# AliceRealm Desktop

AliceRealm Desktop is the Windows-first Tauri shell for the AliceRealm owner
Dashboard, desktop pet, and trusted desktop settings. All windows belong to one
application process:

- `main` opens the hosted Dashboard at
  `https://app.alicerealm.com/dashboard/today`.
- `pet` renders packaged local assets in a transparent, always-on-top window.
- `settings` renders packaged local assets for version information and signed
  desktop updates. It is hidden until opened from the tray.

Closing the Dashboard, pet, or settings window hides that window while the tray application
remains active. The tray menu can reopen the Dashboard, show or hide the pet,
switch between pet dragging and mouse pass-through, check for updates, or quit
the application completely. Launching a second instance focuses the existing
Dashboard. Windows release builds use the GUI subsystem and do not create a
companion console window.

## Security boundary

The hosted Dashboard receives no Tauri capability or native IPC permission.
Only packaged local windows receive native permissions. The pet is named in
`src-tauri/capabilities/pet.json`, and the update settings page is separately
named in `src-tauri/capabilities/settings.json`.
It receives narrowly scoped local permissions for window movement, event
listening, interaction acknowledgement, and pending-action confirmation. The
pet page has a restrictive Content Security Policy and cannot make network
connections. Pairing, HTTPS, WebSocket, and Windows Credential Manager access
remain in the native Rust process.

The local renderer already models the server protocol's `wave`, `high_five`,
`visit_request`, `visit_accept`, `visit_decline`, `gift`, and `emote` events. It
queues reactions, ignores recent replay duplicates, acknowledges an event only
after its animation finishes, and reconnects from the last durable cursor.

## Connect a pet device

Choose **Connect pet device** from the tray. The client creates a short-lived
pairing request and opens the Dashboard approval page. Sign in if necessary,
review the device details, and approve it. The pairing secret never appears in
the browser URL, and the resulting `arpd_...` credential is stored only in
Windows Credential Manager.

Friend actions use `alicerealm://pet/send` links. The NSIS installer registers
that protocol. Every action must still be confirmed inside the local pet
window before the native client sends it; opening a link does not send an
interaction by itself.

## Desktop updates

The client checks
`https://updates.alicerealm.com/desktop/windows/latest/latest.json` at startup
and whenever the owner opens **Check for updates** from the tray. It accepts
only a newer installer signed by the embedded AliceRealm updater public key.
The signature must include the same version announced by the update manifest,
which prevents replaying a valid older installer under an inflated version.

The hosted Dashboard has no updater or process capability. Checking,
downloading, signature verification, and installer launch all happen in native
Rust code. Installation still requires an explicit click in the packaged
settings window.

## Prerequisites

- Node.js 24 or a compatible supported release
- Rust 1.90+ with `cargo`, `rustfmt`, and `clippy`
- Visual Studio C++ build tools and a Windows SDK
- Microsoft Edge WebView2 Runtime

## Develop and verify

```powershell
cd desktop
npm install
npm run check
npm run dev
```

Rust checks:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
```

## Package for Windows

```powershell
cd desktop
npm run build
```

Tauri writes the NSIS installer below `src-tauri/target/release/bundle/nsis/`.
The build runs Vite first and packages the generated local pet and settings
assets. Release builds set `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; with `createUpdaterArtifacts` enabled,
Tauri writes an adjacent `.exe.sig` update signature. The private updater key
and its password must never enter the repository.

After installation, the NSIS hook removes only the nested Start menu shortcuts
left by the legacy PowerShell web-app installer. It does not remove Agent data,
credentials, or the current Tauri shortcut.

Prepare the immutable installer, signature, and mutable update manifest under
`build/desktop-release/<version>/` with:

```powershell
./scripts/release/prepare-desktop-release.ps1
```

`scripts/release/publish-desktop.py` validates manifest consistency before
promoting those files to the R2 desktop channel.

Formal releases run through `.github/workflows/release-desktop.yml`. Pull
requests that change desktop release code run the unsigned checks. After the
change is merged into `main`, pushing a tag named `desktop-v<version>` builds
and updater-signs the NSIS installer on a GitHub-hosted Windows runner. A
separate Linux job downloads that exact workflow artifact and publishes it to
R2. The tag version must exactly match the version in `tauri.conf.json`.

The Windows build job receives only `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The R2 publication job receives only
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, and
`R2_PUBLIC_URL`. These values are GitHub Actions secrets and must never be
committed to the repository.

Local development packages are unsigned; public releases must be code-signed
before distribution. If a managed-enterprise MSI becomes necessary, generate
and sign it in a dedicated Windows release pipeline rather than making it a
prerequisite for ordinary builds.
