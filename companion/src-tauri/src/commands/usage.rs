use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

#[derive(Serialize, Clone)]
pub struct UsageSection {
    pub name: String,
    pub percent: u32,
    pub reset_text: String,
}

#[derive(Serialize)]
pub struct UsageResult {
    pub plan_name: String,
    pub sections: Vec<UsageSection>,
}

#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OAuthCreds,
}

#[derive(Deserialize, Clone)]
struct OAuthCreds {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    #[serde(rename = "subscriptionType", default)]
    subscription_type: Option<String>,
    #[serde(rename = "expiresAt", default)]
    expires_at: Option<i64>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

fn credentials_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    Ok(home.join(".claude").join(".credentials.json"))
}

async fn read_credentials() -> Result<(OAuthCreds, String), String> {
    let path = credentials_path()?;
    if !path.exists() {
        return Err("No credentials found. Run \"claude auth\" first.".into());
    }
    let data = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read credentials: {}", e))?;
    let creds: Credentials =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse credentials: {}", e))?;
    let sub = creds
        .claude_ai_oauth
        .subscription_type
        .clone()
        .unwrap_or_else(|| "unknown".into());
    Ok((creds.claude_ai_oauth, sub))
}

async fn refresh_token(refresh_token: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
    });

    let resp = client
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Token refresh failed ({}). Run \"claude auth\".",
            resp.status().as_u16()
        ));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

async fn update_credentials_file(tokens: &TokenResponse) -> Result<(), String> {
    let path = credentials_path()?;
    let data = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read credentials: {}", e))?;

    let mut value: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse credentials: {}", e))?;

    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(oauth) = value.get_mut("claudeAiOauth") {
        oauth["accessToken"] = serde_json::Value::String(tokens.access_token.clone());
        oauth["refreshToken"] = serde_json::Value::String(tokens.refresh_token.clone());
        oauth["expiresAt"] = serde_json::Value::Number(
            serde_json::Number::from(now_ms + tokens.expires_in * 1000),
        );
    }

    tokio::fs::write(&path, serde_json::to_string(&value).unwrap())
        .await
        .map_err(|e| format!("Failed to write credentials: {}", e))?;

    Ok(())
}

async fn get_access_token() -> Result<(String, String), String> {
    let (creds, sub) = read_credentials().await?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    if let Some(expires_at) = creds.expires_at {
        if expires_at > 0 && now_ms > expires_at - 60_000 {
            let tokens = refresh_token(&creds.refresh_token).await?;
            let access = tokens.access_token.clone();
            update_credentials_file(&tokens).await?;
            return Ok((access, sub));
        }
    }

    Ok((creds.access_token, sub))
}

async fn fetch_usage_api(access_token: &str) -> Result<Option<serde_json::Value>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(USAGE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.0.32")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Usage API request failed: {}", e))?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("Usage API error ({})", status));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse usage response: {}", e))?;
    Ok(Some(body))
}

fn format_reset_time(resets_at: &str) -> String {
    let reset = match chrono::DateTime::parse_from_rfc3339(resets_at) {
        Ok(dt) => dt.with_timezone(&chrono::Utc),
        Err(_) => return String::new(),
    };
    let now = chrono::Utc::now();
    let diff = reset - now;
    if diff <= chrono::Duration::zero() {
        return "now".into();
    }
    let total_mins = diff.num_minutes();
    let hours = total_mins / 60;
    let mins = total_mins % 60;
    if hours > 0 {
        format!("in {}h {}m", hours, mins)
    } else {
        format!("in {}m", mins)
    }
}

fn transform_usage_data(raw: &serde_json::Value, subscription_type: &str) -> UsageResult {
    let plan_name = {
        let mut chars = subscription_type.chars();
        match chars.next() {
            Some(c) => format!("{}{} Plan", c.to_uppercase(), chars.as_str()),
            None => "Unknown Plan".into(),
        }
    };

    let section_defs = [
        ("five_hour", "Current session"),
        ("seven_day", "All models"),
        ("seven_day_opus", "Opus only"),
        ("seven_day_sonnet", "Sonnet only"),
    ];

    let mut sections = Vec::new();
    for (prop, name) in &section_defs {
        if let Some(el) = raw.get(prop) {
            if el.is_object() {
                let pct = el
                    .get("utilization")
                    .and_then(|u| u.as_f64())
                    .map(|u| u.round() as u32)
                    .unwrap_or(0);
                let reset_text = el
                    .get("resets_at")
                    .and_then(|r| r.as_str())
                    .map(format_reset_time)
                    .unwrap_or_default();
                sections.push(UsageSection {
                    name: name.to_string(),
                    percent: pct,
                    reset_text,
                });
            }
        }
    }

    UsageResult {
        plan_name,
        sections,
    }
}

#[tauri::command]
pub async fn get_usage() -> Result<UsageResult, String> {
    let (access_token, sub) = get_access_token().await?;

    // First attempt
    let raw = fetch_usage_api(&access_token).await?;
    if let Some(data) = raw {
        return Ok(transform_usage_data(&data, &sub));
    }

    // Auth failed — refresh and retry once
    let (creds, sub) = read_credentials().await?;
    let tokens = refresh_token(&creds.refresh_token).await?;
    let new_access = tokens.access_token.clone();
    update_credentials_file(&tokens).await?;

    let raw = fetch_usage_api(&new_access).await?;
    match raw {
        Some(data) => Ok(transform_usage_data(&data, &sub)),
        None => Err("Auth failed after refresh. Run \"claude auth\".".into()),
    }
}
