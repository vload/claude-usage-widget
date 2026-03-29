use std::sync::atomic::{AtomicI32, Ordering};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, SetWindowLongPtrW, GetWindowLongPtrW,
    GWLP_WNDPROC, WNDPROC, WM_NCHITTEST,
};

// Global hit-test region (physical pixels, relative to window client area)
static HIT_X: AtomicI32 = AtomicI32::new(0);
static HIT_Y: AtomicI32 = AtomicI32::new(0);
static HIT_W: AtomicI32 = AtomicI32::new(0);
static HIT_H: AtomicI32 = AtomicI32::new(0);

// Stash for the original wndproc
static mut ORIGINAL_WNDPROC: Option<WNDPROC> = None;

const HTTRANSPARENT: i32 = -1;

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        // First, call the original to get default result
        let result = if let Some(proc) = ORIGINAL_WNDPROC {
            CallWindowProcW(proc, hwnd, msg, wparam, lparam)
        } else {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        };

        // Extract screen coords from lparam
        let screen_x = (lparam.0 & 0xFFFF) as i16 as i32;
        let screen_y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;

        // Convert to client coords
        let mut pt = windows::Win32::Foundation::POINT {
            x: screen_x,
            y: screen_y,
        };
        let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut pt);

        let hx = HIT_X.load(Ordering::Relaxed);
        let hy = HIT_Y.load(Ordering::Relaxed);
        let hw = HIT_W.load(Ordering::Relaxed);
        let hh = HIT_H.load(Ordering::Relaxed);

        // If no hit region set (w=0, h=0), everything is transparent
        if hw == 0 && hh == 0 {
            return LRESULT(HTTRANSPARENT as isize);
        }

        // If point is inside the blob bounding box, let it through (interactive)
        if pt.x >= hx && pt.x <= hx + hw && pt.y >= hy && pt.y <= hy + hh {
            return result;
        }

        // Outside blob — transparent (click-through)
        return LRESULT(HTTRANSPARENT as isize);
    }

    // For all other messages, call original
    if let Some(proc) = ORIGINAL_WNDPROC {
        CallWindowProcW(proc, hwnd, msg, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// Install the WM_NCHITTEST subclass on the given HWND.
pub fn install_hit_test_subclass(hwnd: HWND) {
    unsafe {
        let old = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        ORIGINAL_WNDPROC = std::mem::transmute::<isize, WNDPROC>(old).into();
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, subclass_proc as isize);
    }
}

#[tauri::command]
pub fn set_hit_test_region(x: i32, y: i32, width: i32, height: i32) {
    HIT_X.store(x, Ordering::Relaxed);
    HIT_Y.store(y, Ordering::Relaxed);
    HIT_W.store(width, Ordering::Relaxed);
    HIT_H.store(height, Ordering::Relaxed);
}
