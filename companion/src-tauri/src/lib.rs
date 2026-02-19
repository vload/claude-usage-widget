mod commands;

use tauri::Manager;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::usage::get_usage,
            commands::cursor::get_cursor_position,
            commands::cursor::get_monitors,
            commands::windows::get_active_window_rect,
            commands::windows::get_visible_window_rects,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Compute bounding box of ALL monitors so ball can be dragged across them
            let monitors = window.available_monitors()?;
            if !monitors.is_empty() {
                let mut min_x = i32::MAX;
                let mut min_y = i32::MAX;
                let mut max_x = i32::MIN;
                let mut max_y = i32::MIN;

                for monitor in &monitors {
                    let pos = monitor.position();
                    let size = monitor.size();
                    min_x = min_x.min(pos.x);
                    min_y = min_y.min(pos.y);
                    max_x = max_x.max(pos.x + size.width as i32);
                    max_y = max_y.max(pos.y + size.height as i32);
                }

                window.set_position(tauri::PhysicalPosition::new(min_x, min_y))?;
                window.set_size(tauri::PhysicalSize::new(
                    (max_x - min_x) as u32,
                    (max_y - min_y) as u32,
                ))?;
            }

            // Mark as tool window so tiling WMs (GlazeWM) ignore it
            let raw_hwnd = window.hwnd()?.0 as isize;
            unsafe {
                let hwnd = HWND(raw_hwnd as *mut _);
                let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                let new_style = ex_style | WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0;
                SetWindowLongW(hwnd, GWL_EXSTYLE, new_style as i32);
            }

            window.set_shadow(false)?;
            window.set_always_on_top(true)?;
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
