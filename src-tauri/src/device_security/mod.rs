//! Device identity + sealed secrets (Final Foundation, Tracks 4/6).
//!
//! FIVE NARROW COMMANDS, AND WHAT THEY CANNOT DO.
//!
//! * `device_public_key()` - the PUBLIC half of this install's non-exportable
//!   ECDSA P-256 key (DER SPKI, its SHA-256 fingerprint, and whether it lives in
//!   the TPM or the software KSP). There is no command that returns, exports or
//!   imports private key material.
//! * `device_sign(request)` - signs ONLY the domain-separated message
//!   `format::build_sign_message` assembles from validated fields (purpose from a
//!   closed list, 64-hex nonce, uuids, a bounded terminal id, a counter). It is
//!   not a signing oracle: the caller cannot choose the bytes that get signed.
//! * `seal_secret(name, value)` / `unseal_secret(name)` / `clear_secret(name)` -
//!   DPAPI (user scope, UI forbidden) sealing of a few small secrets, for a
//!   CLOSED list of names (`format::SEAL_NAMES`), stored as
//!   `<app local data>/secure/<name>.bin`. The name is never used as a path
//!   component until it has matched the allowlist exactly.
//!
//! None of these touch an order, a payment, a shift or a server row. The webview
//! now runs under a strict CSP (tauri.conf.json), and these commands are granted
//! explicitly in capabilities/default.json - nothing here is reachable by a
//! wildcard.

pub mod format;

#[cfg(target_os = "windows")]
mod windows_cng;

use std::path::PathBuf;

use tauri::Manager;

fn identifier(app: &tauri::AppHandle) -> String {
    app.config().identifier.clone()
}

fn secret_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    format::validate_seal_name(name)?;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "app_data_dir_unavailable".to_string())?
        .join("secure");
    Ok(dir.join(format!("{name}.bin")))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "device_security_task_failed".to_string())?
}

/// The public half of this install's device key.
#[tauri::command]
pub async fn device_public_key(app: tauri::AppHandle) -> Result<format::DevicePublicKey, String> {
    let id = identifier(&app);
    blocking(move || platform::device_public_key(&id)).await
}

/// Sign the one fixed-format, domain-separated device message.
#[tauri::command]
pub async fn device_sign(
    app: tauri::AppHandle,
    request: format::DeviceSignRequest,
) -> Result<format::DeviceSignature, String> {
    // Validate BEFORE touching the key (the fingerprint slot is checked again
    // with the real value inside `platform::device_sign`).
    format::build_sign_message(&request, &"0".repeat(64))?;
    let id = identifier(&app);
    blocking(move || platform::device_sign(&id, &request)).await
}

/// Seal a small allowlisted secret for this Windows user.
#[tauri::command]
pub async fn seal_secret(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    let path = secret_path(&app, &name)?;
    format::validate_seal_value_for(&name, &value)?;
    let entropy = format::seal_entropy(&identifier(&app), &name);
    blocking(move || {
        let sealed = platform::protect(value.as_bytes(), &entropy)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|_| "secret_dir_unavailable".to_string())?;
        }
        // Write-then-rename so a crash mid-write never leaves a torn blob that
        // would fail to unseal (and so silently sign the cashier out).
        let tmp = path.with_extension("bin.tmp");
        std::fs::write(&tmp, &sealed).map_err(|_| "secret_write_failed".to_string())?;
        std::fs::rename(&tmp, &path).map_err(|_| "secret_write_failed".to_string())?;
        Ok(())
    })
    .await
}

/// Unseal an allowlisted secret. `Ok(None)` = nothing stored.
#[tauri::command]
pub async fn unseal_secret(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let path = secret_path(&app, &name)?;
    let entropy = format::seal_entropy(&identifier(&app), &name);
    blocking(move || {
        let sealed = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("secret_read_failed".to_string()),
        };
        let plain = platform::unprotect(&sealed, &entropy)?;
        String::from_utf8(plain).map(Some).map_err(|_| "secret_corrupt".to_string())
    })
    .await
}

/// Remove an allowlisted secret (sign-out).
#[tauri::command]
pub async fn clear_secret(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = secret_path(&app, &name)?;
    blocking(move || match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("secret_clear_failed".to_string()),
    })
    .await
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{format, windows_cng};
    pub fn device_public_key(id: &str) -> Result<format::DevicePublicKey, String> {
        windows_cng::device_public_key(id)
    }
    pub fn device_sign(id: &str, req: &format::DeviceSignRequest) -> Result<format::DeviceSignature, String> {
        windows_cng::device_sign(id, req)
    }
    pub fn protect(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        windows_cng::dpapi_protect(plain, entropy)
    }
    pub fn unprotect(sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        windows_cng::dpapi_unprotect(sealed, entropy)
    }
}

/// Compile-time stub: the desktop app ships for Windows only. Every other
/// target compiles, and every call fails closed with a stable error code.
#[cfg(not(target_os = "windows"))]
mod platform {
    use super::format;
    const UNSUPPORTED: &str = "unsupported_platform";
    pub fn device_public_key(_id: &str) -> Result<format::DevicePublicKey, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn device_sign(_id: &str, _req: &format::DeviceSignRequest) -> Result<format::DeviceSignature, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn protect(_plain: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn unprotect(_sealed: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
}
