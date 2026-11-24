use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Mutex,
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use keyring::Entry;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;
use uuid::Uuid;

const API_ORIGIN: &str = "https://app.alicerealm.com";
const PET_STREAM_URL: &str = "wss://stream.alicerealm.com/api/v2/pet/events/ws";
const CREDENTIAL_SERVICE: &str = "com.alicerealm.desktop";
const CREDENTIAL_USER: &str = "pet-device-token";

struct PetRuntime {
    client: Client,
    connection_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pairing_active: std::sync::atomic::AtomicBool,
    pending_action: Mutex<Option<PetAction>>,
    cursor: AtomicI64,
}

impl PetRuntime {
    fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("AliceRealm HTTP client configuration failed"),
            connection_task: Mutex::new(None),
            pairing_active: std::sync::atomic::AtomicBool::new(false),
            pending_action: Mutex::new(None),
            cursor: AtomicI64::new(0),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    data: Option<T>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct PairingInfo {
    pairing_id: String,
}

#[derive(Debug, Deserialize)]
struct PairingGrant {
    pairing: PairingInfo,
    pairing_secret: String,
    dashboard_url: String,
}

#[derive(Debug, Deserialize)]
struct PairingExchange {
    device_token: String,
}

#[derive(Clone, Debug, Serialize)]
struct PetConnectionEvent {
    state: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct InteractionPayload {
    #[serde(skip_serializing_if = "String::is_empty")]
    message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    gift_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    emote_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    reply_to_interaction_id: String,
}

#[derive(Debug, Serialize)]
struct InteractionRequest {
    request_id: String,
    receiver_agent_id: String,
    event_type: String,
    payload: InteractionPayload,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct PetAction {
    receiver_agent_id: String,
    event_type: String,
    message: String,
    gift_id: String,
    emote_id: String,
    reply_to_interaction_id: String,
}

fn show_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_pet_passthrough<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.set_ignore_cursor_events(enabled);
    }
}

fn emit_connection(app: &AppHandle, state: &'static str, message: impl Into<String>) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.emit(
            "pet-connection",
            PetConnectionEvent {
                state,
                message: message.into(),
            },
        );
    }
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER).map_err(|error| error.to_string())
}

fn load_device_token() -> Option<String> {
    credential_entry().ok()?.get_password().ok()
}

fn save_device_token(token: &str) -> Result<(), String> {
    if !token.starts_with("arpd_") || token.len() != 69 {
        return Err("AliceRealm returned an invalid pet device token".into());
    }
    credential_entry()?
        .set_password(token)
        .map_err(|error| error.to_string())
}

fn delete_device_token() {
    if let Ok(entry) = credential_entry() {
        let _ = entry.delete_credential();
    }
}

fn parse_pet_action(url: &Url) -> Result<PetAction, String> {
    if url.scheme() != "alicerealm" || url.host_str() != Some("pet") || url.path() != "/send" {
        return Err("unsupported AliceRealm desktop link".into());
    }
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let receiver = query.get("receiver_agent_id").cloned().unwrap_or_default();
    if receiver
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .is_none()
    {
        return Err("receiver_agent_id must be a positive decimal string".into());
    }
    let event_type = query.get("event_type").cloned().unwrap_or_default();
    if !matches!(
        event_type.as_str(),
        "wave"
            | "high_five"
            | "visit_request"
            | "visit_accept"
            | "visit_decline"
            | "gift"
            | "emote"
    ) {
        return Err("unsupported pet interaction".into());
    }
    let bounded = |name: &str, max: usize| -> String {
        query
            .get(name)
            .map(|value| value.chars().take(max).collect())
            .unwrap_or_default()
    };
    let action = PetAction {
        receiver_agent_id: receiver,
        event_type,
        message: bounded("message", 200),
        gift_id: bounded("gift_id", 64),
        emote_id: bounded("emote_id", 64),
        reply_to_interaction_id: bounded("reply_to_interaction_id", 19),
    };
    if action.event_type == "gift" && action.gift_id.is_empty()
        || action.event_type == "emote" && action.emote_id.is_empty()
    {
        return Err("gift and emote interactions require an asset identifier".into());
    }
    Ok(action)
}

async fn send_pet_action(app: AppHandle, action: PetAction) -> Result<(), String> {
    let token = load_device_token().ok_or_else(|| "请先从托盘菜单连接桌宠设备".to_string())?;
    let runtime = app.state::<PetRuntime>();
    let response = runtime
        .client
        .post(format!("{API_ORIGIN}/api/v2/pet/interactions"))
        .bearer_auth(&token)
        .json(&InteractionRequest {
            request_id: format!("desktop-{}", Uuid::new_v4()),
            receiver_agent_id: action.receiver_agent_id,
            event_type: action.event_type,
            payload: InteractionPayload {
                message: action.message,
                gift_id: action.gift_id,
                emote_id: action.emote_id,
                reply_to_interaction_id: action.reply_to_interaction_id,
            },
        })
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_device_token();
        emit_connection(&app, "offline", "桌宠设备授权已失效，请重新连接");
        return Err("桌宠设备授权已失效".into());
    }
    if !response.status().is_success() {
        let envelope = response.json::<ApiEnvelope<Value>>().await.ok();
        return Err(envelope
            .and_then(|value| value.error)
            .map(|error| error.message)
            .unwrap_or_else(|| "桌宠互动发送失败".into()));
    }
    emit_connection(&app, "connected", "桌宠互动已发送");
    Ok(())
}

fn handle_desktop_url(app: AppHandle, url: Url) {
    let action = match parse_pet_action(&url) {
        Ok(action) => action,
        Err(message) => {
            emit_connection(&app, "error", message);
            return;
        }
    };
    if let Ok(mut pending) = app.state::<PetRuntime>().pending_action.lock() {
        *pending = Some(action.clone());
        if let Some(window) = app.get_webview_window("pet") {
            let _ = window.emit("pet-action-request", action);
        }
        set_pet_passthrough(&app, false);
        show_window(&app, "pet");
    }
}

async fn begin_pairing(app: AppHandle) -> Result<(), String> {
    emit_connection(&app, "pairing", "正在创建安全配对请求");
    let runtime = app.state::<PetRuntime>();
    let device_name = std::env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "AliceRealm Windows desktop".into());
    let response = runtime
        .client
        .post(format!("{API_ORIGIN}/api/v2/pet/pairings"))
        .json(&json!({"device_name": device_name, "platform": "windows"}))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let envelope: ApiEnvelope<PairingGrant> =
        response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(envelope
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "无法创建桌宠配对".into()));
    }
    let grant = envelope
        .data
        .ok_or_else(|| "桌宠配对响应不完整".to_string())?;
    let dashboard_url = grant
        .dashboard_url
        .parse()
        .map_err(|_| "桌宠配对地址无效".to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .navigate(dashboard_url)
            .map_err(|error| error.to_string())?;
    }
    show_window(&app, "main");
    emit_connection(&app, "pairing", "请在 Dashboard 中确认连接");

    for _ in 0..150 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = match runtime
            .client
            .post(format!(
                "{API_ORIGIN}/api/v2/pet/pairings/{}/exchange",
                grant.pairing.pairing_id
            ))
            .json(&json!({"pairing_secret": grant.pairing_secret}))
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => {
                emit_connection(&app, "pairing", "网络暂时不可用，仍在等待配对确认");
                continue;
            }
        };
        let status = response.status();
        let envelope: ApiEnvelope<PairingExchange> =
            response.json().await.map_err(|error| error.to_string())?;
        if status.is_success() {
            let exchange = envelope
                .data
                .ok_or_else(|| "桌宠配对交换响应不完整".to_string())?;
            save_device_token(&exchange.device_token)?;
            start_realtime(app.clone(), exchange.device_token);
            emit_connection(&app, "connected", "桌宠设备已安全连接");
            return Ok(());
        }
        match envelope.error.map(|error| error.code) {
            Some(code) if code == "PET_PAIRING_PENDING" => continue,
            Some(code) if code == "PET_PAIRING_EXPIRED" => {
                return Err("桌宠配对已过期，请重新连接".into())
            }
            _ => return Err("桌宠配对交换失败".into()),
        }
    }
    Err("桌宠配对等待确认超时".into())
}

fn start_realtime(app: AppHandle, token: String) {
    let runtime = app.state::<PetRuntime>();
    if let Ok(mut current) = runtime.connection_task.lock() {
        if let Some(task) = current.take() {
            task.abort();
        }
        let client_app = app.clone();
        *current = Some(tauri::async_runtime::spawn(async move {
            let mut backoff = 1_u64;
            loop {
                let cursor = client_app
                    .state::<PetRuntime>()
                    .cursor
                    .load(Ordering::SeqCst);
                let mut url =
                    Url::parse(PET_STREAM_URL).expect("static pet stream URL must be valid");
                url.query_pairs_mut()
                    .append_pair("token", &token)
                    .append_pair("cursor", &cursor.to_string());
                emit_connection(&client_app, "connecting", "正在连接 AliceRealm 桌宠网络");
                match connect_async(url.as_str()).await {
                    Ok((mut stream, _)) => {
                        backoff = 1;
                        emit_connection(&client_app, "connected", "AliceRealm 桌宠已连接");
                        while let Some(message) = stream.next().await {
                            match message {
                                Ok(Message::Text(text)) => {
                                    if let Ok(value) = serde_json::from_str::<Value>(text.as_ref())
                                    {
                                        if value.get("type").and_then(Value::as_str)
                                            == Some("pet.interaction")
                                        {
                                            if let Some(window) =
                                                client_app.get_webview_window("pet")
                                            {
                                                let _ = window.emit("pet-interaction", value);
                                            }
                                        }
                                    }
                                }
                                Ok(Message::Ping(payload)) => {
                                    if stream.send(Message::Pong(payload)).await.is_err() {
                                        break;
                                    }
                                }
                                Ok(Message::Close(_)) | Err(_) => break,
                                _ => {}
                            }
                        }
                    }
                    Err(tokio_tungstenite::tungstenite::Error::Http(response))
                        if response.status() == StatusCode::UNAUTHORIZED =>
                    {
                        delete_device_token();
                        emit_connection(&client_app, "offline", "桌宠设备已被撤销，请重新连接");
                        return;
                    }
                    Err(_) => {}
                }
                emit_connection(
                    &client_app,
                    "offline",
                    format!("连接中断，{backoff} 秒后重试"),
                );
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        }));
    };
}

#[tauri::command]
async fn ack_pet_interaction(
    app: AppHandle,
    runtime: State<'_, PetRuntime>,
    interaction_id: String,
) -> Result<(), String> {
    let id = interaction_id
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "interaction_id must be a positive decimal string".to_string())?;
    let token = load_device_token().ok_or_else(|| "桌宠设备尚未连接".to_string())?;
    let response = runtime
        .client
        .post(format!("{API_ORIGIN}/api/v2/pet/interactions/{id}/ack"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_device_token();
        emit_connection(&app, "offline", "桌宠设备已被撤销，请重新连接");
        return Err("桌宠设备授权已失效".into());
    }
    if !response.status().is_success() {
        return Err("桌宠互动确认失败".into());
    }
    runtime.cursor.fetch_max(id, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn confirm_pet_action(app: AppHandle, runtime: State<'_, PetRuntime>) -> Result<(), String> {
    let action = runtime
        .pending_action
        .lock()
        .map_err(|_| "桌宠互动确认状态不可用".to_string())?
        .take()
        .ok_or_else(|| "没有等待确认的桌宠互动".to_string())?;
    send_pet_action(app.clone(), action).await?;
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.emit("pet-action-resolved", json!({"sent": true}));
    }
    Ok(())
}

#[tauri::command]
fn cancel_pet_action(app: AppHandle, runtime: State<'_, PetRuntime>) -> Result<(), String> {
    runtime
        .pending_action
        .lock()
        .map_err(|_| "桌宠互动确认状态不可用".to_string())?
        .take();
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.emit("pet-action-resolved", json!({"sent": false}));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PetRuntime::new())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(url) = args.iter().find_map(|arg| Url::parse(arg).ok()) {
                handle_desktop_url(app.clone(), url);
            } else {
                show_window(app, "main");
            }
        }))
        .invoke_handler(tauri::generate_handler![
            ack_pet_interaction,
            confirm_pet_action,
            cancel_pet_action
        ])
        .setup(|app| {
            let dashboard =
                MenuItem::with_id(app, "dashboard", "打开 AliceRealm", true, None::<&str>)?;
            let pair_device =
                MenuItem::with_id(app, "pair_device", "连接桌宠设备", true, None::<&str>)?;
            let show_pet = MenuItem::with_id(app, "show_pet", "显示桌宠", true, None::<&str>)?;
            let hide_pet = MenuItem::with_id(app, "hide_pet", "隐藏桌宠", true, None::<&str>)?;
            let interactive =
                MenuItem::with_id(app, "pet_interactive", "允许拖动桌宠", true, None::<&str>)?;
            let passthrough =
                MenuItem::with_id(app, "pet_passthrough", "桌宠鼠标穿透", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 AliceRealm", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &dashboard,
                    &pair_device,
                    &show_pet,
                    &hide_pet,
                    &interactive,
                    &passthrough,
                    &quit,
                ],
            )?;

            TrayIconBuilder::with_id("alicerealm")
                .icon(
                    app.default_window_icon()
                        .expect("AliceRealm bundle icon missing")
                        .clone(),
                )
                .tooltip("AliceRealm")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "dashboard" => show_window(app, "main"),
                    "pair_device" => {
                        let app = app.clone();
                        if app
                            .state::<PetRuntime>()
                            .pairing_active
                            .swap(true, Ordering::SeqCst)
                        {
                            emit_connection(&app, "pairing", "已有桌宠配对正在等待确认");
                            return;
                        }
                        tauri::async_runtime::spawn(async move {
                            if let Err(message) = begin_pairing(app.clone()).await {
                                emit_connection(&app, "error", message);
                            }
                            app.state::<PetRuntime>()
                                .pairing_active
                                .store(false, Ordering::SeqCst);
                        });
                    }
                    "show_pet" => show_window(app, "pet"),
                    "hide_pet" => {
                        if let Some(window) = app.get_webview_window("pet") {
                            let _ = window.hide();
                        }
                    }
                    "pet_interactive" => set_pet_passthrough(app, false),
                    "pet_passthrough" => set_pet_passthrough(app, true),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle(), "main");
                    }
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_desktop_url(app_handle.clone(), url.clone());
                }
            });
            if let Some(token) = load_device_token() {
                start_realtime(app.handle().clone(), token);
            } else {
                emit_connection(app.handle(), "offline", "从托盘菜单连接桌宠设备");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(window.label(), "main" | "pet") {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AliceRealm desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_links_allow_only_pet_protocol_actions() {
        let action = parse_pet_action(
            &Url::parse("alicerealm://pet/send?receiver_agent_id=42&event_type=gift&gift_id=friendship_token")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(action.receiver_agent_id, "42");
        assert_eq!(action.event_type, "gift");
        assert_eq!(action.gift_id, "friendship_token");

        for value in [
            "https://app.alicerealm.com/dashboard",
            "alicerealm://pet/send?receiver_agent_id=0&event_type=wave",
            "alicerealm://pet/send?receiver_agent_id=42&event_type=run_script",
            "alicerealm://pet/send?receiver_agent_id=42&event_type=gift",
        ] {
            assert!(
                parse_pet_action(&Url::parse(value).unwrap()).is_err(),
                "accepted {value}"
            );
        }
    }
}
