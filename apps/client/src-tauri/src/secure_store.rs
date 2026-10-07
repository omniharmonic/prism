//! Device-token storage in the platform keychain. Never a file, never
//! localStorage.
//!
//! One generic-password item per server origin:
//!   service = the app identifier (e.g. `com.benjaminlife.prism.client`)
//!   account = the server origin (`https://prism.example.com`)
//! so switching servers doesn't mix tokens, and the item is visible and
//! deletable in Keychain Access under a recognizable name.
//!
//! Apple (macOS + iOS) goes through Security.framework's `SecItem*` API via the
//! `security-framework` crate. The item is marked non-synchronizable, so it
//! never goes to iCloud Keychain. On iOS it is also created with the
//! `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` accessibility class: it
//! never leaves this device (no backup restore onto another phone) and is
//! readable after the first unlock since boot, so APNs re-registration and
//! a launch from a notification work while the phone is locked. There is
//! deliberately NO biometric access control on the item: the optional app lock
//! (Face ID) is enforced in the UI (plugins/prism-ios), see docs/client-app.md.
//!
//! Every call is blocking (the keychain may show a system prompt), so callers
//! run it on a blocking thread.

#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "keychain: {}", self.0)
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::StoreError;
    use security_framework::base::Error;
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    fn options(service: &str, account: &str) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(service, account);
        o.set_access_synchronized(Some(false));
        o
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, StoreError> {
        match generic_password(options(service, account)) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| StoreError("stored token is not UTF-8".into())),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), StoreError> {
        // Replace rather than update: a fresh item gets a fresh ACL bound to the
        // current app binary, and there is never a stale duplicate.
        delete(service, account)?;
        let mut o = options(service, account);
        #[cfg(target_os = "ios")]
        {
            use security_framework::access_control::{ProtectionMode, SecAccessControl};
            let ac = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )
            .map_err(err)?;
            o.set_access_control(ac);
        }
        o.set_label("Prism device token");
        o.set_description("Prism Client sign-in (revocable in Prism → Account → Devices)");
        set_generic_password_options(secret.as_bytes(), o).map_err(err)
    }

    pub fn delete(service: &str, account: &str) -> Result<(), StoreError> {
        match delete_generic_password_options(options(service, account)) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(err(e)),
        }
    }

    fn err(e: Error) -> StoreError {
        StoreError(format!("{e} ({})", e.code()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    //! No keychain binding for this platform yet. Refuse rather than fall back
    //! to a file: the client stays signed out instead of storing a bearer
    //! token in plaintext.
    use super::StoreError;
    const MSG: &str = "secure storage is not implemented on this platform yet";
    pub fn get(_: &str, _: &str) -> Result<Option<String>, StoreError> {
        Ok(None)
    }
    pub fn set(_: &str, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError(MSG.into()))
    }
    pub fn delete(_: &str, _: &str) -> Result<(), StoreError> {
        Ok(())
    }
}

pub use imp::{delete, get, set};
