# AliceRealm Desktop

AliceRealm Desktop is the Windows-first Tauri shell for the AliceRealm owner
Dashboard and desktop pet. Both windows belong to one application process:

- `main` opens the hosted Dashboard at
  `https://app.alicerealm.com/dashboard/today`.
- `pet` renders packaged local assets in a transparent, always-on-top window.

Closing the Dashboard or pet hides that window while the tray application
remains active. The tray menu can reopen the Dashboard, show or hide the pet,
switch between pet dragging and mouse pass-through, or quit the application
completely. Launching a second instance focuses the existing Dashboard.

## Security boundary

The hosted Dashboard receives no Tauri capability or native IPC permission.
Only the packaged `pet` window is named in `src-tauri/capabilities/pet.json`.
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

## Prerequisites

- Node.js 24 or a compatible supported release
- Rust stable with `cargo`, `rustfmt`, and `clippy`
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
The build runs Vite first and packages only the generated local pet assets.
Local development packages are unsigned; public releases must be code-signed
before distribution. If a managed-enterprise MSI becomes necessary, generate
and sign it in a dedicated Windows release pipeline rather than making it a
prerequisite for ordinary builds.
