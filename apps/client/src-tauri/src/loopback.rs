//! RFC 8252 §7.3 loopback redirect receiver (desktop only).
//!
//! Binds `127.0.0.1:<random port>` (the OS picks an ephemeral port, always
//! ≥1024 as the server requires), and waits for exactly one valid
//! `GET /callback?code=…&state=…`. Anything else (a favicon request, a wrong
//! path, a forged/mismatched `state`) gets a 4xx and does NOT end the wait, so
//! a local process can't kill a real sign-in by racing a bogus request. The
//! first callback carrying our `state` ends it (single shot) and the socket is
//! closed. The whole wait has a deadline and can be cancelled.

use std::time::Duration;

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use tokio::sync::{mpsc, oneshot, Semaphore};

use crate::pkce::{parse_callback_query, CallbackOutcome};

/// Path registered as `http://127.0.0.1:<port>/callback`.
pub const CALLBACK_PATH: &str = "/callback";
/// Max bytes read from one request (request line + headers).
const MAX_REQUEST: usize = 8 * 1024;
/// A single local connection gets this long to send its request.
const PER_CONNECTION: Duration = Duration::from_secs(2);
/// At most this many connections are served at once; extra ones are dropped.
/// Each is its own task, so a slow or idle local connection can never hold up
/// the browser's callback.
const MAX_CONCURRENT: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum LoopbackError {
    Bind(String),
    TimedOut,
    Cancelled,
    Denied(String),
    Malformed,
}

impl std::fmt::Display for LoopbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bind(e) => write!(f, "could not open the sign-in listener: {e}"),
            Self::TimedOut => write!(f, "sign-in timed out; please try again"),
            Self::Cancelled => write!(f, "sign-in was cancelled"),
            Self::Denied(e) if e == "access_denied" => {
                write!(f, "sign-in was denied in the browser")
            }
            Self::Denied(e) => write!(f, "sign-in failed ({e})"),
            Self::Malformed => write!(f, "the sign-in response was malformed"),
        }
    }
}

pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl LoopbackListener {
    /// Bind 127.0.0.1 on an OS-assigned port.
    pub async fn bind() -> Result<Self, LoopbackError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| LoopbackError::Bind(e.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|e| LoopbackError::Bind(e.to_string()))?
            .port();
        if port < 1024 {
            // Never happens with ephemeral ports; the server would refuse it anyway.
            return Err(LoopbackError::Bind(format!("unexpected low port {port}")));
        }
        Ok(Self { listener, port })
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Exactly the redirect URI the server's loopback allowlist accepts.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, CALLBACK_PATH)
    }

    /// Wait for the one callback carrying `expected_state`. Consumes the
    /// listener: whatever the result, the port is closed afterwards.
    pub async fn wait_for_code(
        self,
        expected_state: &str,
        timeout: Duration,
        cancel: oneshot::Receiver<()>,
    ) -> Result<String, LoopbackError> {
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        tokio::pin!(cancel);
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT));
        let (done_tx, mut done_rx) = mpsc::channel::<Result<String, LoopbackError>>(MAX_CONCURRENT);
        let state: Arc<str> = Arc::from(expected_state);
        loop {
            tokio::select! {
                _ = &mut deadline => return Err(LoopbackError::TimedOut),
                _ = &mut cancel => return Err(LoopbackError::Cancelled),
                // The first connection that ends the flow wins; returning drops
                // the listener, so the port closes (single shot).
                Some(done) = done_rx.recv() => return done,
                accepted = self.listener.accept() => {
                    let Ok((stream, _peer)) = accepted else { continue };
                    let Ok(permit) = slots.clone().try_acquire_owned() else {
                        drop(stream); // over the limit: refuse, keep listening
                        continue;
                    };
                    let (tx, state) = (done_tx.clone(), state.clone());
                    tokio::spawn(async move {
                        let _permit = permit;
                        // not ours / too slow: the task just ends
                        if let Ok(Some(done)) = tokio::time::timeout(PER_CONNECTION, handle(stream, &state)).await {
                            let _ = tx.send(done).await;
                        }
                    });
                }
            }
        }
    }
}

/// Serve one connection. `Some(result)` ends the flow; `None` keeps listening.
async fn handle(
    mut stream: TcpStream,
    expected_state: &str,
) -> Option<Result<String, LoopbackError>> {
    let request_line = read_request_line(&mut stream).await?;
    let (status, page, outcome) = match classify(&request_line, expected_state) {
        Classified::NotFound => (404, Page::NotFound, None),
        Classified::Ignored => (400, Page::Ignored, None),
        Classified::Done(CallbackOutcome::Code(code)) => (200, Page::Ok, Some(Ok(code))),
        Classified::Done(CallbackOutcome::Denied(e)) => {
            (200, Page::Denied, Some(Err(LoopbackError::Denied(e))))
        }
        Classified::Done(CallbackOutcome::Malformed) => {
            (400, Page::Failed, Some(Err(LoopbackError::Malformed)))
        }
        Classified::Done(CallbackOutcome::StateMismatch) => (400, Page::Ignored, None),
    };
    let _ = write_response(&mut stream, status, &page.html()).await;
    outcome
}

/// Read up to the end of the request headers and return the request line.
async fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_REQUEST {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    text.lines().next().map(str::to_owned)
}

#[derive(Debug, PartialEq, Eq)]
enum Classified {
    /// Wrong method/path (e.g. /favicon.ico): 404, keep waiting.
    NotFound,
    /// Our path but not our state: 400, keep waiting.
    Ignored,
    Done(CallbackOutcome),
}

/// Classify a raw HTTP request line such as `GET /callback?code=x&state=y HTTP/1.1`.
fn classify(request_line: &str, expected_state: &str) -> Classified {
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Classified::NotFound;
    };
    if method != "GET" || !version.starts_with("HTTP/1.") {
        return Classified::NotFound;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Classified::NotFound;
    }
    match parse_callback_query(query, expected_state) {
        CallbackOutcome::StateMismatch => Classified::Ignored,
        other => Classified::Done(other),
    }
}

async fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

// Static pages only: nothing from the request is ever reflected back.
const STYLE: &str = "body{font:15px -apple-system,system-ui,sans-serif;background:#0a0a0b;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{max-width:420px;text-align:center}h1{font-size:20px}";

fn page(heading: &str, text: &str) -> String {
    format!("<!doctype html><meta charset=utf-8><title>Prism</title><style>{STYLE}</style><div><h1>{heading}</h1><p>{text}</p></div>")
}

#[derive(Clone, Copy)]
enum Page {
    Ok,
    Denied,
    Failed,
    Ignored,
    NotFound,
}

impl Page {
    fn html(self) -> String {
        match self {
            Page::Ok => page(
                "You're signed in",
                "You can close this tab and return to Prism.",
            ),
            Page::Denied => page(
                "Sign-in cancelled",
                "Nothing was shared with the app. You can close this tab.",
            ),
            Page::Failed => page("Sign-in failed", "Return to Prism and try again."),
            Page::Ignored => page(
                "Link not valid",
                "This sign-in link is not valid for the running app.",
            ),
            Page::NotFound => page("Not found", ""),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ST: &str = "the-state";

    #[test]
    fn classify_request_lines() {
        assert_eq!(
            classify("GET /callback?code=c1&state=the-state HTTP/1.1", ST),
            Classified::Done(CallbackOutcome::Code("c1".into()))
        );
        assert_eq!(
            classify("GET /favicon.ico HTTP/1.1", ST),
            Classified::NotFound
        );
        assert_eq!(
            classify("POST /callback?code=c1&state=the-state HTTP/1.1", ST),
            Classified::NotFound
        );
        assert_eq!(
            classify("GET /callback/x?code=c1&state=the-state HTTP/1.1", ST),
            Classified::NotFound
        );
        assert_eq!(
            classify("GET /callback?code=c1&state=other HTTP/1.1", ST),
            Classified::Ignored
        );
        assert_eq!(classify("garbage", ST), Classified::NotFound);
        assert_eq!(classify("", ST), Classified::NotFound);
        assert_eq!(
            classify(
                "GET /callback?error=access_denied&state=the-state HTTP/1.1",
                ST
            ),
            Classified::Done(CallbackOutcome::Denied("access_denied".into()))
        );
    }

    async fn get(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn binds_loopback_with_high_port() {
        let l = LoopbackListener::bind().await.unwrap();
        assert!(l.port() >= 1024);
        assert_eq!(
            l.redirect_uri(),
            format!("http://127.0.0.1:{}/callback", l.port())
        );
        assert!(l.listener.local_addr().unwrap().ip().is_loopback());
    }

    #[tokio::test]
    async fn single_shot_ignores_noise_then_closes() {
        let l = LoopbackListener::bind().await.unwrap();
        let port = l.port();
        let (_tx, rx) = oneshot::channel();
        let waiter =
            tokio::spawn(async move { l.wait_for_code(ST, Duration::from_secs(10), rx).await });

        // Noise first: none of these end the wait.
        assert!(get(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(get(port, "/callback?code=evil&state=forged")
            .await
            .starts_with("HTTP/1.1 400"));
        // The real one.
        let ok = get(port, "/callback?code=good&state=the-state").await;
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert!(
            !ok.contains("good"),
            "nothing from the request is reflected"
        );

        assert_eq!(waiter.await.unwrap(), Ok("good".to_string()));
        // Single shot: the port is closed now.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn denied_ends_the_flow() {
        let l = LoopbackListener::bind().await.unwrap();
        let port = l.port();
        let (_tx, rx) = oneshot::channel();
        let waiter =
            tokio::spawn(async move { l.wait_for_code(ST, Duration::from_secs(10), rx).await });
        get(port, "/callback?error=access_denied&state=the-state").await;
        assert_eq!(
            waiter.await.unwrap(),
            Err(LoopbackError::Denied("access_denied".into()))
        );
    }

    #[tokio::test]
    async fn times_out() {
        let l = LoopbackListener::bind().await.unwrap();
        let port = l.port();
        let (_tx, rx) = oneshot::channel();
        let r = l.wait_for_code(ST, Duration::from_millis(100), rx).await;
        assert_eq!(r, Err(LoopbackError::TimedOut));
        assert!(
            TcpStream::connect(("127.0.0.1", port)).await.is_err(),
            "closed after timeout"
        );
    }

    #[tokio::test]
    async fn cancellable() {
        let l = LoopbackListener::bind().await.unwrap();
        let (tx, rx) = oneshot::channel();
        let waiter =
            tokio::spawn(async move { l.wait_for_code(ST, Duration::from_secs(10), rx).await });
        tx.send(()).unwrap();
        assert_eq!(waiter.await.unwrap(), Err(LoopbackError::Cancelled));
    }

    #[tokio::test]
    async fn slow_connection_does_not_block_the_real_callback() {
        let l = LoopbackListener::bind().await.unwrap();
        let port = l.port();
        let (_tx, rx) = oneshot::channel();
        let waiter =
            tokio::spawn(async move { l.wait_for_code(ST, Duration::from_secs(30), rx).await });
        // Open a connection and send nothing; it is dropped after PER_CONNECTION.
        let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        drop(_idle); // closed immediately: read returns 0 -> ignored
        let ok = get(port, "/callback?code=c&state=the-state").await;
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert_eq!(waiter.await.unwrap(), Ok("c".to_string()));
    }

    #[tokio::test]
    async fn idle_connections_do_not_delay_the_callback() {
        let l = LoopbackListener::bind().await.unwrap();
        let port = l.port();
        let (_tx, rx) = oneshot::channel();
        let waiter =
            tokio::spawn(async move { l.wait_for_code(ST, Duration::from_secs(30), rx).await });
        // A local process opens several connections and sends nothing / half a request.
        let mut idle = Vec::new();
        for i in 0..5 {
            let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            if i % 2 == 0 {
                c.write_all(b"GET /callback?code=").await.unwrap();
            }
            idle.push(c);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = std::time::Instant::now();
        let ok = get(port, "/callback?code=real&state=the-state").await;
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert_eq!(waiter.await.unwrap(), Ok("real".to_string()));
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "served without waiting on idle sockets"
        );
        drop(idle);
    }
}
