//! Resident process-tree RAM and Windows dedicated GPU allocation for the displayed adapter.
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub ram_mi_b: Option<f64>,
    pub vram_mi_b: Option<f64>,
    pub pids: Vec<u32>,
    pub sampled_at_ms: u64,
}

#[derive(Clone)]
struct ProcessRow {
    pid: u32,
    parent: Option<u32>,
    resident: u64,
}
#[derive(Clone)]
struct Sample {
    rows: Vec<ProcessRow>,
    gpu: Option<HashMap<(u32, String), u64>>,
    at: u64,
}

fn tree(root: u32, rows: &[ProcessRow]) -> HashSet<u32> {
    let mut pids = HashSet::from([root]);
    loop {
        let previous = pids.len();
        for row in rows {
            if row.parent.is_some_and(|p| pids.contains(&p)) {
                pids.insert(row.pid);
            }
        }
        if previous == pids.len() {
            return pids;
        }
    }
}

fn sample() -> Sample {
    static CACHE: OnceLock<Mutex<Option<(Instant, Sample)>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((at, value)) = cache.as_ref() {
        if at.elapsed() < Duration::from_millis(900) {
            return value.clone();
        }
    }
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    let rows = system
        .processes()
        .iter()
        .map(|(pid, p)| ProcessRow {
            pid: pid.as_u32(),
            parent: p.parent().map(Pid::as_u32),
            resident: p.memory(),
        })
        .collect();
    let value = Sample {
        rows,
        gpu: gpu_counters(),
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    *cache = Some((Instant::now(), value.clone()));
    value
}

pub fn collect(root: u32, gpu_name: &str) -> Option<ProcessMemory> {
    let sample = sample();
    if !sample.rows.iter().any(|p| p.pid == root) {
        return None;
    }
    let pids = tree(root, &sample.rows);
    let ram = sample
        .rows
        .iter()
        .filter(|p| pids.contains(&p.pid))
        .map(|p| p.resident)
        .sum::<u64>();
    let candidates = adapter_luids(gpu_name).unwrap_or_default();
    let vram = sample.gpu.as_ref().and_then(|values| {
        // DXGI may enumerate a stale/virtual duplicate. Resolve only against observed adapters.
        let observed: HashSet<_> = values.keys().map(|(_, luid)| luid).collect();
        let adapters: HashSet<_> = candidates
            .iter()
            .filter(|luid| observed.contains(luid))
            .collect();
        if adapters.len() != 1 {
            return None;
        }
        let luid = *adapters.iter().next()?;
        Some(
            values
                .iter()
                .filter(|((pid, adapter), _)| pids.contains(pid) && adapter == luid)
                .map(|(_, bytes)| *bytes)
                .sum::<u64>(),
        )
    });
    let mut pids: Vec<_> = pids.into_iter().collect();
    pids.sort_unstable();
    Some(ProcessMemory {
        ram_mi_b: Some(ram as f64 / 1048576.0),
        vram_mi_b: vram.map(|v| v as f64 / 1048576.0),
        pids,
        sampled_at_ms: sample.at,
    })
}

fn counter_identity(name: &str) -> Option<(u32, String)> {
    let (pid, rest) = name.strip_prefix("pid_")?.split_once("_luid_")?;
    let adapter = rest.split("_phys_").next()?;
    Some((pid.parse().ok()?, adapter.to_ascii_lowercase()))
}

#[cfg(windows)]
fn system_function(dll: &str, function: &[u8]) -> Option<usize> {
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(
            name: *const u16,
            file: *mut std::ffi::c_void,
            flags: u32,
        ) -> *mut std::ffi::c_void;
        fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8) -> *mut std::ffi::c_void;
    }
    unsafe {
        let name: Vec<u16> = format!("{dll}\0").encode_utf16().collect();
        let module = LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), 0x800);
        if module.is_null() {
            return None;
        }
        let function = GetProcAddress(module, function.as_ptr());
        if function.is_null() {
            None
        } else {
            Some(function as usize)
        }
    }
}

#[cfg(windows)]
#[repr(C)]
struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct Luid {
    low: u32,
    high: i32,
}
#[cfg(windows)]
#[repr(C)]
struct AdapterDesc {
    description: [u16; 128],
    vendor: u32,
    device: u32,
    subsystem: u32,
    revision: u32,
    video: usize,
    system: usize,
    shared: usize,
    luid: Luid,
    flags: u32,
}
#[cfg(windows)]
struct Com(*mut std::ffi::c_void);
#[cfg(windows)]
impl Com {
    unsafe fn method(&self, index: usize) -> usize {
        *(*(self.0 as *const *const usize)).add(index)
    }
}
#[cfg(windows)]
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            let release: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                std::mem::transmute(self.method(2));
            release(self.0);
        }
    }
}

#[cfg(windows)]
fn adapter_luids(name: &str) -> Option<Vec<String>> {
    static CREATE: OnceLock<Option<usize>> = OnceLock::new();
    let create = (*CREATE.get_or_init(|| system_function("dxgi.dll", b"CreateDXGIFactory1\0")))?;
    unsafe {
        let create: unsafe extern "system" fn(*const Guid, *mut *mut std::ffi::c_void) -> i32 =
            std::mem::transmute(create);
        let iid = Guid {
            a: 0x770aae78,
            b: 0xf26f,
            c: 0x4dba,
            d: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87],
        };
        let mut raw = std::ptr::null_mut();
        if create(&iid, &mut raw) < 0 || raw.is_null() {
            return None;
        }
        let factory = Com(raw);
        let enumerate: unsafe extern "system" fn(
            *mut std::ffi::c_void,
            u32,
            *mut *mut std::ffi::c_void,
        ) -> i32 = std::mem::transmute(factory.method(12));
        let mut found = Vec::new();
        for index in 0..32 {
            let mut raw = std::ptr::null_mut();
            if enumerate(factory.0, index, &mut raw) < 0 || raw.is_null() {
                break;
            }
            let adapter = Com(raw);
            let describe: unsafe extern "system" fn(
                *mut std::ffi::c_void,
                *mut AdapterDesc,
            ) -> i32 = std::mem::transmute(adapter.method(10));
            let mut desc: AdapterDesc = std::mem::zeroed();
            if describe(adapter.0, &mut desc) < 0 {
                continue;
            }
            let end = desc.description.iter().position(|v| *v == 0).unwrap_or(128);
            if String::from_utf16_lossy(&desc.description[..end])
                .trim()
                .eq_ignore_ascii_case(name.trim())
            {
                found.push(format!(
                    "0x{:08x}_0x{:08x}",
                    desc.luid.high as u32, desc.luid.low
                ));
            }
        }
        Some(found)
    }
}
#[cfg(not(windows))]
fn adapter_luids(_: &str) -> Option<Vec<String>> {
    None
}

#[cfg(windows)]
#[repr(C)]
struct CounterValue {
    status: u32,
    value: i64,
}
#[cfg(windows)]
#[repr(C)]
struct CounterItem {
    name: *mut u16,
    value: CounterValue,
}
#[cfg(windows)]
fn gpu_counters() -> Option<HashMap<(u32, String), u64>> {
    type Open = unsafe extern "system" fn(*const u16, usize, *mut isize) -> u32;
    type Add = unsafe extern "system" fn(isize, *const u16, usize, *mut isize) -> u32;
    type Collect = unsafe extern "system" fn(isize) -> u32;
    type Read = unsafe extern "system" fn(isize, u32, *mut u32, *mut u32, *mut CounterItem) -> u32;
    type Close = unsafe extern "system" fn(isize) -> u32;
    static API: OnceLock<Option<[usize; 5]>> = OnceLock::new();
    let api = API.get_or_init(|| {
        Some([
            system_function("pdh.dll", b"PdhOpenQueryW\0")?,
            system_function("pdh.dll", b"PdhAddEnglishCounterW\0")?,
            system_function("pdh.dll", b"PdhCollectQueryData\0")?,
            system_function("pdh.dll", b"PdhGetFormattedCounterArrayW\0")?,
            system_function("pdh.dll", b"PdhCloseQuery\0")?,
        ])
    });
    let api = api.as_ref()?;
    struct Query(isize, Close);
    impl Drop for Query {
        fn drop(&mut self) {
            unsafe {
                (self.1)(self.0);
            }
        }
    }
    unsafe {
        let open: Open = std::mem::transmute(api[0]);
        let add: Add = std::mem::transmute(api[1]);
        let collect: Collect = std::mem::transmute(api[2]);
        let read: Read = std::mem::transmute(api[3]);
        let close: Close = std::mem::transmute(api[4]);
        let mut query = 0;
        if open(std::ptr::null(), 0, &mut query) != 0 {
            return None;
        }
        let query = Query(query, close);
        let path: Vec<u16> = "\\GPU Process Memory(*)\\Dedicated Usage\0"
            .encode_utf16()
            .collect();
        let mut counter = 0;
        if add(query.0, path.as_ptr(), 0, &mut counter) != 0 || collect(query.0) != 0 {
            return None;
        }
        for _ in 0..3 {
            let mut bytes = 0;
            let mut count = 0;
            read(counter, 0x400, &mut bytes, &mut count, std::ptr::null_mut());
            if bytes == 0 || bytes > 16_000_000 {
                return None;
            }
            let mut buffer = vec![0u64; (bytes as usize + 7) / 8];
            let items = buffer.as_mut_ptr().cast::<CounterItem>();
            if read(counter, 0x400, &mut bytes, &mut count, items) != 0 {
                continue;
            }
            if count as usize * std::mem::size_of::<CounterItem>() > buffer.len() * 8 {
                return None;
            }
            let mut values = HashMap::new();
            for item in std::slice::from_raw_parts(items, count as usize) {
                if item.value.status > 1 || item.name.is_null() {
                    continue;
                }
                let start = item.name as usize;
                let begin = buffer.as_ptr() as usize;
                let end = begin + buffer.len() * 8;
                if start < begin || start >= end {
                    continue;
                }
                let string = std::slice::from_raw_parts(item.name, (end - start) / 2);
                let Some(length) = string.iter().position(|c| *c == 0) else {
                    continue;
                };
                let Some(identity) = counter_identity(&String::from_utf16_lossy(&string[..length]))
                else {
                    continue;
                };
                if item.value.value >= 0 {
                    *values.entry(identity).or_insert(0u64) += item.value.value as u64;
                }
            }
            return Some(values);
        }
        None
    }
}
#[cfg(not(windows))]
fn gpu_counters() -> Option<HashMap<(u32, String), u64>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn includes_engine_children_and_excludes_other_servers() {
        let rows = vec![
            ProcessRow {
                pid: 1,
                parent: None,
                resident: 10,
            },
            ProcessRow {
                pid: 2,
                parent: Some(1),
                resident: 20,
            },
            ProcessRow {
                pid: 3,
                parent: Some(2),
                resident: 30,
            },
            ProcessRow {
                pid: 4,
                parent: None,
                resident: 90,
            },
        ];
        assert_eq!(tree(1, &rows), HashSet::from([1, 2, 3]));
        assert_eq!(
            counter_identity("pid_30548_luid_0x00000000_0x0001060E_phys_0"),
            Some((30548, "0x00000000_0x0001060e".into()))
        );
        assert!(counter_identity("_Total").is_none());
    }
    #[test]
    fn reads_current_process_without_requiring_gpu_access() {
        let memory = collect(std::process::id(), "Unknown adapter").unwrap();
        assert!(memory.ram_mi_b.unwrap() > 0.0);
        assert_eq!(memory.vram_mi_b, None);
    }
    #[test]
    #[ignore = "read-only measurement of an explicitly selected live model PID"]
    fn live_process_measurement() {
        let pid: u32 = std::env::var("APLOT_MEMORY_TEST_PID")
            .unwrap()
            .parse()
            .unwrap();
        let name = std::env::var("APLOT_MEMORY_TEST_GPU").unwrap();
        let value = collect(pid, &name).unwrap();
        println!("{}", serde_json::to_string(&value).unwrap());
        assert!(value.ram_mi_b.unwrap() > 0.0);
        assert!(value.vram_mi_b.unwrap() > 0.0);
    }
}
