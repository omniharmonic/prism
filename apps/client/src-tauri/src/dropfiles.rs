//! Drag-and-drop of files onto the main window (WP4.2).
//!
//! DESIGN DECISION: the shell reads the dropped text files (only what the OS
//! drop event names, with hard caps) and hands the CONTENT to the page as a DOM
//! event; the page then creates the notes through its ordinary gateway client.
//! The alternative, creating them from Rust with the device token, was
//! rejected:
//!  - it would give the shell a second note writer that ignores the active
//!    vault (`X-Prism-Vault`), the offline outbox and cache invalidation;
//!  - the page already holds write access to the vault through its own token
//!    path, so routing a user-dropped file's TEXT through it adds no authority;
//!  - what must stay in Rust is the privileged part, reading local files. The
//!    page cannot make the shell read a path: paths exist only inside the OS
//!    drop event (`WindowEvent::DragDrop`), never as a command argument, and
//!    there is no fs permission for JS.
//!
//! Non-text files are never read at all (only their names are reported).
//! Binaries are not uploaded in this WP.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub const MAX_FILES: usize = 10;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DroppedNote {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct DropOutcome {
    pub notes: Vec<DroppedNote>,
    pub skipped: Vec<Skipped>,
}

pub const REASON_ATTACHMENT: &str = "Attachments aren't supported yet.";

/// `.md` / `.markdown` / `.txt` (any case) are notes; everything else is not.
pub fn is_text_note(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".markdown", ".txt"]
        .iter()
        .any(|e| lower.ends_with(e))
}

fn display_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

fn skip(out: &mut DropOutcome, name: String, reason: &str) {
    out.skipped.push(Skipped {
        name,
        reason: reason.into(),
    });
}

/// Read at most `cap` + 1 bytes (so a lying size or a special file can't make
/// us read more), then require UTF-8.
fn read_bounded(path: &Path, cap: u64) -> Result<String, &'static str> {
    let file = std::fs::File::open(path).map_err(|_| "Couldn't read this file.")?;
    let mut buf = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(|_| "Couldn't read this file.")?;
    if buf.len() as u64 > cap {
        return Err("Too large (1 MB max per file).");
    }
    let text = String::from_utf8(buf).map_err(|_| "Not a UTF-8 text file.")?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Filter + read a drop. Order is the drop order; the caps apply in that order.
pub fn process(paths: &[PathBuf]) -> DropOutcome {
    let mut out = DropOutcome::default();
    let mut total: u64 = 0;
    for (i, path) in paths.iter().enumerate() {
        let name = display_name(path);
        if i >= MAX_FILES {
            skip(&mut out, name, "Too many files at once (10 max).");
            continue;
        }
        let Ok(meta) = std::fs::metadata(path) else {
            skip(&mut out, name, "Couldn't read this file.");
            continue;
        };
        if meta.is_dir() {
            skip(&mut out, name, "Folders aren't supported.");
            continue;
        }
        if !meta.is_file() {
            skip(&mut out, name, REASON_ATTACHMENT);
            continue;
        }
        if !is_text_note(&name) {
            skip(&mut out, name, REASON_ATTACHMENT);
            continue;
        }
        if meta.len() > MAX_FILE_BYTES {
            skip(&mut out, name, "Too large (1 MB max per file).");
            continue;
        }
        if total + meta.len() > MAX_TOTAL_BYTES {
            skip(&mut out, name, "This drop is too large (4 MB total).");
            continue;
        }
        match read_bounded(path, MAX_FILE_BYTES) {
            Ok(content) => {
                total += content.len() as u64;
                out.notes.push(DroppedNote { name, content });
            }
            Err(reason) => skip(&mut out, name, reason),
        }
    }
    out
}

/// JS that delivers the outcome to the page as a DOM event.
pub fn deliver_js(outcome: &DropOutcome) -> String {
    let json = serde_json::to_string(outcome).expect("outcome serializes");
    format!("window.dispatchEvent(new CustomEvent(\"prism:files-dropped\",{{detail:{json}}}));")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("prism-drop-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn type_filter() {
        assert!(is_text_note("a.md"));
        assert!(is_text_note("A.MARKDOWN"));
        assert!(is_text_note("notes.txt"));
        for n in ["a.png", "a.pdf", "a.md.exe", "a.mdx", "txt", "a.docx", "a"] {
            assert!(!is_text_note(n), "{n}");
        }
    }

    #[test]
    fn reads_text_and_reports_the_rest() {
        let d = tmp("mix");
        std::fs::write(d.join("a.md"), "\u{feff}# Hello").unwrap();
        std::fs::write(d.join("b.txt"), "plain").unwrap();
        std::fs::write(d.join("c.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(d.join("d.md"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::create_dir_all(d.join("folder.md")).unwrap();
        let o = process(&[
            d.join("a.md"),
            d.join("b.txt"),
            d.join("c.png"),
            d.join("d.md"),
            d.join("folder.md"),
            d.join("missing.md"),
        ]);
        assert_eq!(
            o.notes,
            vec![
                DroppedNote {
                    name: "a.md".into(),
                    content: "# Hello".into()
                },
                DroppedNote {
                    name: "b.txt".into(),
                    content: "plain".into()
                },
            ]
        );
        let why = |n: &str| {
            o.skipped
                .iter()
                .find(|s| s.name == n)
                .unwrap()
                .reason
                .clone()
        };
        assert_eq!(why("c.png"), REASON_ATTACHMENT);
        assert_eq!(why("d.md"), "Not a UTF-8 text file.");
        assert_eq!(why("folder.md"), "Folders aren't supported.");
        assert_eq!(why("missing.md"), "Couldn't read this file.");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn size_and_count_caps() {
        let d = tmp("caps");
        std::fs::write(d.join("big.md"), vec![b'a'; MAX_FILE_BYTES as usize + 1]).unwrap();
        std::fs::write(d.join("ok.md"), vec![b'a'; MAX_FILE_BYTES as usize]).unwrap();
        let o = process(&[d.join("big.md"), d.join("ok.md")]);
        assert_eq!(o.notes.len(), 1);
        assert_eq!(o.notes[0].name, "ok.md");
        assert!(o.skipped[0].reason.starts_with("Too large"));

        // Total cap: 4 x 1 MiB fits (4 MiB), the fifth is refused.
        let paths: Vec<PathBuf> = (0..6)
            .map(|i| {
                let p = d.join(format!("f{i}.txt"));
                std::fs::write(&p, vec![b'a'; MAX_FILE_BYTES as usize]).unwrap();
                p
            })
            .collect();
        let o = process(&paths);
        assert_eq!(o.notes.len(), 4);
        assert!(o.skipped.iter().all(|s| s.reason.contains("4 MB total")));

        // Count cap: files past the 10th are skipped without being read.
        let many: Vec<PathBuf> = (0..12)
            .map(|i| {
                let p = d.join(format!("n{i}.md"));
                std::fs::write(&p, "x").unwrap();
                p
            })
            .collect();
        let o = process(&many);
        assert_eq!(o.notes.len(), MAX_FILES);
        assert_eq!(o.skipped.len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn names_are_cleaned_and_delivery_is_json() {
        assert_eq!(display_name(Path::new("/x/y/a\nb.md")), "a b.md");
        let o = DropOutcome {
            notes: vec![DroppedNote {
                name: "a\"</script>.md".into(),
                content: "x\u{2028}y".into(),
            }],
            skipped: vec![],
        };
        let js = deliver_js(&o);
        assert!(js.starts_with("window.dispatchEvent(new CustomEvent(\"prism:files-dropped\""));
        assert!(js.contains(r#"a\"</script>.md"#));
    }
}
