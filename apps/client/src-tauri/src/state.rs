//! Process-wide client state: the server origin (fixed for the process: the
//! CSP is built from it at startup, so changing it restarts the app), the
//! device-token cache in front of the keychain, the in-flight sign-in, and the
//! single-use grant for the Server settings dialog.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crate::origin::ServerOrigin;
use crate::pkce::{ct_eq, random_token};
use crate::secure_store;

/// How long a Server settings grant (minted by a native menu click) is valid.
const SETTINGS_GRANT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
struct TokenCache {
    loaded: bool,
    token: Option<String>,
}

pub struct AppState {
    pub origin: ServerOrigin,
    /// Keychain service name = the app identifier.
    service: String,
    pub settings_dir: Option<PathBuf>,
    token: tokio::sync::Mutex<TokenCache>,
    sign_in_cancel: Mutex<Option<oneshot::Sender<()>>>,
    settings_grant: Mutex<Option<(String, Instant)>>,
}

impl AppState {
    pub fn new(origin: ServerOrigin, service: String, settings_dir: Option<PathBuf>) -> Self {
        Self {
            origin,
            service,
            settings_dir,
            token: Default::default(),
            sign_in_cancel: Mutex::new(None),
            settings_grant: Mutex::new(None),
        }
    }

    /// The device token for this origin. The keychain is read once per
    /// process; after that the in-memory copy serves every request (getToken is
    /// called per fetch).
    pub async fn token(&self) -> Result<Option<String>, String> {
        let mut cache = self.token.lock().await;
        if !cache.loaded {
            let (service, account) = (self.service.clone(), self.origin.as_str().to_string());
            let t = blocking(move || secure_store::get(&service, &account)).await?;
            cache.token = t;
            cache.loaded = true;
        }
        Ok(cache.token.clone())
    }

    pub async fn store_token(&self, token: String) -> Result<(), String> {
        let mut cache = self.token.lock().await;
        let (service, account, t) = (
            self.service.clone(),
            self.origin.as_str().to_string(),
            token.clone(),
        );
        blocking(move || secure_store::set(&service, &account, &t)).await?;
        cache.token = Some(token);
        cache.loaded = true;
        Ok(())
    }

    /// Delete the token from memory and the keychain; returns what was there.
    pub async fn forget_token(&self) -> Result<Option<String>, String> {
        let mut cache = self.token.lock().await;
        let previous = if cache.loaded {
            cache.token.take()
        } else {
            None
        };
        let (service, account) = (self.service.clone(), self.origin.as_str().to_string());
        let stored = blocking(move || {
            let t = secure_store::get(&service, &account).ok().flatten();
            secure_store::delete(&service, &account).map(|_| t)
        })
        .await?;
        cache.token = None;
        cache.loaded = true;
        Ok(previous.or(stored))
    }

    /// Register a new sign-in attempt, cancelling any previous one (e.g. the
    /// user closed the browser tab and pressed Sign in again).
    pub fn begin_sign_in(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if let Some(prev) = self.sign_in_cancel.lock().unwrap().replace(tx) {
            let _ = prev.send(());
        }
        rx
    }

    /// Mint the single-use grant handed to the Server settings dialog.
    pub fn mint_settings_grant(&self) -> String {
        let g = random_token();
        *self.settings_grant.lock().unwrap() = Some((g.clone(), Instant::now()));
        g
    }

    /// Consume the grant: valid once, within the TTL.
    pub fn take_settings_grant(&self, presented: &str) -> bool {
        let mut slot = self.settings_grant.lock().unwrap();
        match slot.as_ref() {
            Some((g, at)) if at.elapsed() < SETTINGS_GRANT_TTL && ct_eq(g, presented) => {
                *slot = None;
                true
            }
            _ => false,
        }
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, secure_store::StoreError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AppState {
        AppState::new(
            ServerOrigin::parse("https://prism.example.com").unwrap(),
            "test".into(),
            None,
        )
    }

    #[test]
    fn settings_grant_is_single_use() {
        let s = state();
        assert!(!s.take_settings_grant(""), "no grant minted");
        let g = s.mint_settings_grant();
        assert!(!s.take_settings_grant("wrong"));
        assert!(s.take_settings_grant(&g));
        assert!(!s.take_settings_grant(&g), "single use");
        let g1 = s.mint_settings_grant();
        let g2 = s.mint_settings_grant();
        assert!(
            !s.take_settings_grant(&g1),
            "a newer grant replaces the older one"
        );
        assert!(s.take_settings_grant(&g2));
    }

    #[test]
    fn new_sign_in_cancels_the_previous_one() {
        let s = state();
        let mut first = s.begin_sign_in();
        let _second = s.begin_sign_in();
        assert!(
            first.try_recv().is_ok(),
            "the first attempt was told to stop"
        );
    }
}
