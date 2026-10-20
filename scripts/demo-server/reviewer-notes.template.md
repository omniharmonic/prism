# App Review notes — TEMPLATE (no secrets)

Paste into App Store Connect → the version → **App Review Information**. Put the account in the
**Sign-in required** fields (User name / Password) — the password is the one `reset.sh` printed;
it is never written into this file, a note, a commit or a chat. Replace `<DEMO_HOST>`.

---

Prism Workspace is the iPhone and iPad app for a self-hosted Prism Server (a workspace for pages,
databases, comments and tasks). The app has no content of its own: on first launch it asks for
the address of a Prism Server. For review we run a demo server with made-up sample content.

How to sign in:
1. Launch the app. On "Enter your server", enter: https://<DEMO_HOST> and tap Continue.
2. On "Sign in to Prism", tap "Sign in". A secure sign-in sheet opens (the server's own web page).
3. Enter the user name and password from the "Sign-in required" fields and sign in.
4. The sheet asks "Allow an app to sign in as you?". Tap "Approve".
5. The workspace opens. The "Welcome to the Prism demo" page lists things to try.

What to look at: open and edit "A living workspace"; add a comment on selected text; open the
"Launch plan" database (table and board views); create a page with "New page"; search.

Account deletion (guideline 5.1.1(v)): Settings → Account → "Delete account". It asks for the
password and deletes the account on the server. The demo server is reset afterwards; please
let us know if you need a new account during review.

Notifications: the demo server does not send push notifications, so the notification setting
can be turned on but nothing arrives. The camera and microphone are used only when you choose
to take a photo or video to attach to a page.

Contact: <owner contact for App Review>
