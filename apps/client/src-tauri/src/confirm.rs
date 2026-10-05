//! Native confirmation dialogs. Page script cannot draw, dismiss or reword them,
//! so they are what stands between a compromised page and an action the user
//! did not intend (opening a URL, repointing the app at another server).
//!
//! macOS: an app-modal `NSAlert` on the main thread. iOS: a `UIAlertController`
//! (plugins/prism-ios). Any other platform, or any failure to show the dialog,
//! answers **no**.

use tauri::{AppHandle, Runtime};

pub struct Prompt {
    pub title: String,
    pub body: String,
    /// Label of the button that means "yes".
    pub confirm: String,
    /// Make Cancel the default (Return) button.
    pub cancel_is_default: bool,
}

/// Ask the user; `true` only on an explicit click on the confirm button.
#[cfg(target_os = "ios")]
pub async fn ask<R: Runtime>(app: &AppHandle<R>, prompt: Prompt) -> bool {
    let Ok(ios) = crate::ios::plugin(app) else {
        return false;
    };
    // A sign-out / server change is destructive; opening a link is not.
    let destructive = prompt.cancel_is_default;
    ios.confirm(tauri_plugin_prism_ios::ConfirmArgs {
        title: &prompt.title,
        message: &prompt.body,
        confirm: &prompt.confirm,
        cancel_is_default: prompt.cancel_is_default,
        destructive,
    })
    .await
}

/// Ask the user; `true` only on an explicit click on the confirm button.
#[cfg(not(target_os = "ios"))]
pub async fn ask<R: Runtime>(app: &AppHandle<R>, prompt: Prompt) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let scheduled = app.run_on_main_thread(move || {
        let _ = tx.send(show(&prompt));
    });
    if scheduled.is_err() {
        return false;
    }
    rx.await.unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn show(p: &Prompt) -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(&p.title));
    alert.setInformativeText(&NSString::from_str(&p.body));
    // The first button added is the default (Return key).
    let (first, second) = if p.cancel_is_default {
        ("Cancel", p.confirm.as_str())
    } else {
        (p.confirm.as_str(), "Cancel")
    };
    alert.addButtonWithTitle(&NSString::from_str(first));
    alert.addButtonWithTitle(&NSString::from_str(second));
    let answer = alert.runModal();
    if p.cancel_is_default {
        answer == NSAlertSecondButtonReturn
    } else {
        answer == NSAlertFirstButtonReturn
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn show(_p: &Prompt) -> bool {
    false
}

/// Shorten a URL for display in a dialog without hiding where it goes: the
/// scheme + host are always shown in full, the rest is cut with an ellipsis.
pub fn display_url(url: &str) -> String {
    const MAX: usize = 300;
    if url.chars().count() <= MAX {
        return url.to_string();
    }
    let cut: String = url.chars().take(MAX).collect();
    format!("{cut}… ({} characters)", url.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_urls_are_shortened_but_keep_their_host() {
        assert_eq!(
            display_url("https://example.com/a"),
            "https://example.com/a"
        );
        let long = format!("https://example.com/?q={}", "x".repeat(1000));
        let d = display_url(&long);
        assert!(d.starts_with("https://example.com/?q="));
        assert!(d.ends_with(&format!("({} characters)", long.len())));
    }
}
