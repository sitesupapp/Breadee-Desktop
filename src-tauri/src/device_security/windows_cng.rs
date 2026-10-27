//! Windows half of the device-security surface: CNG / NCrypt key storage and
//! DPAPI sealing. Every function here moves bytes that `format.rs` has already
//! validated or will validate; no policy lives in this file.
//!
//! KEY. A persisted ECDSA P-256 key, user-scoped, created WITHOUT
//! `NCRYPT_ALLOW_EXPORT_FLAG`, first in the Microsoft Platform Crypto Provider
//! (TPM-backed: the private key never exists outside the chip) and, only when
//! that provider is absent or refuses to create a key, in the Microsoft Software
//! Key Storage Provider (DPAPI-protected, bound to this Windows user on this
//! machine, export policy explicitly 0). Only the PUBLIC blob is ever exported.
//!
//! IDENTITY STABILITY. A device must not silently change identity: an existing
//! key is always preferred, and a new key is created only when every provider
//! that could be opened answered "no such key" (NTE_BAD_KEYSET / NTE_NOT_FOUND).
//! A transient TPM error is surfaced as an error, never papered over with a
//! fresh software key (which would orphan the server registration).

use std::sync::Mutex;

use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Foundation::{LocalFree, HLOCAL, NTE_BAD_KEYSET, NTE_NOT_FOUND};
use windows::Win32::Security::Cryptography::{
    BCryptHash, CryptProtectData, CryptUnprotectData, NCryptCreatePersistedKey, NCryptExportKey,
    NCryptFinalizeKey, NCryptFreeObject, NCryptOpenKey, NCryptOpenStorageProvider, NCryptSetProperty,
    NCryptSignHash, BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDSA_P256_ALGORITHM, BCRYPT_SHA256_ALG_HANDLE,
    CERT_KEY_SPEC, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, MS_KEY_STORAGE_PROVIDER,
    MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_FLAGS, NCRYPT_HANDLE,
    NCRYPT_KEY_HANDLE, NCRYPT_PROV_HANDLE, NCRYPT_SILENT_FLAG,
};

use super::format;

/// Serialises key resolution so two concurrent first calls cannot both decide
/// "no key yet" and create two identities.
static KEY_LOCK: Mutex<()> = Mutex::new(());

struct Provider(NCRYPT_PROV_HANDLE);
impl Drop for Provider {
    fn drop(&mut self) {
        if self.0 .0 != 0 {
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE::from(self.0));
            }
        }
    }
}

struct Key(NCRYPT_KEY_HANDLE);
impl Drop for Key {
    fn drop(&mut self) {
        if self.0 .0 != 0 {
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE::from(self.0));
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Tpm,
    Software,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Tpm => "tpm",
            Kind::Software => "software",
        }
    }
    fn provider_name(self) -> PCWSTR {
        match self {
            Kind::Tpm => MS_PLATFORM_CRYPTO_PROVIDER,
            Kind::Software => MS_KEY_STORAGE_PROVIDER,
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn hr(e: &windows::core::Error) -> String {
    format!("0x{:08x}", e.code().0 as u32)
}

fn is_missing(code: HRESULT) -> bool {
    code == NTE_BAD_KEYSET || code == NTE_NOT_FOUND
}

fn open_provider(kind: Kind) -> Result<Provider, windows::core::Error> {
    let mut h = NCRYPT_PROV_HANDLE(0);
    unsafe { NCryptOpenStorageProvider(&mut h, kind.provider_name(), 0)? };
    Ok(Provider(h))
}

fn open_key(p: &Provider, name: &[u16]) -> Result<Key, windows::core::Error> {
    let mut k = NCRYPT_KEY_HANDLE(0);
    unsafe { NCryptOpenKey(p.0, &mut k, PCWSTR(name.as_ptr()), CERT_KEY_SPEC(0), NCRYPT_SILENT_FLAG)? };
    Ok(Key(k))
}

fn create_key(p: &Provider, kind: Kind, name: &[u16]) -> Result<Key, windows::core::Error> {
    let mut k = NCRYPT_KEY_HANDLE(0);
    unsafe {
        NCryptCreatePersistedKey(
            p.0,
            &mut k,
            BCRYPT_ECDSA_P256_ALGORITHM,
            PCWSTR(name.as_ptr()),
            CERT_KEY_SPEC(0),
            NCRYPT_FLAGS(0),
        )?
    };
    let key = Key(k);
    if kind == Kind::Software {
        // Explicitly NOT exportable (0 = no NCRYPT_ALLOW_EXPORT_FLAG / plaintext
        // export flag). The TPM provider cannot export private keys at all.
        let policy: u32 = 0;
        unsafe {
            NCryptSetProperty(
                NCRYPT_HANDLE::from(key.0),
                NCRYPT_EXPORT_POLICY_PROPERTY,
                &policy.to_le_bytes(),
                NCRYPT_FLAGS(0),
            )?
        };
    }
    unsafe { NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG)? };
    Ok(key)
}

/// Open this install's device key, creating it once if (and only if) no
/// provider has it.
fn resolve_key(identifier: &str) -> Result<(Key, Kind), String> {
    let _guard = KEY_LOCK.lock().map_err(|_| "device_key_lock_poisoned".to_string())?;
    let name = wide(&format::key_container_name(identifier));

    // 1. Existing TPM key?
    let tpm = open_provider(Kind::Tpm).ok();
    let mut tpm_missing = true;
    if let Some(p) = &tpm {
        match open_key(p, &name) {
            Ok(k) => return Ok((k, Kind::Tpm)),
            Err(e) if is_missing(e.code()) => {}
            Err(_) => tpm_missing = false,
        }
    }

    // 2. Existing software key?
    let sw = open_provider(Kind::Software).map_err(|e| format!("device_key_provider_unavailable:{}", hr(&e)))?;
    match open_key(&sw, &name) {
        Ok(k) => return Ok((k, Kind::Software)),
        Err(e) if is_missing(e.code()) => {}
        Err(e) => return Err(format!("device_key_open_failed:{}", hr(&e))),
    }

    // A TPM that is present but answered with something other than "no such
    // key" may be holding this device's identity right now - never mint a second.
    if !tpm_missing {
        return Err("device_key_tpm_unavailable".into());
    }

    // 3. Create: TPM first, software fallback.
    if let Some(p) = &tpm {
        if let Ok(k) = create_key(p, Kind::Tpm, &name) {
            return Ok((k, Kind::Tpm));
        }
    }
    create_key(&sw, Kind::Software, &name)
        .map(|k| (k, Kind::Software))
        .map_err(|e| format!("device_key_create_failed:{}", hr(&e)))
}

fn export_public_blob(key: &Key) -> Result<Vec<u8>, String> {
    let mut cb: u32 = 0;
    unsafe { NCryptExportKey(key.0, None, BCRYPT_ECCPUBLIC_BLOB, None, None, &mut cb, NCRYPT_FLAGS(0)) }
        .map_err(|e| format!("device_key_export_failed:{}", hr(&e)))?;
    if cb == 0 || cb > 256 {
        return Err("device_key_export_failed:size".into());
    }
    let mut buf = vec![0u8; cb as usize];
    unsafe { NCryptExportKey(key.0, None, BCRYPT_ECCPUBLIC_BLOB, None, Some(buf.as_mut_slice()), &mut cb, NCRYPT_FLAGS(0)) }
        .map_err(|e| format!("device_key_export_failed:{}", hr(&e)))?;
    buf.truncate(cb as usize);
    Ok(buf)
}

fn sha256(data: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    let status = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, data, &mut out) };
    if status.0 < 0 {
        return Err(format!("sha256_failed:0x{:08x}", status.0 as u32));
    }
    Ok(out)
}

fn public_key_of(key: &Key, kind: Kind) -> Result<format::DevicePublicKey, String> {
    let spki = format::ecc_public_blob_to_spki(&export_public_blob(key)?)?;
    Ok(format::DevicePublicKey {
        spki: format::base64_std(&spki),
        fingerprint: format::to_hex(&sha256(&spki)?),
        provider: kind.label().to_string(),
    })
}

pub fn device_public_key(identifier: &str) -> Result<format::DevicePublicKey, String> {
    let (key, kind) = resolve_key(identifier)?;
    public_key_of(&key, kind)
}

pub fn device_sign(identifier: &str, req: &format::DeviceSignRequest) -> Result<format::DeviceSignature, String> {
    let (key, kind) = resolve_key(identifier)?;
    let public = public_key_of(&key, kind)?;
    let message = format::build_sign_message(req, &public.fingerprint)?;
    let digest = sha256(message.as_bytes())?;
    let mut sig = [0u8; 64];
    let mut cb: u32 = 0;
    unsafe { NCryptSignHash(key.0, None, &digest, Some(&mut sig[..]), &mut cb, NCRYPT_SILENT_FLAG) }
        .map_err(|e| format!("device_sign_failed:{}", hr(&e)))?;
    if cb != 64 {
        return Err("device_sign_failed:length".into());
    }
    Ok(format::DeviceSignature {
        message,
        signature: format::base64url_nopad(&sig),
        fingerprint: public.fingerprint,
    })
}

/// Takes ownership of a DPAPI output blob and frees it with LocalFree.
fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() {
        return Vec::new();
    }
    let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void)));
    }
    out
}

pub fn dpapi_protect(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
    let ent = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe { CryptProtectData(&input, PCWSTR::null(), Some(&ent as *const CRYPT_INTEGER_BLOB), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|e| format!("seal_failed:{}", hr(&e)))?;
    Ok(take_blob(out))
}

pub fn dpapi_unprotect(sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: sealed.len() as u32, pbData: sealed.as_ptr() as *mut u8 };
    let ent = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe { CryptUnprotectData(&input, None, Some(&ent as *const CRYPT_INTEGER_BLOB), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|e| format!("unseal_failed:{}", hr(&e)))?;
    Ok(take_blob(out))
}
