use serde::Serialize;

#[derive(Serialize)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn get_cursor_position(window: tauri::WebviewWindow) -> Result<CursorPos, String> {
    use mouse_position::mouse_position::Mouse;

    let (mx, my) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        Mouse::Error => return Err("Failed to get cursor position".into()),
    };

    // Subtract window position to get window-relative physical coords
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;
    Ok(CursorPos {
        x: mx - win_pos.x,
        y: my - win_pos.y,
    })
}

#[tauri::command]
pub fn get_monitors(window: tauri::WebviewWindow) -> Result<Vec<MonitorRect>, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;

    Ok(monitors
        .iter()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            MonitorRect {
                x: pos.x - win_pos.x,
                y: pos.y - win_pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect())
}
