//! Window-handle facts and activation guards shared by Win32 input and UI
//! Automation delivery.

use std::{
	mem::size_of,
	ptr::{null_mut, with_exposed_provenance_mut},
	thread,
	time::{Duration, Instant},
};

use windows_sys::{
	Win32::{
		Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT},
		Graphics::Gdi::ScreenToClient,
		Security::{
			GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
			TOKEN_QUERY, TokenIntegrityLevel,
		},
		System::Threading::{
			AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
			PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
		},
		UI::{
			Input::KeyboardAndMouse::{
				EnableWindow, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
				VK_NONAME,
			},
			WindowsAndMessaging::{
				CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, ChildWindowFromPointEx,
				EnumChildWindows, GA_PARENT, GA_ROOT, GA_ROOTOWNER, GUITHREADINFO, GWL_EXSTYLE,
				GetAncestor, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongW,
				GetWindowThreadProcessId, IsChild, IsHungAppWindow, SetForegroundWindow,
				SetWindowLongW, WS_EX_NOACTIVATE,
			},
		},
	},
	core::BOOL,
};

use super::delivery::is_chromium_class;

/// Top-level classes that host XAML/UWP/WinUI content.
const XAML_HOST_CLASSES: [&str; 4] = [
	"ApplicationFrameWindow",
	"WinUIDesktopWin32WindowClass",
	"Windows.UI.Core.CoreWindow",
	"Microsoft.UI.Content.DesktopChildSiteBridge",
];

/// Executables that render XAML behind a legacy top-level class (Windows 11
/// Notepad keeps the `Notepad` class) or a generic frame host.
const XAML_HOST_EXECUTABLES: [&str; 6] = [
	"notepad.exe",
	"calculatorapp.exe",
	"calc.exe",
	"applicationframehost.exe",
	"photos.exe",
	"systemsettings.exe",
];

/// How long a target keeps its activation shield after posted input or a UI
/// Automation pattern, covering handlers that run asynchronously.
const ACTIVATION_SETTLE: Duration = Duration::from_millis(50);

/// Top-level window that owns `hwnd`, or `hwnd` itself when it has none.
pub(super) fn root(hwnd: HWND) -> HWND {
	// SAFETY: GetAncestor validates the handle and returns null for stale ones.
	let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
	if root.is_null() { hwnd } else { root }
}

/// Class name of `hwnd`, or `<unknown>` when Win32 cannot report one.
pub(super) fn class_name(hwnd: HWND) -> String {
	with_class_name(hwnd, |class| {
		if class.is_empty() {
			"<unknown>".to_string()
		} else {
			class.to_string()
		}
	})
}

/// Runs `inspect` on `hwnd`'s class name without heap allocation; the name is
/// empty when Win32 cannot report one.
fn with_class_name<R>(hwnd: HWND, inspect: impl FnOnce(&str) -> R) -> R {
	let mut wide = [0u16; 256];
	// SAFETY: the buffer is writable for its advertised length; Win32 validates
	// the handle.
	let length = unsafe { GetClassNameW(hwnd, wide.as_mut_ptr(), wide.len() as i32) };
	// Each UTF-16 unit decodes to at most three UTF-8 bytes.
	let mut utf8 = [0u8; 256 * 3];
	let mut used = 0;
	for decoded in char::decode_utf16(wide[..length.max(0) as usize].iter().copied()) {
		used += decoded
			.unwrap_or(char::REPLACEMENT_CHARACTER)
			.encode_utf8(&mut utf8[used..])
			.len();
	}
	inspect(std::str::from_utf8(&utf8[..used]).unwrap_or_default())
}

/// Whether `hwnd`'s top-level window currently owns the foreground.
pub(super) fn owns_foreground(hwnd: HWND) -> bool {
	// SAFETY: GetForegroundWindow has no preconditions.
	let foreground = unsafe { GetForegroundWindow() };
	!foreground.is_null() && root(foreground) == root(hwnd)
}

/// Whether a Chromium or CEF renderer lives in a descendant of `hwnd`.
pub(super) fn has_chromium_descendant(hwnd: HWND) -> bool {
	unsafe extern "system" fn visit(child: HWND, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the flag owned by the
		// enclosing call, which outlives this synchronous enumeration.
		let found = unsafe { &mut *with_exposed_provenance_mut::<bool>(state as usize) };
		*found = with_class_name(child, is_chromium_class);
		BOOL::from(!*found)
	}

	let mut found = false;
	// SAFETY: `visit` runs only during this synchronous call and receives the
	// address of `found`, which outlives it.
	unsafe {
		EnumChildWindows(hwnd, Some(visit), (&raw mut found).expose_provenance() as LPARAM);
	}
	found
}

/// Deepest visible, enabled descendant of `root` under a physical screen
/// point, with the point in that descendant's client coordinates. `None` when
/// `root` cannot map screen coordinates.
///
/// Posting to the control that owns the point keeps button presses out of the
/// top-level frame, which may activate itself in response, and lets
/// child-window controls see input for the region they own.
pub(super) fn deepest_child(root: HWND, screen: POINT) -> Option<(HWND, POINT)> {
	let mut current = root;
	let mut client = screen;
	// SAFETY: `client` is writable; Win32 validates the handle.
	if unsafe { ScreenToClient(current, &mut client) } == 0 {
		return None;
	}
	for _ in 0..32 {
		// SAFETY: scalar arguments; Win32 validates the handle.
		let child = unsafe {
			ChildWindowFromPointEx(
				current,
				client,
				CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
			)
		};
		// SAFETY: IsChild validates both handles.
		if child.is_null() || child == current || unsafe { IsChild(root, child) } == 0 {
			break;
		}
		let mut child_client = screen;
		// SAFETY: `child_client` is writable; `child` is a live descendant.
		if unsafe { ScreenToClient(child, &mut child_client) } == 0 {
			break;
		}
		current = child;
		client = child_client;
	}
	Some((current, client))
}

/// Focused descendant of `root` across every UI thread that owns part of its
/// window tree.
///
/// Top-level window procedures do not forward keyboard messages to embedded
/// editors (Scintilla, `RichEdit`, `WebView2`), and embedded renderers often
/// keep their focused child on another thread than the frame, so each
/// descendant thread's `GUITHREADINFO` is consulted and the deepest focused
/// descendant wins.
pub(super) fn focused_descendant(root: HWND) -> Option<HWND> {
	unsafe extern "system" fn collect(child: HWND, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the thread list owned by
		// the enclosing call, which outlives this synchronous enumeration.
		let threads = unsafe { &mut *with_exposed_provenance_mut::<Vec<u32>>(state as usize) };
		// SAFETY: a null process-id pointer is permitted; Win32 validates the
		// handle.
		let thread = unsafe { GetWindowThreadProcessId(child, null_mut()) };
		if thread != 0 && !threads.contains(&thread) {
			threads.push(thread);
		}
		1
	}

	// SAFETY: a null process-id pointer is permitted; Win32 validates the
	// handle.
	let root_thread = unsafe { GetWindowThreadProcessId(root, null_mut()) };
	if root_thread == 0 {
		return None;
	}
	let mut threads = vec![root_thread];
	// SAFETY: `collect` runs only during this synchronous call and receives the
	// address of `threads`, which outlives it.
	unsafe {
		EnumChildWindows(root, Some(collect), (&raw mut threads).expose_provenance() as LPARAM);
	}
	let mut best: Option<(usize, HWND)> = None;
	for thread in threads {
		let mut info =
			GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
		// SAFETY: `info` is writable and its size field is initialized.
		if unsafe { GetGUIThreadInfo(thread, &mut info) } == 0 {
			continue;
		}
		let focused = info.hwndFocus;
		// SAFETY: IsChild validates both handles.
		if focused.is_null() || focused == root || unsafe { IsChild(root, focused) } == 0 {
			continue;
		}
		let depth = depth_below(root, focused);
		if best.is_none_or(|(best_depth, _)| depth > best_depth) {
			best = Some((depth, focused));
		}
	}
	best.map(|(_, focused)| focused)
}

/// Number of parent links between `descendant` and `ancestor`.
fn depth_below(ancestor: HWND, descendant: HWND) -> usize {
	let mut depth = 0;
	let mut current = descendant;
	while current != ancestor && depth < 64 {
		// SAFETY: GetAncestor validates the handle and returns null at the top.
		current = unsafe { GetAncestor(current, GA_PARENT) };
		if current.is_null() {
			break;
		}
		depth += 1;
	}
	depth
}

/// Explains why User Interface Privilege Isolation discards this process's
/// input to `hwnd`, or `None` when the target does not run at a higher
/// integrity level. Posted and injected input to a higher-integrity window
/// reports success but never arrives.
pub(super) fn uipi_block(hwnd: HWND) -> Option<String> {
	let mut pid = 0;
	// SAFETY: `pid` is writable; Win32 validates the handle.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	if pid == 0 {
		return None;
	}
	// SAFETY: the pseudo-handle for the current process needs no cleanup.
	let own = integrity_level(unsafe { GetCurrentProcess() })?;
	// SAFETY: scalar arguments; a null result is handled below.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if process.is_null() {
		return None;
	}
	let target = integrity_level(process);
	// SAFETY: `process` was opened above and is closed exactly once.
	unsafe { CloseHandle(process) };
	let target = target?;
	(target > own).then(|| {
		format!(
			"process {pid} runs at {} integrity, above this process's {} integrity, so Windows UIPI \
			 discards input sent to it; run omp at the same integrity level to drive it",
			integrity_name(target),
			integrity_name(own),
		)
	})
}

/// Mandatory integrity-level RID of `process`, or `None` when its token is
/// unreadable.
fn integrity_level(process: HANDLE) -> Option<u32> {
	let mut token: HANDLE = null_mut();
	// SAFETY: `token` is writable; `process` is a live handle owned by the
	// caller.
	if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
		return None;
	}
	// A mandatory label is a TOKEN_MANDATORY_LABEL followed by a
	// one-subauthority SID; the u64 array provides the pointer alignment.
	let mut label = [0u64; 16];
	let mut written = 0;
	// SAFETY: `label` is writable for its full byte length and `token` is live.
	let read = unsafe {
		GetTokenInformation(
			token,
			TokenIntegrityLevel,
			label.as_mut_ptr().cast(),
			size_of_val(&label) as u32,
			&mut written,
		)
	} != 0;
	// SAFETY: `token` was opened above and is closed exactly once.
	unsafe { CloseHandle(token) };
	if !read {
		return None;
	}
	// SAFETY: GetTokenInformation filled `label` with a TOKEN_MANDATORY_LABEL
	// whose SID points into the same still-live buffer.
	let sid = unsafe { (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid };
	// SAFETY: `sid` is a valid SID inside `label`.
	let count = unsafe { GetSidSubAuthorityCount(sid) };
	if count.is_null() {
		return None;
	}
	// SAFETY: a non-null count pointer addresses the SID header inside `label`.
	let count = unsafe { *count };
	let last = u32::from(count.checked_sub(1)?);
	// SAFETY: `last` indexes an existing subauthority of `sid`.
	let rid = unsafe { GetSidSubAuthority(sid, last) };
	// SAFETY: a non-null result addresses the subauthority inside `label`.
	(!rid.is_null()).then(|| unsafe { *rid })
}

const fn integrity_name(rid: u32) -> &'static str {
	match rid {
		0x0000..0x1000 => "untrusted",
		0x1000..0x2000 => "low",
		0x2000..0x3000 => "medium",
		0x3000..0x4000 => "high",
		_ => "system",
	}
}

/// Whether `root` hosts XAML/UWP/WinUI content, whose pattern handlers call
/// `SetForegroundWindow(self)` and whose keyboard input comes only from the
/// system input queue.
pub(super) fn is_xaml_host(root: HWND) -> bool {
	with_class_name(root, |class| XAML_HOST_CLASSES.contains(&class))
		|| executable_is_any(root, &XAML_HOST_EXECUTABLES)
}

/// Whether the executable owning `hwnd` has one of the ASCII `names`,
/// compared case-insensitively against the image path's file name.
fn executable_is_any(hwnd: HWND, names: &[&str]) -> bool {
	let mut pid = 0;
	// SAFETY: `pid` is writable; Win32 validates the handle.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	if pid == 0 {
		return false;
	}
	// SAFETY: scalar arguments; a null result is handled below.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if process.is_null() {
		return false;
	}
	let mut path = [0u16; 1024];
	let mut length = path.len() as u32;
	// SAFETY: `path` is writable for `length` units and `process` is live.
	let read = unsafe {
		QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut length)
	} != 0;
	// SAFETY: `process` was opened above and is closed exactly once.
	unsafe { CloseHandle(process) };
	if !read {
		return false;
	}
	let path = &path[..(length as usize).min(path.len())];
	let file_name = path
		.iter()
		.rposition(|&unit| unit == u16::from(b'\\') || unit == u16::from(b'/'))
		.map_or(path, |separator| &path[separator + 1..]);
	names.iter().any(|name| {
		file_name.len() == name.len()
			&& file_name.iter().zip(name.bytes()).all(|(&unit, byte)| {
				u8::try_from(unit).is_ok_and(|unit| unit.eq_ignore_ascii_case(&byte))
			})
	})
}

/// Activates `target` while attached to the current foreground thread's input
/// state, which lets `SetForegroundWindow` pass the foreground lock without
/// `UIAccess`. Returns whether `target` is now the foreground window.
fn attach_and_activate(target: HWND) -> bool {
	// SAFETY: every call takes scalar handles or thread ids that Win32
	// validates; the attachment is undone before returning.
	unsafe {
		let current = GetForegroundWindow();
		if current == target {
			return true;
		}
		let own_thread = GetCurrentThreadId();
		let foreground_thread = GetWindowThreadProcessId(current, null_mut());
		let attached = foreground_thread != 0
			&& foreground_thread != own_thread
			&& AttachThreadInput(own_thread, foreground_thread, 1) != 0;
		SetForegroundWindow(target);
		if attached {
			AttachThreadInput(own_thread, foreground_thread, 0);
		}
		GetForegroundWindow() == target
	}
}

/// Activates `target`, retrying after a reserved no-op key (`VK_NONAME`) makes
/// this process the source of the most recent input, which the foreground
/// lock requires. Returns whether `target` became the foreground window.
pub(super) fn activate(target: HWND) -> bool {
	if attach_and_activate(target) {
		return true;
	}
	let input_token = [noname_key(0), noname_key(KEYEVENTF_KEYUP)];
	// SAFETY: `input_token` is an initialized INPUT array copied synchronously.
	unsafe {
		SendInput(input_token.len() as u32, input_token.as_ptr(), size_of::<INPUT>() as i32);
	}
	for _ in 0..3 {
		if attach_and_activate(target) {
			return true;
		}
		thread::sleep(Duration::from_millis(25));
	}
	false
}

const fn noname_key(flags: u32) -> INPUT {
	INPUT {
		r#type:    INPUT_KEYBOARD,
		Anonymous: INPUT_0 {
			ki: KEYBDINPUT {
				wVk:         VK_NONAME,
				wScan:       0,
				dwFlags:     flags,
				time:        0,
				dwExtraInfo: 0,
			},
		},
	}
}

/// Waits up to `timeout` for `target`, or a window it owns such as a modal
/// dialog that activation surfaced instead, to be the foreground window.
pub(super) fn wait_for_foreground(target: HWND, timeout: Duration) -> bool {
	let deadline = Instant::now() + timeout;
	loop {
		// SAFETY: GetForegroundWindow has no preconditions.
		let foreground = unsafe { GetForegroundWindow() };
		// SAFETY: GetAncestor validates the handle and returns null for stale ones.
		if foreground == target || unsafe { GetAncestor(foreground, GA_ROOTOWNER) } == target {
			return true;
		}
		if Instant::now() >= deadline {
			return false;
		}
		thread::sleep(Duration::from_millis(10));
	}
}

/// Runs background `operation` against `root` so it cannot take the
/// foreground: the window is non-activatable while the operation and its
/// asynchronous handlers run, and if it activated anyway the user's previous
/// foreground window is handed back.
pub(super) fn contain_activation<T>(root: HWND, operation: impl FnOnce() -> T) -> T {
	contain(root, false, operation)
}

/// [`contain_activation`] for a UI Automation pattern call, which also
/// disables XAML and Chromium hosts for the synchronous call: they call
/// `SetForegroundWindow(self)` from pattern handlers, a disabled top-level
/// window cannot become foreground, and the pattern still arrives over the
/// accessibility channel.
pub(super) fn contain_pattern_activation<T>(root: HWND, operation: impl FnOnce() -> T) -> T {
	contain(root, true, operation)
}

fn contain<T>(root: HWND, shield_host: bool, operation: impl FnOnce() -> T) -> T {
	// SAFETY: GetForegroundWindow has no preconditions.
	let previous = unsafe { GetForegroundWindow() };
	// A target that already owns the foreground has nothing to take, and
	// disabling it would drop the user's keyboard focus inside it.
	if previous.is_null() || self::root(previous) == root {
		return operation();
	}
	let no_activate = NoActivateGuard::arm(root);
	let result = {
		let _shield = shield_host.then(|| DisabledHostGuard::arm(root));
		operation()
	};
	thread::sleep(ACTIVATION_SETTLE);
	// SAFETY: GetForegroundWindow has no preconditions.
	let current = unsafe { GetForegroundWindow() };
	if !current.is_null() && self::root(current) == root {
		// Target handlers can re-activate asynchronously; the second attempt
		// wins that race.
		attach_and_activate(previous);
		thread::sleep(Duration::from_millis(12));
		attach_and_activate(previous);
	}
	drop(no_activate);
	result
}

/// Sets `WS_EX_NOACTIVATE` on a top-level window and clears only that bit on
/// drop. The window still receives posted input and UI Automation patterns,
/// but click-activation and its own `SetForegroundWindow` calls are refused.
struct NoActivateGuard {
	root:    HWND,
	applied: bool,
}

impl NoActivateGuard {
	fn arm(root: HWND) -> Self {
		// SAFETY: these calls read and write scalar window state; Win32
		// validates the handle. Hung windows are skipped because the style
		// change sends synchronous messages to the owning thread.
		let applied = unsafe {
			IsHungAppWindow(root) == 0 && {
				let style = GetWindowLongW(root, GWL_EXSTYLE) as u32;
				style & WS_EX_NOACTIVATE == 0 && {
					SetWindowLongW(root, GWL_EXSTYLE, (style | WS_EX_NOACTIVATE) as i32);
					// UIPI can refuse the change on higher-integrity windows.
					GetWindowLongW(root, GWL_EXSTYLE) as u32 & WS_EX_NOACTIVATE != 0
				}
			}
		};
		Self { root, applied }
	}
}

impl Drop for NoActivateGuard {
	fn drop(&mut self) {
		if self.applied {
			// SAFETY: scalar window-state access; clearing only our bit keeps
			// style changes the application made meanwhile.
			unsafe {
				let style = GetWindowLongW(self.root, GWL_EXSTYLE) as u32;
				SetWindowLongW(self.root, GWL_EXSTYLE, (style & !WS_EX_NOACTIVATE) as i32);
			}
		}
	}
}

/// Disables a XAML or Chromium host until dropped and leaves other hosts
/// untouched.
struct DisabledHostGuard {
	root:     HWND,
	disabled: bool,
}

impl DisabledHostGuard {
	fn arm(root: HWND) -> Self {
		// SAFETY: IsHungAppWindow and EnableWindow take a scalar handle that
		// Win32 validates; EnableWindow returns nonzero when the window was
		// already disabled, which is then left alone.
		let disabled = unsafe {
			IsHungAppWindow(root) == 0
				&& (is_xaml_host(root) || with_class_name(root, is_chromium_class))
				&& EnableWindow(root, 0) == 0
		};
		Self { root, disabled }
	}
}

impl Drop for DisabledHostGuard {
	fn drop(&mut self) {
		if self.disabled {
			// SAFETY: re-enables the window this guard disabled.
			unsafe { EnableWindow(self.root, 1) };
		}
	}
}
