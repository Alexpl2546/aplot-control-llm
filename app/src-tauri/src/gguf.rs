use serde_json::{Map, Value};
use std::{
    fs::File,
    io::{self, BufReader, Read},
    path::Path,
};

const MAX_STRING: u64 = 16 * 1024 * 1024;
const MAX_ARRAY_CAPTURE: u64 = 64;
const UNSUPPORTED_TYPE_PREFIX: &str = "Unsupported GGUF metadata type ";

fn read_exact<const N: usize>(r: &mut impl Read) -> io::Result<[u8; N]> {
    let mut b = [0u8; N];
    r.read_exact(&mut b)?;
    Ok(b)
}
fn u8v(r: &mut impl Read) -> io::Result<u8> {
    Ok(read_exact::<1>(r)?[0])
}
fn i8v(r: &mut impl Read) -> io::Result<i8> {
    Ok(u8v(r)? as i8)
}
fn u16v(r: &mut impl Read) -> io::Result<u16> {
    Ok(u16::from_le_bytes(read_exact(r)?))
}
fn i16v(r: &mut impl Read) -> io::Result<i16> {
    Ok(i16::from_le_bytes(read_exact(r)?))
}
fn u32v(r: &mut impl Read) -> io::Result<u32> {
    Ok(u32::from_le_bytes(read_exact(r)?))
}
fn i32v(r: &mut impl Read) -> io::Result<i32> {
    Ok(i32::from_le_bytes(read_exact(r)?))
}
fn u64v(r: &mut impl Read) -> io::Result<u64> {
    Ok(u64::from_le_bytes(read_exact(r)?))
}
fn i64v(r: &mut impl Read) -> io::Result<i64> {
    Ok(i64::from_le_bytes(read_exact(r)?))
}
fn f32v(r: &mut impl Read) -> io::Result<f32> {
    Ok(f32::from_le_bytes(read_exact(r)?))
}
fn f64v(r: &mut impl Read) -> io::Result<f64> {
    Ok(f64::from_le_bytes(read_exact(r)?))
}
fn string(r: &mut impl Read) -> io::Result<String> {
    let n = u64v(r)?;
    if n > MAX_STRING {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "GGUF string is too large",
        ));
    }
    let mut b = vec![0; n as usize];
    r.read_exact(&mut b)?;
    String::from_utf8(b).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn value(r: &mut impl Read, ty: u32, capture: bool) -> io::Result<Value> {
    Ok(match ty {
        0 => Value::from(u8v(r)?),
        1 => Value::from(i8v(r)?),
        2 => Value::from(u16v(r)?),
        3 => Value::from(i16v(r)?),
        4 => Value::from(u32v(r)?),
        5 => Value::from(i32v(r)?),
        6 => Value::from(f32v(r)?),
        7 => Value::Bool(u8v(r)? != 0),
        8 => Value::String(string(r)?),
        10 => Value::from(u64v(r)?),
        11 => Value::from(i64v(r)?),
        12 => Value::from(f64v(r)?),
        9 => {
            let item_ty = u32v(r)?;
            let count = u64v(r)?;
            if capture && count <= MAX_ARRAY_CAPTURE {
                let mut out = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    out.push(value(r, item_ty, true)?)
                }
                Value::Array(out)
            } else {
                for _ in 0..count {
                    let _ = value(r, item_ty, false)?;
                }
                Value::Null
            }
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{UNSUPPORTED_TYPE_PREFIX}{ty}"),
            ))
        }
    })
}

pub fn read_metadata(path: &Path) -> Result<Map<String, Value>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(file);
    let magic = read_exact::<4>(&mut r).map_err(|e| e.to_string())?;
    if &magic != b"GGUF" {
        return Err("Not a GGUF file".into());
    }
    let version = u32v(&mut r).map_err(|e| e.to_string())?;
    if !(2..=3).contains(&version) {
        return Err(format!("Unsupported GGUF version {version}"));
    }
    let _tensor_count = u64v(&mut r).map_err(|e| e.to_string())?;
    let kv_count = u64v(&mut r).map_err(|e| e.to_string())?;
    if kv_count > 100_000 {
        return Err("Unreasonable GGUF metadata count".into());
    }
    let mut out = Map::new();
    for _ in 0..kv_count {
        let key = string(&mut r).map_err(|e| e.to_string())?;
        let ty = u32v(&mut r).map_err(|e| e.to_string())?;
        let capture = key.starts_with("general.")
            || key.starts_with("split.")
            || key.ends_with(".context_length")
            || key.ends_with(".block_count")
            || key.ends_with(".embedding_length")
            || key.ends_with(".attention.head_count")
            || key.ends_with(".attention.head_count_kv");
        let v = match value(&mut r, ty, capture) {
            Ok(value) => value,
            // GGUF metadata types can grow over time. The value length of an
            // unknown type cannot be skipped safely, so return metadata parsed
            // before it instead of failing the entire model scan.
            Err(error)
                if error.kind() == io::ErrorKind::InvalidData
                    && error.to_string().starts_with(UNSUPPORTED_TYPE_PREFIX) =>
            {
                return Ok(out);
            }
            Err(error) => return Err(error.to_string()),
        };
        if capture {
            out.insert(key, v);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn put_string(bytes: &mut Vec<u8>, value: &str) {
        bytes.extend((value.len() as u64).to_le_bytes());
        bytes.extend(value.as_bytes());
    }

    fn fixture(entries: &[(&str, u32, &[u8])]) -> Vec<u8> {
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        bytes.extend((entries.len() as u64).to_le_bytes());
        for (key, ty, value) in entries {
            put_string(&mut bytes, key);
            bytes.extend(ty.to_le_bytes());
            bytes.extend(*value);
        }
        bytes
    }

    fn with_fixture<T>(bytes: &[u8], read: impl FnOnce(&Path) -> T) -> T {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "llama-control-gguf-{}-{stamp}.gguf",
            std::process::id()
        ));
        fs::write(&path, bytes).expect("write temporary GGUF fixture");
        let result = read(&path);
        let _ = fs::remove_file(path);
        result
    }

    #[test]
    fn constants_are_reasonable() {
        assert!(MAX_STRING > 1024);
        assert!(MAX_ARRAY_CAPTURE > 0);
    }

    #[test]
    fn reads_common_model_metadata_from_a_streamed_file() {
        let architecture = b"llama";
        let parameter_count = 7_000_000_000u64.to_le_bytes();
        let bytes = fixture(&[
            (
                "general.architecture",
                8,
                &[&5u64.to_le_bytes()[..], architecture].concat(),
            ),
            ("general.parameter_count", 10, &parameter_count),
        ]);

        let metadata = with_fixture(&bytes, |path| read_metadata(path).expect("valid GGUF"));
        assert_eq!(metadata["general.architecture"], "llama");
        assert_eq!(metadata["general.parameter_count"], 7_000_000_000u64);
    }

    #[test]
    fn preserves_metadata_before_an_unknown_type() {
        let architecture = [&5u64.to_le_bytes()[..], b"llama"].concat();
        let bytes = fixture(&[
            ("general.architecture", 8, &architecture),
            ("general.name", 127, &[]),
        ]);

        let metadata = with_fixture(&bytes, |path| {
            read_metadata(path).expect("partial metadata")
        });
        assert_eq!(metadata["general.architecture"], "llama");
        assert!(!metadata.contains_key("general.name"));
    }
}
