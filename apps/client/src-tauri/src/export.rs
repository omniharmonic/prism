//! "Export note…" (WP4.2): Markdown or HTML to a file the USER picks.
//!
//! The page supplies content, a suggested name and a format. It NEVER supplies
//! a path: the destination comes only from the native save panel (which the
//! page can't drive or answer), and Rust writes to exactly that path. There is
//! no fs permission for JS and no command that takes a path. A compromised page
//! can at worst pop a save dialog that the user can cancel.

use std::path::{Path, PathBuf};

/// Largest export accepted from the page.
pub const MAX_EXPORT_BYTES: usize = 20_000_000;
const MAX_STEM_CHARS: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Html,
}

impl Format {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "markdown" | "md" => Ok(Self::Markdown),
            "html" => Ok(Self::Html),
            _ => Err("Unknown export format.".into()),
        }
    }
    pub fn ext(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Html => "html",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Markdown => "Markdown",
            Self::Html => "HTML",
        }
    }
}

/// A safe file stem from a page-suggested name: no path separators or
/// reserved characters, no control characters, no leading dots, no known
/// extension doubled up, bounded, never empty.
pub fn sanitize_stem(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    s = s.trim().to_string();
    for ext in [".md", ".markdown", ".html", ".htm", ".txt"] {
        if s.to_ascii_lowercase().ends_with(ext) {
            s.truncate(s.len() - ext.len());
        }
    }
    let s = s.trim_matches(|c: char| c == '.' || c == '-' || c.is_whitespace());
    let s: String = s.chars().take(MAX_STEM_CHARS).collect();
    let s = s.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if s.is_empty() {
        "note".into()
    } else {
        s.to_string()
    }
}

/// The name pre-filled in the save panel.
pub fn suggested_file_name(name: &str, fmt: Format) -> String {
    format!("{}.{}", sanitize_stem(name), fmt.ext())
}

/// The path to write: exactly what the user chose, with our extension added
/// only when they left it off. Directories are refused by the caller.
pub fn target_path(chosen: &Path, fmt: Format) -> PathBuf {
    if chosen.extension().is_some() {
        chosen.to_path_buf()
    } else {
        let mut os = chosen.as_os_str().to_owned();
        os.push(".");
        os.push(fmt.ext());
        PathBuf::from(os)
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The bytes written. Markdown is the content as given (the page converts).
/// HTML is wrapped in a standalone document whose CSP forbids script and
/// network loads except images, so a note that carries markup can't run code
/// when the exported file is opened in a browser.
pub fn render(fmt: Format, title: &str, content: &str) -> String {
    match fmt {
        Format::Markdown => content.to_string(),
        Format::Html => format!(
            "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
             <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: https:; style-src 'unsafe-inline'\">\n\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
             <title>{}</title>\n\
             <style>body{{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}}img{{max-width:100%}}pre{{overflow:auto}}</style>\n\
             </head>\n<body>\n{}\n</body>\n</html>\n",
            escape_html(&sanitize_stem(title)),
            content
        ),
    }
}

pub fn check_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_EXPORT_BYTES {
        Err("This note is too large to export.".into())
    } else {
        Ok(())
    }
}

/// Show the native save panel (main thread) and return the chosen path.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn choose_path_blocking(file_name: &str, fmt: Format) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("Export note")
        .set_file_name(file_name)
        .add_filter(fmt.label(), &[fmt.ext()])
        .save_file()
}

/// Write to the user-chosen path. Refuses a directory.
pub fn write_chosen(path: &Path, fmt: Format, bytes: &str) -> Result<PathBuf, String> {
    let target = target_path(path, fmt);
    if path.is_dir() || target.is_dir() {
        return Err("That location is a folder.".into());
    }
    std::fs::write(&target, bytes).map_err(|e| format!("could not write the file: {e}"))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_cannot_carry_paths() {
        assert_eq!(sanitize_stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_stem("C:\\Windows\\x"), "C--Windows-x");
        assert_eq!(sanitize_stem("/abs/olute"), "abs-olute");
        assert_eq!(sanitize_stem(".hidden"), "hidden");
        assert_eq!(sanitize_stem("a\u{0}b\nc"), "a-b-c");
        assert_eq!(sanitize_stem(""), "note");
        assert_eq!(sanitize_stem("   "), "note");
        assert_eq!(sanitize_stem("..."), "note");
        assert_eq!(sanitize_stem("Meeting notes.md"), "Meeting notes");
        assert_eq!(sanitize_stem("Plan.HTML"), "Plan");
        assert_eq!(
            sanitize_stem(&"x".repeat(500)).chars().count(),
            MAX_STEM_CHARS
        );
        for evil in ["a/b", "a\\b", "..", "a\u{0}", "~/x"] {
            let s = suggested_file_name(evil, Format::Markdown);
            assert!(
                !s.contains('/') && !s.contains('\\') && !s.starts_with('.'),
                "{s}"
            );
        }
        assert_eq!(suggested_file_name("Trip", Format::Html), "Trip.html");
    }

    #[test]
    fn target_path_is_exactly_what_the_user_chose() {
        let p = Path::new("/Users/me/Desktop/out");
        assert_eq!(
            target_path(p, Format::Markdown),
            PathBuf::from("/Users/me/Desktop/out.md")
        );
        let p = Path::new("/Users/me/Desktop/out.txt");
        assert_eq!(
            target_path(p, Format::Markdown),
            p,
            "an explicit extension is respected"
        );
        let p = Path::new("/Users/me/.ssh/config");
        // The page never influences this; only the dialog result does.
        assert_eq!(
            target_path(p, Format::Html),
            PathBuf::from("/Users/me/.ssh/config.html")
        );
    }

    #[test]
    fn export_surface_takes_no_path_from_the_page() {
        // The IPC command's parameter list is the page-controlled surface.
        let src = include_str!("native_cmds.rs");
        let sig_start = src
            .find("pub async fn export_note")
            .expect("export_note exists");
        let sig = &src[sig_start
            ..src[sig_start..]
                .find(") ->")
                .map(|i| sig_start + i)
                .unwrap()];
        assert!(
            !sig.to_lowercase().contains("path"),
            "export_note must not take a path: {sig}"
        );
        assert!(!sig.contains("PathBuf"));
    }

    #[test]
    fn html_is_wrapped_with_a_script_blocking_csp_and_escaped_title() {
        let h = render(Format::Html, "<script>x</script>", "<p>hi</p>");
        assert!(h.starts_with("<!doctype html>"));
        assert!(h.contains("default-src 'none'"));
        assert!(!h.contains("<title><script>"));
        assert!(h.contains("<p>hi</p>"));
        assert_eq!(render(Format::Markdown, "t", "# a"), "# a");
    }

    #[test]
    fn size_cap_and_format_parsing() {
        assert!(check_size(&"a".repeat(MAX_EXPORT_BYTES)).is_ok());
        assert!(check_size(&"a".repeat(MAX_EXPORT_BYTES + 1)).is_err());
        assert_eq!(Format::parse("markdown"), Ok(Format::Markdown));
        assert_eq!(Format::parse("html"), Ok(Format::Html));
        assert!(Format::parse("pdf").is_err());
        assert!(Format::parse("../x").is_err());
    }

    #[test]
    fn writes_only_to_the_chosen_file_and_refuses_folders() {
        let dir = std::env::temp_dir().join(format!("prism-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = write_chosen(&dir.join("n"), Format::Markdown, "# hi").unwrap();
        assert_eq!(out, dir.join("n.md"));
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "# hi");
        assert!(
            write_chosen(&dir, Format::Markdown, "x").is_err(),
            "a folder"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
