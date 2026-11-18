//! Where the registered sandbox distribution lives on the Windows volume.
use super::*;

/// Where Windows keeps the registered benchmark distribution, or why there
/// is none to use.
pub(crate) fn registered_path() -> io::Result<String> {
    #[cfg(windows)]
    {
        registered_sandbox_path()
    }
    #[cfg(not(windows))]
    {
        Err(io::Error::other(
            "capability_missing: the benchmark WSL distribution requires Windows",
        ))
    }
}

#[cfg(windows)]
pub(super) fn registered_sandbox_path() -> io::Result<String> {
    use std::ffi::c_void;
    type Key = *mut c_void;
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            key: Key,
            name: *const u16,
            options: u32,
            access: u32,
            out: *mut Key,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Key,
            index: u32,
            name: *mut u16,
            length: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_length: *mut u32,
            written: *mut c_void,
        ) -> i32;
        fn RegQueryValueExW(
            key: Key,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            bytes: *mut u8,
            length: *mut u32,
        ) -> i32;
        fn RegCloseKey(key: Key) -> i32;
    }
    struct RegistryKey(Key);
    impl Drop for RegistryKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let query = |key: Key, name: &str| -> Option<String> {
        let name = wide(name);
        let mut bytes = [0_u16; 4096];
        let mut length = (bytes.len() * 2) as u32;
        let mut kind = 0;
        let result = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                bytes.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if result != 0 || kind != 1 || length < 2 || length as usize > bytes.len() * 2 {
            return None;
        }
        let text = &bytes[..length as usize / 2];
        String::from_utf16(text.strip_suffix(&[0]).unwrap_or(text)).ok()
    };
    let mut root: Key = std::ptr::null_mut();
    // HKEY_CURRENT_USER is a sign-extended predefined handle on Windows x64.
    let current_user = (0x8000_0001_u32 as i32 as isize) as Key;
    let result = unsafe {
        RegOpenKeyExW(
            current_user,
            wide("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss").as_ptr(),
            0,
            0x20019,
            &mut root,
        )
    };
    if result != 0 {
        return Err(io::Error::other(
            "capability_missing: the benchmark WSL distribution is not registered",
        ));
    }
    let root = RegistryKey(root);
    for index in 0..1024 {
        let mut name = [0_u16; 256];
        let mut length = name.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                root.0,
                index,
                name.as_mut_ptr(),
                &mut length,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == 259 {
            break;
        }
        if result != 0 {
            continue;
        }
        name[length as usize] = 0;
        let mut child: Key = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(root.0, name.as_ptr(), 0, 0x20019, &mut child) } != 0 {
            continue;
        }
        let child = RegistryKey(child);
        if query(child.0, "DistributionName").as_deref() == Some(DISTRIBUTION) {
            return query(child.0, "BasePath")
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    io::Error::other("capability_missing: sandbox storage location is unavailable")
                });
        }
    }
    Err(io::Error::other(
        "capability_missing: the benchmark WSL distribution is not registered",
    ))
}
