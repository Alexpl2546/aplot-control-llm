//! A job belongs to one runtime; closing it cannot kill unrelated CLI sessions.
#[cfg(windows)]
pub(crate) struct OwnedJob(isize);
#[cfg(windows)]
impl OwnedJob {
    pub fn assign(child: &tokio::process::Child) -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "Cannot create runtime job: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let Some(process) = child.raw_handle() else {
                CloseHandle(job);
                return Err("The runtime process handle is already closed".into());
            };
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, process as _) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(format!("Cannot assign runtime to its job: {error}"));
            }
            Ok(Self(job as isize))
        }
    }
    pub fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 as _, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for OwnedJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}
#[cfg(not(windows))]
pub(crate) struct OwnedJob;
#[cfg(not(windows))]
impl OwnedJob {
    pub fn assign(_: &tokio::process::Child) -> Result<Self, String> {
        Ok(Self)
    }
    pub fn terminate(&self) {}
}
