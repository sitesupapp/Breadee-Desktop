//! Pure, platform-independent half of the device-security surface.
//!
//! Everything here is plain data shaping and validation - no OS call, no file,
//! no key - so it is unit-tested on every platform (`cargo test`) and the
//! Windows half (`windows_cng.rs`) only ever moves bytes it has been handed by
//! these functions.
//!
//! THE SIGNING ORACLE PROBLEM. `device_sign` must never sign "whatever the
//! frontend sends": injected script could otherwise mint a signature over any
//! byte string and replay it as a proof of possession somewhere else. So the
//! command takes FIELDS, each validated against a closed grammar, and this
//! module assembles the one message shape the server reconstructs:
//!
//!   breadee-desktop-v1|<purpose>|<nonce>|<tenant>|<user>|<fingerprint>|<terminal>|<counter>
//!
//! The fingerprint is not an input at all - Rust derives it from the key it is
//! about to sign with - and the domain prefix makes the signature useless for
//! any other protocol.

use serde::{Deserialize, Serialize};

/// Domain-separation prefix for every device signature.
pub const SIGN_DOMAIN: &str = "breadee-desktop-v1";

/// The only purposes a device signature may be produced for.
pub const SIGN_PURPOSES: [&str; 2] = ["register", "entitlement"];

/// The only names `seal_secret` / `unseal_secret` / `clear_secret` accept.
/// A closed list on purpose: the sealed store is not a general key-value store
/// the frontend can grow, it holds exactly these small secrets.
pub const SEAL_NAMES: [&str; 3] = ["auth-session", "time-guard", "entitlement"];

/// Upper bound for a sealed value (a Supabase session JSON is ~2-6 KiB).
pub const MAX_SEAL_BYTES: usize = 64 * 1024;

/// Upper bound for a terminal id inside a signed message.
pub const MAX_TERMINAL_LEN: usize = 64;

/// DER prefix of a SubjectPublicKeyInfo for an uncompressed P-256 point
/// (id-ecPublicKey + prime256v1, BIT STRING of 66 bytes). Appending 0x04||X||Y
/// gives the full 91-byte SPKI WebCrypto imports as "spki".
pub const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// `BCRYPT_ECDSA_PUBLIC_P256_MAGIC` ("ECS1"), duplicated here so the pure
/// parser does not depend on the Windows crate.
pub const ECDSA_PUBLIC_P256_MAGIC: u32 = 0x3153_4345;

/// The fields a caller may ask the device key to sign over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSignRequest {
    pub purpose: String,
    pub nonce: String,
    pub tenant_id: String,
    pub user_id: String,
    pub terminal_id: String,
    pub counter: u64,
}

/// What `device_public_key` returns. No private material, ever.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePublicKey {
    /// Standard base64 of the DER SubjectPublicKeyInfo.
    pub spki: String,
    /// Lowercase hex SHA-256 of the DER SPKI.
    pub fingerprint: String,
    /// "tpm" or "software".
    pub provider: String,
}

/// What `device_sign` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSignature {
    /// The exact UTF-8 message that was signed (the server rebuilds it itself
    /// and compares; this copy is for diagnostics and tests).
    pub message: String,
    /// base64url (no padding) of the 64-byte IEEE-P1363 r||s ECDSA signature.
    pub signature: String,
    pub fingerprint: String,
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Canonical lowercase 8-4-4-4-12 uuid.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let dash = matches!(i, 8 | 13 | 18 | 23);
        if dash {
            if *c != b'-' {
                return false;
            }
        } else if !(c.is_ascii_digit() || (b'a'..=b'f').contains(c)) {
            return false;
        }
    }
    true
}

pub fn is_terminal_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_TERMINAL_LEN
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Validate a sign request and build the one message shape that may be signed.
/// `fingerprint` comes from the key, never from the caller.
pub fn build_sign_message(req: &DeviceSignRequest, fingerprint: &str) -> Result<String, String> {
    if !SIGN_PURPOSES.contains(&req.purpose.as_str()) {
        return Err("invalid_purpose".into());
    }
    if !is_lower_hex(&req.nonce, 64) {
        return Err("invalid_nonce".into());
    }
    if !is_uuid(&req.tenant_id) {
        return Err("invalid_tenant_id".into());
    }
    if !is_uuid(&req.user_id) {
        return Err("invalid_user_id".into());
    }
    if !is_terminal_id(&req.terminal_id) {
        return Err("invalid_terminal_id".into());
    }
    if !is_lower_hex(fingerprint, 64) {
        return Err("invalid_fingerprint".into());
    }
    // JavaScript numbers are exact only up to 2^53; refuse anything above so the
    // value the server parses is the value that was signed.
    if req.counter > (1u64 << 53) {
        return Err("invalid_counter".into());
    }
    Ok(format!(
        "{SIGN_DOMAIN}|{}|{}|{}|{}|{}|{}|{}",
        req.purpose, req.nonce, req.tenant_id, req.user_id, fingerprint, req.terminal_id, req.counter
    ))
}

/// Seal names are a closed allowlist.
pub fn validate_seal_name(name: &str) -> Result<(), String> {
    if SEAL_NAMES.contains(&name) {
        Ok(())
    } else {
        Err("invalid_secret_name".into())
    }
}

pub fn validate_seal_value(value: &str) -> Result<(), String> {
    if value.len() > MAX_SEAL_BYTES {
        Err("secret_too_large".into())
    } else {
        Ok(())
    }
}

/// DPAPI optional entropy: binds a sealed blob to this app identity AND to the
/// name it was sealed under, so one sealed file cannot be swapped in for another.
pub fn seal_entropy(identifier: &str, name: &str) -> Vec<u8> {
    format!("breadee-seal-v1|{identifier}|{name}").into_bytes()
}

/// Persisted key-container name, per app identity (staging and production
/// installs on one PC get different keys).
pub fn key_container_name(identifier: &str) -> String {
    let safe: String = identifier
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    format!("Breadee-{safe}-device-v1")
}

/// Convert a `BCRYPT_ECCKEY_BLOB` public export (ECS1, 32-byte coordinates)
/// into DER SPKI bytes.
pub fn ecc_public_blob_to_spki(blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() != 8 + 64 {
        return Err("unexpected_public_blob_length".into());
    }
    let magic = u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]);
    let cb = u32::from_le_bytes([blob[4], blob[5], blob[6], blob[7]]);
    if magic != ECDSA_PUBLIC_P256_MAGIC || cb != 32 {
        return Err("unexpected_public_blob_header".into());
    }
    let mut out = Vec::with_capacity(91);
    out.extend_from_slice(&P256_SPKI_PREFIX);
    out.push(0x04);
    out.extend_from_slice(&blob[8..72]);
    Ok(out)
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn b64(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let n = match chunk.len() {
            3 => (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]),
            2 => (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8),
            _ => u32::from(chunk[0]) << 16,
        };
        let chars = [
            alphabet[((n >> 18) & 63) as usize],
            alphabet[((n >> 12) & 63) as usize],
            alphabet[((n >> 6) & 63) as usize],
            alphabet[(n & 63) as usize],
        ];
        let keep = chunk.len() + 1;
        for (i, c) in chars.iter().enumerate() {
            if i < keep {
                out.push(*c as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_std(bytes: &[u8]) -> String {
    b64(bytes, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", true)
}

pub fn base64url_nopad(bytes: &[u8]) -> String {
    b64(bytes, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> DeviceSignRequest {
        DeviceSignRequest {
            purpose: "entitlement".into(),
            nonce: "a".repeat(64),
            tenant_id: "d735104d-0000-4000-8000-000000000001".into(),
            user_id: "3a465d34-0000-4000-8000-000000000002".into(),
            terminal_id: "till-1".into(),
            counter: 7,
        }
    }

    #[test]
    fn builds_the_one_domain_separated_message() {
        let fp = "b".repeat(64);
        let m = build_sign_message(&req(), &fp).unwrap();
        assert_eq!(
            m,
            format!(
                "breadee-desktop-v1|entitlement|{}|d735104d-0000-4000-8000-000000000001|3a465d34-0000-4000-8000-000000000002|{}|till-1|7",
                "a".repeat(64),
                fp
            )
        );
    }

    #[test]
    fn refuses_anything_outside_the_grammar() {
        let fp = "b".repeat(64);
        let mut r = req();
        r.purpose = "anything".into();
        assert!(build_sign_message(&r, &fp).is_err());
        let mut r = req();
        r.nonce = "A".repeat(64);
        assert!(build_sign_message(&r, &fp).is_err());
        let mut r = req();
        r.nonce = "a".repeat(63);
        assert!(build_sign_message(&r, &fp).is_err());
        let mut r = req();
        r.tenant_id = "d735104d|0000-4000-8000-000000000001".into();
        assert!(build_sign_message(&r, &fp).is_err());
        let mut r = req();
        r.terminal_id = "till|1".into();
        assert!(build_sign_message(&r, &fp).is_err());
        let mut r = req();
        r.terminal_id = "x".repeat(65);
        assert!(build_sign_message(&r, &fp).is_err());
        let mut r = req();
        r.counter = (1u64 << 53) + 1;
        assert!(build_sign_message(&r, &fp).is_err());
        assert!(build_sign_message(&req(), "zz").is_err());
    }

    #[test]
    fn unknown_request_fields_are_rejected() {
        let json = r#"{"purpose":"register","nonce":"x","tenantId":"t","userId":"u","terminalId":"t","counter":1,"message":"evil"}"#;
        assert!(serde_json::from_str::<DeviceSignRequest>(json).is_err());
    }

    #[test]
    fn seal_names_are_a_closed_list() {
        assert!(validate_seal_name("auth-session").is_ok());
        assert!(validate_seal_name("time-guard").is_ok());
        assert!(validate_seal_name("entitlement").is_ok());
        assert!(validate_seal_name("../auth-session").is_err());
        assert!(validate_seal_name("anything").is_err());
        assert!(validate_seal_value(&"x".repeat(MAX_SEAL_BYTES)).is_ok());
        assert!(validate_seal_value(&"x".repeat(MAX_SEAL_BYTES + 1)).is_err());
    }

    #[test]
    fn entropy_binds_identity_and_name() {
        assert_ne!(seal_entropy("app.a", "time-guard"), seal_entropy("app.a", "auth-session"));
        assert_ne!(seal_entropy("app.a", "time-guard"), seal_entropy("app.b", "time-guard"));
    }

    #[test]
    fn key_container_name_is_per_identity_and_safe() {
        assert_eq!(key_container_name("app.breadee.desktop"), "Breadee-app.breadee.desktop-device-v1");
        assert_eq!(key_container_name("a/b\\c"), "Breadee-a_b_c-device-v1");
    }

    #[test]
    fn ecc_blob_becomes_91_byte_spki() {
        let mut blob = Vec::new();
        blob.extend_from_slice(&ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
        blob.extend_from_slice(&32u32.to_le_bytes());
        blob.extend((0u8..64).collect::<Vec<_>>());
        let spki = ecc_public_blob_to_spki(&blob).unwrap();
        assert_eq!(spki.len(), 91);
        assert_eq!(&spki[..26], &P256_SPKI_PREFIX);
        assert_eq!(spki[26], 0x04);
        assert_eq!(spki[27], 0);
        assert_eq!(spki[90], 63);
        let mut bad = blob.clone();
        bad[0] = 0;
        assert!(ecc_public_blob_to_spki(&bad).is_err());
        assert!(ecc_public_blob_to_spki(&blob[..70]).is_err());
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64_std(b""), "");
        assert_eq!(base64_std(b"f"), "Zg==");
        assert_eq!(base64_std(b"fo"), "Zm8=");
        assert_eq!(base64_std(b"foo"), "Zm9v");
        assert_eq!(base64_std(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url_nopad(&[0xfb, 0xff]), "-_8");
        assert_eq!(to_hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
