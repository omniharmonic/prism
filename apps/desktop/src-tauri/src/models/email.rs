use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GmailThread {
    pub id: String,
    pub subject: String,
    pub snippet: String,
    pub messages: Vec<GmailMessage>,
    pub unread: bool,
    pub labels: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub subject: String,
    pub body: String,
    pub date: String,
    pub is_unread: bool,
    pub in_reply_to: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GmailThreadList {
    pub threads: Vec<GmailThreadSummary>,
    pub next_page_token: Option<String>,
    pub result_size_estimate: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GmailThreadSummary {
    pub id: String,
    pub subject: String,
    pub snippet: String,
    pub from: String,
    pub from_name: Option<String>,
    pub date: String,
    pub unread: bool,
    pub message_count: u32,
    pub labels: Vec<String>,
}
