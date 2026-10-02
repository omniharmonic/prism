# Settings presentation follow-up

2026-10-02 · source `6e05bc9` · D07 / A01 / original board15.

Desktop settings now uses a quiet navigation rail and a readable preference pane; phone sections scroll horizontally and the pane remains independently scrollable. Device appearance scope is stated explicitly. Existing account/services/source gates, injected clients, native config writes and all preference fields remain unchanged. Font controls and sidebar label have accessible names; theme buttons expose selection.

38 combined Chromium/WebKit settings/workspace journeys passed. Final6 focused journeys passed after adding explicit surface text color and settled-theme contrast checks. Screenshot capture now waits for the selected theme's colors and disables transitions, avoiding a mixed-theme intermediate frame. The checks exercise Services/Appearance navigation, all three viewports, font/sidebar persistence across tab changes and reload, dark/light switching, contrast, modal Escape and no horizontal overflow. Core and fixture typechecks passed.

Reviewed fictional renders: [desktop](settings-1440-chromium.png), [390px](settings-390-chromium.png), [320px dark WebKit](settings-320-webkit.png). This is no proof of production/native settings, real IME, account mutations or server configuration writes. Broader integration controls remain a separate D07 slice.
