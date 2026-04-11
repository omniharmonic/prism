use crate::error::PrismError;

#[tauri::command]
pub fn markdown_to_html(markdown: String) -> Result<String, PrismError> {
    let parser = pulldown_cmark::Parser::new_ext(&markdown, pulldown_cmark::Options::all());
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    Ok(html)
}

#[tauri::command]
pub fn html_to_markdown(html: String) -> Result<String, PrismError> {
    Ok(htmd::convert(&html).unwrap_or_default())
}
