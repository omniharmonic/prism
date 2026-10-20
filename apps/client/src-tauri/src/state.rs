//! Process-wide client state: the server origin, the device-token cache in
//! front of the keychain, the in-flight sign-in, and the single-use grant for
//! the Server settings dialog.
//!
//! The origin is fixed for the process on desktop (the CSP is built from it at
//! startup, so changing it restarts the app). On iOS a process can't restart
//! itself, so the origin may be unset (first run: "Enter your server") and is
//! set or cleared in place; the main webview's CSP and origin meta follow it on
//! the next page load (window.rs `on_web_resource_request`).

use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
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
    origin: RwLock<Option<ServerOrigin>>,
    /// Keychain service name = the app identifier.
    service: String,
    pub settings_dir: Option<PathBuf>,
    token: tokio::sync::Mutex<TokenCache>,
    sign_in_cancel: Mutex<Option<oneshot::Sender<()>>>,
    settings_grant: Mutex<Option<(String, Instant)>>,
}

impl AppState {
    pub fn new(
        origin: Option<ServerOrigin>,
        service: String,
        settings_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            origin: RwLock::new(origin),
            service,
            settings_dir,
            token: Default::default(),
            sign_in_cancel: Mutex::new(None),
            settings_grant: Mutex::new(None),
        }
    }

    /// The configured server, or None before the iOS first-run screen saved one.
    pub fn origin(&self) -> Option<ServerOrigin> {
        self.origin
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The configured server, or the error every server-bound command returns
    /// while none is set.
    pub fn require_origin(&self) -> Result<ServerOrigin, String> {
        self.origin()
            .ok_or_else(|| "No Prism Server is set up yet.".to_string())
    }

    /// Point the client at another server (or none). The token cache is reset,
    /// so the next `token()` reads the keychain item of the NEW origin (each
    /// origin has its own item). Mobile only: desktop restarts instead.
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub async fn set_origin(&self, origin: Option<ServerOrigin>) {
        let mut cache = self.token.lock().await;
        *self.origin.write().unwrap_or_else(|e| e.into_inner()) = origin;
        cache.token = None;
        cache.loaded = false;
    }

    /// The device token for this origin. The keychain is read once per
    /// process; after that the in-memory copy serves every request (getToken is
    /// called per fetch).
    pub async fn token(&self) -> Result<Option<String>, String> {
        let mut cache = self.token.lock().await;
        if !cache.loaded {
            let Some(origin) = self.origin() else {
                return Ok(None);
            };
            let (service, account) = (self.service.clone(), origin.as_str().to_string());
            let t = blocking(move || secure_store::get(&service, &account)).await?;
            cache.token = t;
            cache.loaded = true;
        }
        Ok(cache.token.clone())
    }

    pub async fn store_token(&self, token: String) -> Result<(), String> {
        let mut cache = self.token.lock().await;
        let origin = self.require_origin()?;
        let (service, account, t) = (
            self.service.clone(),
            origin.as_str().to_string(),
            token.clone(),
        );
        blocking(move || secure_store::set(&service, &account, &t)).await?;
        cache.token = Some(token);
        cache.loaded = true;
        Ok(())
    }

    /// The token to revoke on sign-out: the in-memory copy, else whatever the
    /// keychain holds. Best effort: a keychain error yields `None`, never an
    /// early return, so sign-out still proceeds.
    pub async fn known_token(&self) -> Option<String> {
        let cache = self.token.lock().await;
        if cache.loaded {
            if let Some(t) = &cache.token {
                return Some(t.clone());
            }
        }
        drop(cache);
        let origin = self.origin()?;
        let (service, account) = (self.service.clone(), origin.as_str().to_string());
        blocking(move || secure_store::get(&service, &account))
            .await
            .ok()
            .flatten()
    }

    /// Forget the token: memory first (so this process stops sending it no
    /// matter what), then the keychain. A keychain failure is returned so the
    /// UI can report it; the in-memory copy is gone either way.
    pub async fn forget_token(&self) -> Result<(), String> {
        let mut cache = self.token.lock().await;
        cache.token = None;
        cache.loaded = true;
        let Some(origin) = self.origin() else {
            return Ok(());
        };
        let (service, account) = (self.service.clone(), origin.as_str().to_string());
        blocking(move || secure_store::delete(&service, &account)).await
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

    /// Consume the grant. ANY presentation uses it up (right or wrong), so it
    /// can be tried once; valid only within the TTL.
    pub fn take_settings_grant(&self, presented: &str) -> bool {
        let taken = self.settings_grant.lock().unwrap().take();
        matches!(taken, Some((g, at)) if at.elapsed() < SETTINGS_GRANT_TTL && ct_eq(&g, presented))
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
            Some(ServerOrigin::parse("https://prism.example.com").unwrap()),
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
        assert!(!s.take_settings_grant(&g), "a wrong guess burns the grant");
        let g = s.mint_settings_grant();
        assert!(s.take_settings_grant(&g));
        assert!(!s.take_settings_grant(&g), "single use");
        let g1 = s.mint_settings_grant();
        let g2 = s.mint_settings_grant();
        assert!(
            !s.take_settings_grant(&g1),
            "a newer grant replaces the older one"
        );
        assert!(!s.take_settings_grant(&g2), "and the failed try burned it");
        let g3 = s.mint_settings_grant();
        assert!(s.take_settings_grant(&g3));
    }

    #[tokio::test]
    async fn unconfigured_origin_has_no_token_and_refuses_to_store() {
        let s = AppState::new(None, "test".into(), None);
        assert_eq!(s.origin(), None);
        assert!(s.require_origin().is_err());
        assert_eq!(
            s.token().await,
            Ok(None),
            "no server = signed out, no keychain read"
        );
        assert!(s.store_token("pd_x".into()).await.is_err());
        assert_eq!(s.known_token().await, None);
        assert_eq!(s.forget_token().await, Ok(()));
    }

    #[tokio::test]
    async fn set_origin_resets_the_token_cache() {
        let s = AppState::new(None, "test".into(), None);
        // Prime the cache as "loaded, no token" for the unconfigured state.
        {
            let mut c = s.token.lock().await;
            c.loaded = true;
            c.token = Some("pd_old-server".into());
        }
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        s.set_origin(Some(o.clone())).await;
        assert_eq!(s.origin(), Some(o));
        let c = s.token.lock().await;
        assert!(
            !c.loaded && c.token.is_none(),
            "the old server's token is never served for the new one"
        );
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
