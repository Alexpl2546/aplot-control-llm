use serde::{Deserialize, Serialize};
use std::process::Command;
use sysinfo::{Components, System};

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuSnapshot {
    pub name: String,
    pub utilization: f32,
    pub memory_used_mi_b: f32,
    pub memory_total_mi_b: f32,
    pub temperature_c: f32,
    pub power_w: Option<f32>,
    pub power_limit_w: Option<f32>,
    pub power_reading: Option<&'static str>,
    pub clock_m_hz: f32,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSnapshot {
    pub cpu_name: String,
    pub cpu_utilization: f32,
    pub cpu_threads: usize,
    pub cpu_clock_m_hz: f32,
    pub cpu_temperature_c: Option<f32>,
    pub memory_used_mi_b: u64,
    pub memory_total_mi_b: u64,
    pub memory_modules: Vec<MemoryModule>,
    pub gpu: Option<GpuSnapshot>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryModule {
    pub manufacturer: Option<String>,
    pub part_number: Option<String>,
    pub capacity_mi_b: u64,
    pub memory_type: Option<String>,
    pub speed_mtps: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PhysicalMemory {
    manufacturer: Option<String>,
    part_number: Option<String>,
    capacity: u64,
    speed: Option<u32>,
    configured_clock_speed: Option<u32>,
    #[serde(rename = "SMBIOSMemoryType")]
    memory_type: Option<u32>,
}

fn memory_label(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string()).filter(|s| {
        !s.is_empty()
            && ![
                "unknown",
                "not specified",
                "default string",
                "to be filled by o.e.m.",
            ]
            .contains(&s.to_ascii_lowercase().as_str())
    })
}

fn parse_memory_modules(json: &[u8]) -> Vec<MemoryModule> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let rows = match value {
        serde_json::Value::Array(rows) => rows,
        serde_json::Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };
    rows.into_iter()
        .filter_map(|row| {
            let memory: PhysicalMemory = serde_json::from_value(row).ok()?;
            if memory.capacity == 0 {
                return None;
            }
            Some(MemoryModule {
                manufacturer: memory_label(memory.manufacturer),
                part_number: memory_label(memory.part_number),
                capacity_mi_b: memory.capacity / 1024 / 1024,
                memory_type: match memory.memory_type {
                    Some(24) => Some("DDR3".into()),
                    Some(26) => Some("DDR4".into()),
                    Some(34) => Some("DDR5".into()),
                    _ => None,
                },
                speed_mtps: memory
                    .configured_clock_speed
                    .filter(|s| *s > 0)
                    .or(memory.speed.filter(|s| *s > 0)),
            })
        })
        .collect()
}

#[cfg(windows)]
fn query_memory_modules() -> Vec<MemoryModule> {
    use std::{
        os::windows::process::CommandExt,
        process::Stdio,
        time::{Duration, Instant},
    };
    let script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_PhysicalMemory -OperationTimeoutSec 5 | Select-Object Manufacturer,PartNumber,Capacity,Speed,ConfiguredClockSpeed,SMBIOSMemoryType) | ConvertTo-Json -Compress";
    let Ok(mut child) = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .creation_flags(0x08000000)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
        }
    }
    child
        .wait_with_output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_memory_modules(&output.stdout))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn query_memory_modules() -> Vec<MemoryModule> {
    Vec::new()
}

fn installed_memory_modules() -> Vec<MemoryModule> {
    // Hardware identity does not change while the application runs. Do not run CIM every poll.
    static MODULES: std::sync::OnceLock<Vec<MemoryModule>> = std::sync::OnceLock::new();
    MODULES.get_or_init(query_memory_modules).clone()
}

fn parse_num(parts: &[&str], i: usize) -> Option<f32> {
    parts
        .get(i)?
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|v| v.is_finite())
}
fn nvidia_query(fields: &str) -> Option<String> {
    let mut command = Command::new("nvidia-smi");
    command.args([
        format!("--query-gpu={fields}"),
        "--format=csv,noheader,nounits".into(),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}
fn parse_nvidia_snapshot(text: &str) -> Option<GpuSnapshot> {
    let row = text.lines().next()?;
    let p: Vec<_> = row.split(',').collect();
    if p.len() < 8 {
        return None;
    }
    let nonnegative = |index| parse_num(&p, index).filter(|value| *value >= 0.0);
    // Ampere's power.draw is a one-second average. Prefer the explicit instant
    // reading, but keep supported older drivers and unavailable mobile sensors.
    let (power_w, power_reading) = if let Some(value) = nonnegative(8) {
        (Some(value), Some("instant"))
    } else if let Some(value) = nonnegative(9) {
        (Some(value), Some("average"))
    } else {
        (nonnegative(5), nonnegative(5).map(|_| "reported"))
    };
    // A requested, default or maximum ceiling is not the enforced current limit.
    // Legacy drivers expose only the requested value; do not invent a 0 W limit.
    let power_limit_w = nonnegative(10).filter(|value| *value > 0.0);
    Some(GpuSnapshot {
        name: p[0].trim().into(),
        utilization: parse_num(&p, 1)?,
        memory_used_mi_b: parse_num(&p, 2)?,
        memory_total_mi_b: parse_num(&p, 3)?,
        temperature_c: parse_num(&p, 4)?,
        power_w,
        power_limit_w,
        power_reading,
        clock_m_hz: parse_num(&p, 7).unwrap_or(0.0),
    })
}
fn nvidia_snapshot() -> Option<GpuSnapshot> {
    const BASE: &str = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,clocks.sm";
    nvidia_query(&format!(
        "{BASE},power.draw.instant,power.draw.average,enforced.power.limit"
    ))
    .or_else(|| nvidia_query(BASE))
    .and_then(|text| parse_nvidia_snapshot(&text))
}
fn cpu_temperature() -> Option<f32> {
    let components = Components::new_with_refreshed_list();
    components
        .iter()
        .filter(|c| {
            let l = c.label().to_ascii_lowercase();
            l.contains("cpu") || l.contains("package") || l.contains("tctl")
        })
        .filter_map(|c| c.temperature())
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

pub fn collect_hardware() -> HardwareSnapshot {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<Option<(std::time::Instant, HardwareSnapshot)>>,
    > = std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((at, value)) = cache.as_ref() {
        if at.elapsed() < std::time::Duration::from_millis(750) {
            return value.clone();
        }
    }
    let value = collect_hardware_uncached();
    *cache = Some((std::time::Instant::now(), value.clone()));
    value
}
fn collect_hardware_uncached() -> HardwareSnapshot {
    static SYSTEM: std::sync::OnceLock<std::sync::Mutex<System>> = std::sync::OnceLock::new();
    let mut sys = SYSTEM
        .get_or_init(|| std::sync::Mutex::new(System::new_all()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let cpus = sys.cpus();
    let utilization = if cpus.is_empty() {
        0.0
    } else {
        cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
    };
    let clock = if cpus.is_empty() {
        0.0
    } else {
        cpus.iter().map(|c| c.frequency() as f32).sum::<f32>() / cpus.len() as f32
    };
    HardwareSnapshot {
        cpu_name: cpus
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "Unknown CPU".into()),
        cpu_utilization: utilization,
        cpu_threads: cpus.len(),
        cpu_clock_m_hz: clock,
        cpu_temperature_c: cpu_temperature(),
        memory_used_mi_b: sys.used_memory() / 1024 / 1024,
        memory_total_mi_b: sys.total_memory() / 1024 / 1024,
        memory_modules: installed_memory_modules(),
        gpu: nvidia_snapshot(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_instant_power_is_separate_from_average_and_limit() {
        let gpu = parse_nvidia_snapshot("NVIDIA GeForce RTX 3070 Ti Laptop GPU, 12, 2048, 8192, 61, 38.29, 150, 1400, 131.00, 38.29, 130.00").unwrap();
        assert_eq!(gpu.power_w, Some(131.0));
        assert_eq!(gpu.power_reading, Some("instant"));
        assert_eq!(gpu.power_limit_w, Some(130.0));
        assert_eq!(gpu.name, "NVIDIA GeForce RTX 3070 Ti Laptop GPU");
    }

    #[test]
    fn gpu_unavailable_mobile_limit_is_not_zero_or_an_invented_tgp() {
        let gpu = parse_nvidia_snapshot(
            "NVIDIA Laptop GPU, 12, 2048, 8192, 61, 38.29, [N/A], 1400, [Not Supported], 38.29, 0",
        )
        .unwrap();
        assert_eq!(gpu.power_w, Some(38.29));
        assert_eq!(gpu.power_reading, Some("average"));
        assert_eq!(gpu.power_limit_w, None);
        let gpu = parse_nvidia_snapshot(
            "NVIDIA GPU, 0, 0, 8192, 30, [N/A], 150, 100, NaN, -1, [Not Supported]",
        )
        .unwrap();
        assert_eq!(gpu.power_w, None);
        assert_eq!(gpu.power_reading, None);
        assert_eq!(gpu.power_limit_w, None);
        let json = serde_json::to_value(gpu).unwrap();
        assert!(json["powerW"].is_null());
        assert!(json["powerLimitW"].is_null());
    }

    #[test]
    fn legacy_driver_power_remains_supported_and_zero_draw_is_valid() {
        let gpu = parse_nvidia_snapshot("NVIDIA GPU, 0, 0, 8192, 30, 0.00, 150, 100").unwrap();
        assert_eq!(gpu.power_w, Some(0.0));
        assert_eq!(gpu.power_reading, Some("reported"));
        assert_eq!(gpu.power_limit_w, None);
    }

    #[test]
    fn installed_memory_uses_configured_speed_and_clean_identity() {
        let modules = parse_memory_modules(br#"[{"Manufacturer":"Unknown","PartNumber":"F5-6400J3239G32G   ","Capacity":34359738368,"Speed":7200,"ConfiguredClockSpeed":6400,"SMBIOSMemoryType":34}]"#);
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].manufacturer, None);
        assert_eq!(modules[0].part_number.as_deref(), Some("F5-6400J3239G32G"));
        assert_eq!(modules[0].capacity_mi_b, 32768);
        assert_eq!(modules[0].speed_mtps, Some(6400));
        assert_eq!(modules[0].memory_type.as_deref(), Some("DDR5"));
    }

    #[test]
    fn memory_query_tolerates_singletons_and_partial_or_failed_cim() {
        let modules = parse_memory_modules(br#"{"Capacity":8589934592,"ConfiguredClockSpeed":0,"Speed":3200,"SMBIOSMemoryType":0}"#);
        assert_eq!(modules[0].capacity_mi_b, 8192);
        assert_eq!(modules[0].speed_mtps, Some(3200));
        assert_eq!(modules[0].memory_type, None);
        for value in [
            b"null".as_slice(),
            b"[]",
            b"invalid",
            br#"[{"Capacity":0},{"Capacity":"bad"}]"#,
        ] {
            assert!(parse_memory_modules(value).is_empty());
        }
    }
}
#[tauri::command]
pub async fn hardware_snapshot() -> Result<HardwareSnapshot, String> {
    tokio::task::spawn_blocking(collect_hardware)
        .await
        .map_err(|e| e.to_string())
}
