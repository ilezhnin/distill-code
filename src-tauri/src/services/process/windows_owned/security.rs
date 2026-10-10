//! Fresh staging ownership, exact grants and actual child-token verification.

use super::{last_error, owned_handle, wide, win32};
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
};
use windows_sys::Win32::Security::{
    AccessCheck, AddAccessAllowedAceEx, AddMandatoryAce, CopySid, CreateWellKnownSid,
    DeriveCapabilitySidsFromName, DuplicateTokenEx, EqualSid, FreeSid, GetAce, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetSecurityDescriptorLength,
    GetSecurityDescriptorSacl, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
    InitializeAcl, IsValidSid, MakeSelfRelativeSD, SecurityImpersonation, TokenAppContainerSid,
    TokenCapabilities, TokenImpersonation, TokenIntegrityLevel, TokenIsAppContainer, TokenUser,
    WinBuiltinAnyPackageSid, WinLocalSystemSid, WinLowLabelSid, ACL, ACL_REVISION,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GENERIC_MAPPING, GROUP_SECURITY_INFORMATION,
    LABEL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, SE_SELF_RELATIVE,
    SID_AND_ATTRIBUTES, SYSTEM_MANDATORY_LABEL_ACE, TOKEN_APPCONTAINER_INFORMATION,
    TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    TOKEN_USER, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileAttributesW, GetFileInformationByHandle, GetVolumeInformationW,
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    INVALID_FILE_ATTRIBUTES, OPEN_EXISTING, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::SystemServices::{
    SE_GROUP_ENABLED, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const MAX_STAGED_ENTRIES: usize = 32_768;
const MAX_DEPTH: usize = 64;
const LOW_INTEGRITY_RID: u32 = 0x1000;

/// Cannot be built from an arbitrary existing folder. The factory creates the
/// attempt and every granted top-level root; the caller only stages their files.
pub(crate) struct OwnedWindowsStaging {
    id: Uuid,
    root: PathBuf,
    root_anchor: OwnedHandle,
    root_anchors: Vec<OwnedHandle>,
    lpac_canary: PathBuf,
    runtime: PathBuf,
    workspace: PathBuf,
    home: PathBuf,
    temp: PathBuf,
}

impl OwnedWindowsStaging {
    pub(crate) fn create(parent: &Path) -> io::Result<Self> {
        let parent = checked_path(parent)?;
        require_ntfs(&parent)?;
        if !parent.is_dir() {
            return Err(io::Error::other(
                "Protected staging parent must be a directory",
            ));
        }
        let id = Uuid::new_v4();
        let root = parent.join(format!("attempt-{id}"));
        // Exclusive creation is the ownership boundary; existing paths are never adopted.
        fs::create_dir(&root)?;
        let root_anchor = open_object(&root, false, false)?;
        let runtime = root.join("runtime");
        let workspace = root.join("workspace");
        let home = root.join("home");
        // Windows points an AppContainer child's TEMP/TMP at its own folder
        // below LOCALAPPDATA, which is `home` here, whatever the environment
        // block says. Staging that exact folder keeps temp inside `home`.
        let packages = home.join("Packages");
        let container = packages.join(profile_name(id).to_ascii_lowercase());
        let container_data = container.join("AC");
        let temp = container_data.join("Temp");
        let mut root_anchors = Vec::new();
        for path in [
            &runtime,
            &workspace,
            &home,
            &packages,
            &container,
            &container_data,
            &temp,
        ] {
            fs::create_dir(path)?;
            root_anchors.push(open_object_with_sharing(path, true, false, false)?);
        }
        let lpac_canary = root.join("public-lpac-canary.txt");
        fs::write(&lpac_canary, "invented-public-lpac-canary")?;
        Ok(Self {
            id,
            root,
            root_anchor,
            root_anchors,
            lpac_canary,
            runtime,
            workspace,
            home,
            temp,
        })
    }
    pub(crate) fn id(&self) -> Uuid {
        self.id
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn runtime(&self) -> &Path {
        &self.runtime
    }
    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }
    pub(crate) fn home(&self) -> &Path {
        &self.home
    }
    /// The child's actual TEMP/TMP, inside `home`.
    pub(crate) fn temp(&self) -> &Path {
        &self.temp
    }
    pub(crate) fn lpac_canary(&self) -> &Path {
        &self.lpac_canary
    }

    pub(super) fn validate_program(&self, path: &Path) -> io::Result<PathBuf> {
        let program = checked_path(path)?;
        if !below(&program, &self.runtime)
            || !program.is_file()
            || program
                .extension()
                .is_none_or(|extension| !same_os(extension, OsStr::new("exe")))
        {
            return Err(io::Error::other(
                "Protected program must be a staged real Windows executable",
            ));
        }
        Ok(program)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsSecurityFacts {
    pub profile_name: String,
    pub app_container_sid: String,
    pub less_privileged: bool,
    pub lpac_proof: &'static str,
    pub integrity_rid: u32,
    pub network_capability_count: u32,
    /// Named capabilities the actual child token carries, exactly as granted.
    pub capabilities: Vec<&'static str>,
    pub inherited_stdio_handles: u32,
    pub strict_job: bool,
}

/// Named capabilities a protected launch may request. `registryRead` lets the
/// lowbox read machine configuration that process creation and Winsock
/// startup need; it grants no file, network or loopback access. Network
/// capabilities are deliberately absent until a contract names its egress.
pub(crate) const ALLOWED_CAPABILITIES: &[&str] = &["registryRead"];

/// Capability SIDs derived by Windows from their names, owned for the launch.
/// Holds no raw pointers, so a launch future that keeps it stays `Send`.
pub(super) struct Capabilities {
    names: Vec<&'static str>,
    sids: Vec<Sid>,
}
impl Capabilities {
    pub(super) fn derive(names: &[&'static str]) -> io::Result<Self> {
        let mut unique = names.to_vec();
        unique.sort_unstable();
        unique.dedup();
        if unique.len() != names.len()
            || names
                .iter()
                .any(|name| !ALLOWED_CAPABILITIES.contains(name))
        {
            return Err(io::Error::other(
                "Protected launch requested an unknown or repeated capability",
            ));
        }
        let mut sids = Vec::new();
        for name in &unique {
            let encoded = wide(OsStr::new(name))?;
            let mut groups: *mut PSID = null_mut();
            let mut group_count = 0u32;
            let mut capability_sids: *mut PSID = null_mut();
            let mut count = 0u32;
            // SAFETY: Windows allocates both arrays and every SID; each is
            // freed below with LocalFree after the capability SID is copied.
            let derived = win32(
                unsafe {
                    DeriveCapabilitySidsFromName(
                        encoded.as_ptr(),
                        &mut groups,
                        &mut group_count,
                        &mut capability_sids,
                        &mut count,
                    )
                },
                "derive named capability SID",
            );
            let copied = if derived.is_ok() && count == 1 && !capability_sids.is_null() {
                Sid::copy(unsafe { *capability_sids })
            } else {
                Err(io::Error::other(format!(
                    "Capability {name} did not derive exactly one SID"
                )))
            };
            for (array, length) in [(groups, group_count), (capability_sids, count)] {
                if array.is_null() {
                    continue;
                }
                for index in 0..length as usize {
                    unsafe {
                        LocalFree((*array.add(index)).cast());
                    }
                }
                unsafe {
                    LocalFree(array.cast());
                }
            }
            derived?;
            sids.push(copied?);
        }
        Ok(Self {
            names: unique,
            sids,
        })
    }
    /// The launch attribute array; it borrows these SIDs and must not
    /// outlive `self`.
    pub(super) fn attributes(&self) -> Vec<SID_AND_ATTRIBUTES> {
        self.sids
            .iter()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.pointer(),
                Attributes: SE_GROUP_ENABLED as u32,
            })
            .collect()
    }
    pub(super) fn names(&self) -> Vec<&'static str> {
        self.names.clone()
    }
    /// The token must carry exactly these capabilities, all enabled.
    fn matches(&self, groups: &TOKEN_GROUPS) -> bool {
        if groups.GroupCount as usize != self.sids.len() {
            return false;
        }
        let actual = unsafe {
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        };
        actual.iter().all(|group| {
            group.Attributes & SE_GROUP_ENABLED as u32 != 0
                && self
                    .sids
                    .iter()
                    .any(|sid| unsafe { EqualSid(group.Sid, sid.pointer()) } != 0)
        })
    }
}

struct Sid {
    storage: Vec<usize>,
}
impl Sid {
    fn copy(pointer: PSID) -> io::Result<Self> {
        if pointer.is_null() || unsafe { IsValidSid(pointer) } == 0 {
            return Err(io::Error::other("Windows returned an invalid security SID"));
        }
        let size = unsafe { GetLengthSid(pointer) };
        if !(8..=256).contains(&size) {
            return Err(io::Error::other("Unknown SID size"));
        }
        let result = Self {
            storage: vec![0; (size as usize).div_ceil(std::mem::size_of::<usize>())],
        };
        win32(
            unsafe { CopySid(size, result.pointer(), pointer) },
            "copy owned SID",
        )?;
        Ok(result)
    }
    fn pointer(&self) -> PSID {
        self.storage.as_ptr().cast_mut().cast()
    }
    fn text(&self) -> io::Result<String> {
        let mut text = null_mut();
        win32(
            unsafe { ConvertSidToStringSidW(self.pointer(), &mut text) },
            "format owned SID",
        )?;
        let mut length = 0;
        while length < 512 && unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        let result = if length == 512 {
            Err(io::Error::other("SID text exceeds supported bound"))
        } else {
            String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
                .map_err(io::Error::other)
        };
        unsafe {
            LocalFree(text.cast());
        }
        result
    }
}

pub(super) struct Profile {
    name: String,
    sid: Sid,
    active: bool,
    launched: bool,
}
/// The AppContainer profile name of one attempt.
fn profile_name(id: Uuid) -> String {
    format!("Distill.Owned.{}", id.simple())
}

impl Profile {
    pub(super) fn create(id: Uuid) -> io::Result<Self> {
        let name = profile_name(id);
        let encoded = wide(OsStr::new(&name))?;
        let mut pointer = null_mut();
        // Zero capabilities: no Internet/loopback/private-network grant. An
        // existing profile is an error; deriving/reusing its SID is forbidden.
        let code = unsafe {
            CreateAppContainerProfile(
                encoded.as_ptr(),
                encoded.as_ptr(),
                encoded.as_ptr(),
                null(),
                0,
                &mut pointer,
            )
        };
        if code != 0 {
            return Err(io::Error::other(format!(
                "CreateAppContainerProfile refused new profile: HRESULT 0x{:08x}",
                code as u32
            )));
        }
        let copied = Sid::copy(pointer);
        if !pointer.is_null() {
            unsafe {
                FreeSid(pointer);
            }
        }
        match copied {
            Ok(sid) => Ok(Self {
                name,
                sid,
                active: true,
                launched: false,
            }),
            Err(error) => {
                let cleanup = unsafe { DeleteAppContainerProfile(encoded.as_ptr()) };
                if cleanup != 0 {
                    log::warn!(
                        "SID copy failed; retaining unresolved profile {name}: HRESULT 0x{:08x}",
                        cleanup as u32
                    );
                }
                Err(error)
            }
        }
    }
    pub(super) fn sid(&self) -> PSID {
        self.sid.pointer()
    }
    pub(super) fn mark_launched(&mut self) {
        self.launched = true;
    }
    pub(super) fn verify_child(
        &self,
        process: &Option<OwnedHandle>,
        canary: &OwnedHandle,
        capabilities: &Capabilities,
    ) -> io::Result<WindowsSecurityFacts> {
        let mut facts = self.verify_common(process, capabilities)?;
        if canary_read_allowed(process, canary)? {
            return Err(io::Error::other(
                "Actual child retained ALL_APPLICATION_PACKAGES read access",
            ));
        }
        facts.less_privileged = true;
        facts.lpac_proof =
            "kernel_access_check_all_application_packages_denied_with_ordinary_control";
        Ok(facts)
    }
    pub(super) fn verify_ordinary_control(
        &self,
        process: &Option<OwnedHandle>,
        canary: &OwnedHandle,
        capabilities: &Capabilities,
    ) -> io::Result<()> {
        self.verify_common(process, capabilities)?;
        if !canary_read_allowed(process, canary)? {
            return Err(io::Error::other(
                "Ordinary AppContainer LPAC diagnostic control did not grant canary read",
            ));
        }
        Ok(())
    }
    fn verify_common(
        &self,
        process: &Option<OwnedHandle>,
        expected: &Capabilities,
    ) -> io::Result<WindowsSecurityFacts> {
        let process = process
            .as_ref()
            .ok_or_else(|| io::Error::other("Protected process handle unavailable"))?;
        let token = process_token(process.as_raw_handle())?;
        if token_u32(&token, TokenIsAppContainer)? != 1 {
            return Err(io::Error::other(
                "Actual protected child token is not an AppContainer",
            ));
        }
        let app = token_data(&token, TokenAppContainerSid)?;
        let app = unsafe { &*app.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>() };
        if app.TokenAppContainer.is_null()
            || unsafe { EqualSid(app.TokenAppContainer, self.sid()) } == 0
        {
            return Err(io::Error::other(
                "Actual child AppContainer SID differs from this attempt",
            ));
        }
        let integrity = token_data(&token, TokenIntegrityLevel)?;
        let label = unsafe { &*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
        if label.Label.Sid.is_null() || unsafe { IsValidSid(label.Label.Sid) } == 0 {
            return Err(io::Error::other("Actual child integrity SID unavailable"));
        }
        let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) };
        if count == 0 {
            return Err(io::Error::other("Actual child integrity label is empty"));
        }
        let rid = unsafe { *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)) };
        if rid > LOW_INTEGRITY_RID {
            return Err(io::Error::other(
                "Protected child integrity exceeds low integrity",
            ));
        }
        let capabilities = token_data(&token, TokenCapabilities)?;
        let capabilities = unsafe { &*capabilities.as_ptr().cast::<TOKEN_GROUPS>() };
        if !expected.matches(capabilities) {
            return Err(io::Error::other(
                "Actual child capabilities differ from the exact requested set",
            ));
        }
        Ok(WindowsSecurityFacts {
            profile_name: self.name.clone(),
            app_container_sid: self.sid.text()?,
            less_privileged: false,
            lpac_proof: "unproven",
            integrity_rid: rid,
            network_capability_count: 0,
            capabilities: expected.names(),
            inherited_stdio_handles: 3,
            strict_job: true,
        })
    }
    pub(super) fn delete(&mut self) -> io::Result<()> {
        if !self.active {
            return Ok(());
        }
        let name = wide(OsStr::new(&self.name))?;
        let code = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        if code != 0 {
            return Err(io::Error::other(format!(
                "Own AppContainer profile cleanup unresolved: {} HRESULT 0x{:08x}",
                self.name, code as u32
            )));
        }
        self.active = false;
        Ok(())
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        // A launched profile is deleted only after verified Job drain. If that
        // cleanup was unknown, preserve the exact profile for explicit recovery.
        if self.active && !self.launched {
            if let Err(error) = self.delete() {
                log::warn!("Unlaunched Windows profile cleanup: {error}");
            }
        } else if self.active {
            log::warn!("Retaining unresolved protected profile {}", self.name);
        }
    }
}

fn process_token(process: HANDLE) -> io::Result<OwnedHandle> {
    let mut token = null_mut();
    win32(
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) },
        "query protected process token",
    )?;
    owned_handle(token, "own protected token handle")
}
fn canary_read_allowed(process: &Option<OwnedHandle>, canary: &OwnedHandle) -> io::Result<bool> {
    let process = process
        .as_ref()
        .ok_or_else(|| io::Error::other("LPAC diagnostic process unavailable"))?;
    let mut primary = null_mut();
    win32(
        unsafe {
            OpenProcessToken(
                process.as_raw_handle(),
                TOKEN_QUERY | TOKEN_DUPLICATE,
                &mut primary,
            )
        },
        "open LPAC diagnostic token",
    )?;
    let primary = owned_handle(primary, "own LPAC diagnostic token")?;
    let mut token = null_mut();
    win32(
        unsafe {
            DuplicateTokenEx(
                primary.as_raw_handle(),
                TOKEN_QUERY,
                null(),
                SecurityImpersonation,
                TokenImpersonation,
                &mut token,
            )
        },
        "duplicate exact child token for kernel access-check",
    )?;
    let token = owned_handle(token, "own diagnostic impersonation token")?;
    let mut descriptor = SavedDacl::read_kind(
        canary,
        DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION,
    )?;
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    let mut privileges = vec![0usize; 128];
    let mut bytes = std::mem::size_of_val(privileges.as_slice()) as u32;
    let mut granted = 0;
    let mut status = -1;
    // Uses a duplicate of this actual child token against the actual held
    // canary descriptor. No thread impersonation and no global ACL change.
    win32(
        unsafe {
            AccessCheck(
                descriptor.descriptor.as_mut_ptr().cast(),
                token.as_raw_handle(),
                FILE_READ_DATA,
                &mapping,
                privileges.as_mut_ptr().cast(),
                &mut bytes,
                &mut granted,
                &mut status,
            )
        },
        "kernel LPAC canary access-check",
    )?;
    if bytes as usize > std::mem::size_of_val(privileges.as_slice())
        || privileges[0] as u32 != 0
        || !matches!(status, 0 | 1)
        || granted != if status == 1 { FILE_READ_DATA } else { 0 }
    {
        return Err(io::Error::other(
            "Kernel LPAC canary access-check returned ambiguous data",
        ));
    }
    Ok(status == 1)
}
fn token_data(token: &OwnedHandle, class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<usize>> {
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut bytes);
    }
    if bytes == 0 || bytes > 65536 {
        return Err(io::Error::other("Unknown token information size"));
    }
    let mut data = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
    win32(
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                class,
                data.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            )
        },
        "read actual protected token",
    )?;
    Ok(data)
}
fn token_u32(token: &OwnedHandle, class: TOKEN_INFORMATION_CLASS) -> io::Result<u32> {
    let mut value = 0;
    let mut size = 0;
    win32(
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                class,
                std::ptr::from_mut(&mut value).cast(),
                4,
                &mut size,
            )
        },
        "read protected token flag",
    )?;
    if size != 4 {
        return Err(io::Error::other("Unknown token flag shape"));
    }
    Ok(value)
}

struct SavedDacl {
    descriptor: Vec<usize>,
    protected: bool,
}
impl SavedDacl {
    fn read(handle: &OwnedHandle) -> io::Result<Self> {
        Self::read_kind(handle, DACL_SECURITY_INFORMATION)
    }
    fn read_kind(handle: &OwnedHandle, kind: u32) -> io::Result<Self> {
        let mut descriptor = null_mut();
        let code = unsafe {
            GetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                kind,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let result = (|| {
            let mut control = 0;
            let mut revision = 0;
            win32(
                unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
                "read original staged security control",
            )?;
            let mut size = unsafe { GetSecurityDescriptorLength(descriptor) };
            if control & SE_SELF_RELATIVE == 0 {
                unsafe {
                    MakeSelfRelativeSD(descriptor, null_mut(), &mut size);
                }
            }
            let size = size as usize;
            if size == 0 || size > 65536 {
                return Err(io::Error::other("Unknown staged security descriptor size"));
            }
            let mut copy = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            if control & SE_SELF_RELATIVE != 0 {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        descriptor.cast::<u8>(),
                        copy.as_mut_ptr().cast(),
                        size,
                    );
                }
            } else {
                let mut bytes = size as u32;
                win32(
                    unsafe { MakeSelfRelativeSD(descriptor, copy.as_mut_ptr().cast(), &mut bytes) },
                    "own staged security descriptor",
                )?;
            }
            Ok(Self {
                descriptor: copy,
                protected: control & SE_DACL_PROTECTED != 0,
            })
        })();
        unsafe {
            LocalFree(descriptor);
        }
        result
    }
    fn acl(&mut self) -> io::Result<*mut ACL> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = null_mut();
        win32(
            unsafe {
                GetSecurityDescriptorDacl(
                    self.descriptor.as_mut_ptr().cast(),
                    &mut present,
                    &mut acl,
                    &mut defaulted,
                )
            },
            "read staged DACL",
        )?;
        if present == 0 {
            return Err(io::Error::other("Staged security descriptor has no DACL"));
        }
        Ok(acl)
    }
    fn restore(&mut self, handle: &OwnedHandle) -> io::Result<()> {
        let flags = DACL_SECURITY_INFORMATION
            | if self.protected {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
        let code = unsafe {
            SetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                flags,
                null_mut(),
                null_mut(),
                self.acl()?,
                null_mut(),
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let mut actual = Self::read(handle)?;
        if actual.protected != self.protected || !same_acl(actual.acl()?, self.acl()?) {
            return Err(io::Error::other(
                "Original staged DACL restoration differs on read-back",
            ));
        }
        Ok(())
    }
    fn label(&mut self) -> io::Result<*mut ACL> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = null_mut();
        win32(
            unsafe {
                GetSecurityDescriptorSacl(
                    self.descriptor.as_mut_ptr().cast(),
                    &mut present,
                    &mut acl,
                    &mut defaulted,
                )
            },
            "read staged integrity label",
        )?;
        Ok(if present == 0 { null_mut() } else { acl })
    }
    fn restore_label(&mut self, handle: &OwnedHandle) -> io::Result<()> {
        let code = unsafe {
            SetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null(),
                self.label()?,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let mut actual = Self::read_kind(handle, LABEL_SECURITY_INFORMATION)?;
        if !same_acl(actual.label()?, self.label()?) {
            return Err(io::Error::other(
                "Original staged integrity label restoration differs on read-back",
            ));
        }
        Ok(())
    }
}
fn same_acl(left: *mut ACL, right: *mut ACL) -> bool {
    if left.is_null() || right.is_null() {
        return left.is_null() && right.is_null();
    }
    // The security-descriptor owners retain both returned ACL allocations.
    unsafe {
        std::slice::from_raw_parts(left.cast::<u8>(), (*left).AclSize as usize)
            == std::slice::from_raw_parts(right.cast::<u8>(), (*right).AclSize as usize)
    }
}

struct GrantedObject {
    handle: Option<OwnedHandle>,
    path: PathBuf,
    identity: (u32, u32, u32),
    expected_acl: Vec<u8>,
    saved: Option<SavedDacl>,
    label: Option<SavedDacl>,
    label_handle: Option<OwnedHandle>,
    applied: bool,
}
impl GrantedObject {
    fn held(&self) -> io::Result<&OwnedHandle> {
        self.handle
            .as_ref()
            .ok_or_else(|| io::Error::other("Writable object is not currently held"))
    }
}
pub(super) struct ProtectedPaths {
    objects: Vec<GrantedObject>,
    _anchor: OwnedHandle,
    _roots: Vec<OwnedHandle>,
    writable_roots: Vec<PathBuf>,
    released: bool,
}
impl ProtectedPaths {
    pub(super) fn grant(staging: &OwnedWindowsStaging, profile: &Profile) -> io::Result<Self> {
        let user = process_token(unsafe { GetCurrentProcess() })?;
        let user_info = token_data(&user, TokenUser)?;
        let user_info = unsafe { &*user_info.as_ptr().cast::<TOKEN_USER>() };
        let user_sid = Sid::copy(user_info.User.Sid)?;
        let system_sid = well_known_sid(WinLocalSystemSid)?;
        let low_sid = well_known_sid(WinLowLabelSid)?;
        let packages_sid = well_known_sid(WinBuiltinAnyPackageSid)?;
        let mut result = Self {
            objects: Vec::new(),
            _anchor: staging.root_anchor.try_clone()?,
            _roots: staging
                .root_anchors
                .iter()
                .map(OwnedHandle::try_clone)
                .collect::<io::Result<_>>()?,
            // `temp` lies inside `home`; listing it again would scan it twice.
            writable_roots: vec![staging.workspace().to_owned(), staging.home().to_owned()],
            released: false,
        };
        // Audit and save every original ACL before modifying any parent. This
        // prevents inherited propagation from contaminating restoration evidence.
        audit_tree(staging.lpac_canary(), false, 0, &mut result.objects)?;
        for (root, writable) in [
            (staging.runtime(), false),
            (staging.workspace(), true),
            (staging.home(), true),
        ] {
            audit_tree(root, writable, 0, &mut result.objects)?;
        }
        for object in result.objects.iter_mut().rev() {
            let info = object_info(object.held()?)?;
            let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            let writable =
                below(&object.path, staging.workspace()) || below(&object.path, staging.home());
            let grant = FILE_GENERIC_READ
                | FILE_GENERIC_EXECUTE
                | if writable {
                    FILE_GENERIC_WRITE | DELETE | if directory { FILE_DELETE_CHILD } else { 0 }
                } else {
                    0
                };
            let flags = if directory {
                CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
            } else {
                0
            };
            let diagnostic = object.path == staging.lpac_canary();
            let trustees = [
                (user_sid.pointer(), FILE_ALL_ACCESS),
                (system_sid.pointer(), FILE_ALL_ACCESS),
                (
                    if diagnostic {
                        packages_sid.pointer()
                    } else {
                        profile.sid()
                    },
                    if diagnostic { FILE_GENERIC_READ } else { grant },
                ),
            ];
            let mut acl = make_acl(&trustees, flags)?;
            let acl_pointer: *mut ACL = acl.as_mut_ptr().cast();
            let size = unsafe { (*acl_pointer).AclSize } as usize;
            object.expected_acl =
                unsafe { std::slice::from_raw_parts(acl_pointer.cast::<u8>(), size) }.to_vec();
            object.applied = true;
            let code = unsafe {
                SetSecurityInfo(
                    object.held()?.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl_pointer,
                    null_mut(),
                )
            };
            if code != 0 {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            if writable {
                // The original owner can audit/replace its DACL without a
                // WRITE_OWNER grant. Open label rights only after our exact DACL
                // grants the host FullControl, retaining that same-object handle.
                let label_handle = open_label_object(&object.path)?;
                let actual = object_info(&label_handle)?;
                if (
                    actual.dwVolumeSerialNumber,
                    actual.nFileIndexHigh,
                    actual.nFileIndexLow,
                ) != object.identity
                {
                    return Err(io::Error::other("Writable label object identity changed"));
                }
                object.label_handle = Some(label_handle);
                let mut label = vec![0usize; 64];
                let label_acl = label.as_mut_ptr().cast::<ACL>();
                win32(
                    unsafe {
                        InitializeAcl(
                            label_acl,
                            std::mem::size_of_val(label.as_slice()) as u32,
                            ACL_REVISION,
                        )
                    },
                    "initialize owned low integrity label",
                )?;
                win32(
                    unsafe {
                        AddMandatoryAce(
                            label_acl,
                            ACL_REVISION,
                            flags,
                            SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
                            low_sid.pointer(),
                        )
                    },
                    "set owned low integrity ACE",
                )?;
                let code = unsafe {
                    SetSecurityInfo(
                        object
                            .label_handle
                            .as_ref()
                            .expect("label handle held")
                            .as_raw_handle(),
                        SE_FILE_OBJECT,
                        LABEL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        null(),
                        label_acl,
                    )
                };
                if code != 0 {
                    return Err(io::Error::from_raw_os_error(code as i32));
                }
            }
        }
        result.verify()?;
        Ok(result)
    }
    pub(super) fn verify(&self) -> io::Result<()> {
        for object in &self.objects {
            let info = object_info(object.held()?)?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
                    && info.nNumberOfLinks != 1)
                || (
                    info.dwVolumeSerialNumber,
                    info.nFileIndexHigh,
                    info.nFileIndexLow,
                ) != object.identity
            {
                return Err(io::Error::other(
                    "Staged object identity/link authority changed",
                ));
            }
            let mut actual = SavedDacl::read(object.held()?)?;
            let acl = actual.acl()?;
            if !actual.protected || acl.is_null() {
                return Err(io::Error::other("Staged DACL is not protected"));
            }
            let bytes =
                unsafe { std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize) };
            if bytes != object.expected_acl {
                return Err(io::Error::other(
                    "Staged DACL differs from exact unique-SID grant",
                ));
            }
            if object.label.is_some() {
                let mut label = SavedDacl::read_kind(object.held()?, LABEL_SECURITY_INFORMATION)?;
                let acl = label.label()?;
                if acl.is_null() || unsafe { (*acl).AceCount } == 0 {
                    return Err(io::Error::other("Owned writable integrity label is absent"));
                }
                for index in 0..unsafe { (*acl).AceCount } {
                    let mut ace = null_mut();
                    win32(
                        unsafe { GetAce(acl, u32::from(index), &mut ace) },
                        "verify owned integrity ACE",
                    )?;
                    let ace = unsafe { &*ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>() };
                    let sid = std::ptr::from_ref(&ace.SidStart).cast_mut().cast();
                    // LABEL_SECURITY_INFORMATION selects mandatory label ACEs.
                    // All returned labels must remain exactly low/no-write-up.
                    let low = well_known_sid(WinLowLabelSid)?;
                    if ace.Header.AceType != 0x11
                        || ace.Mask != SYSTEM_MANDATORY_LABEL_NO_WRITE_UP
                        || unsafe { IsValidSid(sid) } == 0
                        || unsafe { EqualSid(sid, low.pointer()) } == 0
                    {
                        return Err(io::Error::other(
                            "Owned writable integrity label differs from low/no-write-up",
                        ));
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn canary(&self) -> &OwnedHandle {
        self.objects[0]
            .handle
            .as_ref()
            .expect("RX canary stays held")
    }
    pub(super) fn release_writable_children(&mut self) {
        for object in &mut self.objects {
            if self
                .writable_roots
                .iter()
                .any(|root| object.path != *root && below(&object.path, root))
            {
                object.label_handle.take();
                object.handle.take();
            }
        }
        self.released = true;
    }
    fn reacquire_survivors(&mut self) -> io::Result<Vec<GrantedObject>> {
        let mut survivors = Vec::new();
        // Complete scan and retain all handles before changing any ACL/label.
        // A renamed original is matched across all three roots by actual file ID.
        for root in &self.writable_roots {
            audit_tree(root, true, 0, &mut survivors)?;
        }
        let mut identities = std::collections::HashMap::new();
        for (index, object) in survivors.iter().enumerate() {
            if identities.insert(object.identity, index).is_some() {
                return Err(io::Error::other("Duplicate writable survivor identity"));
            }
        }
        // Acquire label handles first, still without mutating any security.
        for object in &mut survivors {
            object.label_handle = Some(open_label_object(&object.path)?);
            let actual = object_info(object.label_handle.as_ref().expect("label survivor held"))?;
            if (
                actual.dwVolumeSerialNumber,
                actual.nFileIndexHigh,
                actual.nFileIndexLow,
            ) != object.identity
            {
                return Err(io::Error::other("Writable survivor label identity changed"));
            }
        }
        for original in &mut self.objects {
            if !self
                .writable_roots
                .iter()
                .any(|root| below(&original.path, root))
            {
                continue;
            }
            if let Some(index) = identities.remove(&original.identity) {
                let survivor = &mut survivors[index];
                original.handle = survivor.handle.take();
                original.label_handle = survivor.label_handle.take();
                original.path = survivor.path.clone();
            } else {
                // Only the complete successful scan proves an original is gone.
                original.handle.take();
                original.label_handle.take();
                original.saved.take();
                original.label.take();
                original.applied = false;
            }
        }
        let mut new_objects = Vec::new();
        for index in identities.into_values() {
            let object = &mut survivors[index];
            if object.saved.as_ref().is_some_and(|saved| saved.protected) {
                return Err(io::Error::other(
                    "New writable object has unexpected protected DACL",
                ));
            }
            new_objects.push(GrantedObject {
                handle: object.handle.take(),
                path: object.path.clone(),
                identity: object.identity,
                expected_acl: Vec::new(),
                saved: None,
                label: None,
                label_handle: object.label_handle.take(),
                applied: false,
            });
        }
        self.objects
            .sort_by_key(|object| object.path.components().count());
        Ok(new_objects)
    }
    pub(super) fn restore(&mut self) -> io::Result<()> {
        // Idempotent: after a complete restore the originals carry their own
        // ACLs again, which need not let the host reopen them for relabeling.
        if self.objects.iter().all(|object| !object.applied) {
            return Ok(());
        }
        let new_objects = if self.released {
            self.reacquire_survivors()?
        } else {
            Vec::new()
        };
        let mut first_error = None;
        // Restore parents before children: unprotected child ACLs/labels inherit
        // the original parent, never the temporary unique-SID grant.
        for object in &mut self.objects {
            if !object.applied {
                continue;
            }
            if let Some(label) = &mut object.label {
                let restored = object
                    .label_handle
                    .as_ref()
                    .map_or(Ok(()), |handle| label.restore_label(handle));
                match restored {
                    Ok(()) => {
                        object.label.take();
                    }
                    Err(error) => {
                        first_error.get_or_insert(error);
                    }
                }
            }
            if let (Some(saved), Some(handle)) = (&mut object.saved, &object.handle) {
                match saved.restore(handle) {
                    Ok(()) => {
                        object.saved.take();
                    }
                    Err(error) => {
                        first_error.get_or_insert(error);
                    }
                }
            }
            if object.saved.is_none() && object.label.is_none() {
                object.applied = false;
            }
        }
        drop(new_objects);
        first_error.map_or(Ok(()), Err)
    }
}
impl Drop for ProtectedPaths {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            log::warn!("Protected staged DACL restoration unresolved: {error}");
        }
    }
}

fn make_acl(trustees: &[(PSID, u32)], flags: u32) -> io::Result<Vec<usize>> {
    let bytes = std::mem::size_of::<ACL>()
        + trustees
            .iter()
            .map(|(sid, _)| 8 + unsafe { GetLengthSid(*sid) } as usize)
            .sum::<usize>();
    let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
    let acl = storage.as_mut_ptr().cast::<ACL>();
    win32(
        unsafe { InitializeAcl(acl, bytes as u32, ACL_REVISION) },
        "initialize exact staged ACL",
    )?;
    for &(sid, mask) in trustees {
        win32(
            unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, flags, mask, sid) },
            "grant exact staged ACL",
        )?;
    }
    Ok(storage)
}

fn audit_tree(
    path: &Path,
    writable: bool,
    depth: usize,
    objects: &mut Vec<GrantedObject>,
) -> io::Result<()> {
    if depth > MAX_DEPTH || objects.len() >= MAX_STAGED_ENTRIES {
        return Err(io::Error::other("Staged path audit exceeds its bound"));
    }
    let path = checked_path(path)?;
    let handle = open_object(&path, writable, true)?;
    let info = object_info(&handle)?;
    let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if !directory && info.nNumberOfLinks != 1 {
        return Err(io::Error::other("Staged extra hard links are refused"));
    }
    let saved = SavedDacl::read(&handle)?;
    let label = if writable {
        Some(SavedDacl::read_kind(&handle, LABEL_SECURITY_INFORMATION)?)
    } else {
        None
    };
    objects.push(GrantedObject {
        handle: Some(handle),
        path: path.clone(),
        identity: (
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ),
        expected_acl: vec![],
        saved: Some(saved),
        label,
        label_handle: None,
        applied: false,
    });
    if directory {
        for entry in fs::read_dir(&path)? {
            audit_tree(&entry?.path(), writable, depth + 1, objects)?;
        }
    }
    Ok(())
}
pub(super) fn open_object(path: &Path, writable: bool, set_acl: bool) -> io::Result<OwnedHandle> {
    open_object_with_sharing(path, writable, set_acl, true)
}
fn open_object_with_sharing(
    path: &Path,
    writable: bool,
    set_acl: bool,
    allow_delete: bool,
) -> io::Result<OwnedHandle> {
    let encoded = wide(path.as_os_str())?;
    let sharing = FILE_SHARE_READ
        | if writable {
            FILE_SHARE_WRITE | if allow_delete { FILE_SHARE_DELETE } else { 0 }
        } else {
            0
        };
    let rights = FILE_READ_ATTRIBUTES | READ_CONTROL | if set_acl { WRITE_DAC } else { 0 };
    let handle = owned_handle(
        unsafe {
            CreateFileW(
                encoded.as_ptr(),
                rights,
                sharing,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        },
        "hold staged object",
    )?;
    let info = object_info(&handle)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("Staged reparse points are refused"));
    }
    Ok(handle)
}
fn open_label_object(path: &Path) -> io::Result<OwnedHandle> {
    let encoded = wide(path.as_os_str())?;
    let handle = owned_handle(
        unsafe {
            CreateFileW(
                encoded.as_ptr(),
                FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_OWNER,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        },
        "hold owned integrity-label object",
    )?;
    if object_info(&handle)?.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other(
            "Owned integrity-label object is a reparse point",
        ));
    }
    Ok(handle)
}
pub(super) fn object_info(handle: &OwnedHandle) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = unsafe { std::mem::zeroed() };
    win32(
        unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) },
        "verify staged object identity",
    )?;
    Ok(info)
}

fn same_os(left: &OsStr, right: &OsStr) -> bool {
    let left: Vec<_> = left.encode_wide().collect();
    let right: Vec<_> = right.encode_wide().collect();
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == CSTR_EQUAL
    }
}
fn below(path: &Path, root: &Path) -> bool {
    let mut path = path.components();
    root.components().all(|part| {
        path.next()
            .is_some_and(|actual| same_os(actual.as_os_str(), part.as_os_str()))
    })
}
fn checked_path(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute()
        || !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(io::Error::other(
            "Protected paths require absolute local disk paths without traversal",
        ));
    }
    let mut prefix = PathBuf::new();
    for component in path.components() {
        prefix.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let encoded = wide(prefix.as_os_str())?;
        let flags = unsafe { GetFileAttributesW(encoded.as_ptr()) };
        if flags == INVALID_FILE_ATTRIBUTES {
            return Err(last_error("inspect protected path component"));
        }
        if flags & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("Protected path traverses a reparse point"));
        }
    }
    let canonical = dunce::canonicalize(path)?;
    if !below(&canonical, path) || !below(path, &canonical) {
        return Err(io::Error::other("Protected path resolves through an alias"));
    }
    Ok(canonical)
}
fn well_known_sid(kind: i32) -> io::Result<Sid> {
    let sid = Sid {
        storage: vec![0; 16],
    };
    let mut bytes = std::mem::size_of_val(sid.storage.as_slice()) as u32;
    win32(
        unsafe { CreateWellKnownSid(kind, null_mut(), sid.pointer(), &mut bytes) },
        "create fixed security SID",
    )?;
    Ok(sid)
}
fn require_ntfs(path: &Path) -> io::Result<()> {
    let root = path
        .ancestors()
        .last()
        .ok_or_else(|| io::Error::other("Protected volume root unavailable"))?;
    let encoded = wide(root.as_os_str())?;
    let mut name = [0u16; 32];
    win32(
        unsafe {
            GetVolumeInformationW(
                encoded.as_ptr(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                null_mut(),
                name.as_mut_ptr(),
                name.len() as u32,
            )
        },
        "verify protected NTFS volume",
    )?;
    let length = name
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| io::Error::other("Unknown protected volume filesystem"))?;
    if String::from_utf16_lossy(&name[..length]) != "NTFS" {
        return Err(io::Error::other("Protected staged grants require NTFS"));
    }
    Ok(())
}
