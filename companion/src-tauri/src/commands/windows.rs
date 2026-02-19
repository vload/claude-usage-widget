use serde::Serialize;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::Shell::IVirtualDesktopManager;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

#[derive(Serialize, Clone)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

struct EnumEntry {
    hwnd: HWND,
    rect: WindowRect,
}

struct EnumData {
    entries: Vec<EnumEntry>,
    own_pid: u32,
    win_offset_x: i32,
    win_offset_y: i32,
    monitors: Vec<RECT>,
}

unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let data = &mut *(lparam.0 as *mut EnumData);

    if data.entries.len() >= 30 {
        return BOOL(0);
    }

    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }

    // Skip cloaked windows (hidden by virtual desktops, GlazeWM workspaces, etc.)
    let mut cloaked: u32 = 0;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut _,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked != 0 {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == data.own_pid {
        return BOOL(1);
    }

    // Skip tool windows (tray icons, utility popups, etc.)
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return BOOL(1);
    }

    // Skip system overlay windows
    let mut class_buf = [0u16; 64];
    let class_len = GetClassNameW(hwnd, &mut class_buf) as usize;
    if class_len > 0 {
        let class_name = String::from_utf16_lossy(&class_buf[..class_len]);
        if class_name == "Windows.UI.Core.CoreWindow" {
            return BOOL(1);
        }
    }

    // DWM extended frame bounds (accurate, no invisible borders)
    let mut rect = RECT::default();
    let dwm_ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut rect as *mut RECT as *mut _,
        std::mem::size_of::<RECT>() as u32,
    ).is_ok();

    if !dwm_ok {
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        rect.left += 7;
        rect.right -= 7;
        rect.bottom -= 7;
    }

    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;

    if w < 50 || h < 10 {
        return BOOL(1);
    }

    // Only include windows that substantially overlap a monitor (on-screen)
    let mut on_screen = false;
    for mon in &data.monitors {
        let ox = 0.max(rect.right.min(mon.right) - rect.left.max(mon.left));
        let oy = 0.max(rect.bottom.min(mon.bottom) - rect.top.max(mon.top));
        let overlap = ox as i64 * oy as i64;
        let win_area = w as i64 * h as i64;
        if win_area > 0 && overlap * 5 >= win_area {
            on_screen = true;
            break;
        }
    }
    if !on_screen {
        return BOOL(1);
    }

    data.entries.push(EnumEntry {
        hwnd,
        rect: WindowRect {
            x: rect.left - data.win_offset_x,
            y: rect.top - data.win_offset_y,
            width: w as u32,
            height: h as u32,
        },
    });

    BOOL(1)
}

// ── Collect monitor rects ────────────────────────────────────────────────

struct MonitorCollectData {
    monitors: Vec<RECT>,
}

unsafe extern "system" fn monitor_collect_callback(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _lprect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let data = &mut *(lparam.0 as *mut MonitorCollectData);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
        data.monitors.push(info.rcMonitor);
    }
    BOOL(1)
}

#[tauri::command]
pub fn get_visible_window_rects(window: tauri::WebviewWindow) -> Result<Vec<WindowRect>, String> {
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;

    // Collect monitor rects
    let mut mon_data = MonitorCollectData {
        monitors: Vec::new(),
    };
    unsafe {
        let _ = EnumDisplayMonitors(
            None, None,
            Some(monitor_collect_callback),
            LPARAM(&mut mon_data as *mut MonitorCollectData as isize),
        );
    }

    let mut data = EnumData {
        entries: Vec::new(),
        own_pid: std::process::id(),
        win_offset_x: win_pos.x,
        win_offset_y: win_pos.y,
        monitors: mon_data.monitors,
    };

    unsafe {
        let _ = EnumWindows(
            Some(enum_callback),
            LPARAM(&mut data as *mut EnumData as isize),
        );
    }

    // Filter by virtual desktop — only include windows on the current desktop.
    // This handles GlazeWM workspaces (which use Windows Virtual Desktops).
    let vdm: Option<IVirtualDesktopManager> = unsafe {
        CoCreateInstance(&windows::Win32::UI::Shell::VirtualDesktopManager, None, CLSCTX_ALL).ok()
    };

    let rects: Vec<WindowRect> = data.entries
        .into_iter()
        .filter(|entry| {
            if let Some(ref vdm) = vdm {
                unsafe {
                    vdm.IsWindowOnCurrentVirtualDesktop(entry.hwnd)
                        .unwrap_or(BOOL(1))
                        .as_bool()
                }
            } else {
                true // If COM fails, include all
            }
        })
        .map(|entry| entry.rect)
        .collect();

    Ok(rects)
}

// Keep the single-window version for backwards compatibility
#[tauri::command]
pub fn get_active_window_rect(window: tauri::WebviewWindow) -> Result<Option<WindowRect>, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(None);
    }

    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Ok(None);
    }

    let mut fg_pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut fg_pid)) };
    if fg_pid == std::process::id() {
        return Ok(None);
    }

    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|e| e.to_string())?;

    let win_pos = window.outer_position().map_err(|e| e.to_string())?;

    Ok(Some(WindowRect {
        x: rect.left - win_pos.x,
        y: rect.top - win_pos.y,
        width: (rect.right - rect.left) as u32,
        height: (rect.bottom - rect.top) as u32,
    }))
}
