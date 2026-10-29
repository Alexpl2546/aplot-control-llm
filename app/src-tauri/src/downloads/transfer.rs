use super::{huggingface, manager, paths, DownloadFile, DownloadTask};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;

#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after: u64,
}
impl Failure {
    pub fn permanent(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            retry_after: 0,
        }
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            code: "network".into(),
            message: message.into(),
            retryable: true,
            retry_after: 0,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Checkpoint {
    bytes: u64,
    etag: Option<String>,
}

fn checkpoint(path: &std::path::Path, value: &Checkpoint) -> Result<(), Failure> {
    let tmp = path.with_extension("checkpoint.tmp");
    paths::no_links(path).map_err(|e| Failure::permanent("path", e))?;
    paths::no_links(&tmp).map_err(|e| Failure::permanent("path", e))?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| Failure::permanent("disk", e.to_string()))?;
    file.write_all(&serde_json::to_vec(value).unwrap())
        .and_then(|_| file.sync_all())
        .map_err(|e| Failure::permanent("disk", e.to_string()))?;
    drop(file);
    // On Windows rename does not replace a file. Losing this optional checkpoint
    // is safe: resume restarts unless a trusted source digest is available.
    if path.exists() {
        fs::remove_file(path).map_err(|e| Failure::permanent("disk", e.to_string()))?;
    }
    fs::rename(tmp, path).map_err(|e| Failure::permanent("disk", e.to_string()))
}

fn content_range(value: &str, offset: u64, total: u64) -> bool {
    let Some(rest) = value.strip_prefix("bytes ") else {
        return false;
    };
    let Some((range, size)) = rest.split_once('/') else {
        return false;
    };
    let Some((first, last)) = range.split_once('-') else {
        return false;
    };
    first.parse::<u64>() == Ok(offset)
        && size.parse::<u64>() == Ok(total)
        && last
            .parse::<u64>()
            .is_ok_and(|last| last >= offset && last.checked_add(1) == Some(total))
}

pub async fn download(
    app: &AppHandle,
    task: &mut DownloadTask,
    file: &DownloadFile,
    base: u64,
    control: Arc<AtomicU8>,
) -> Result<(), Failure> {
    let url = huggingface::file_url(&task.plan.repo_id, &task.plan.revision, &file.path)
        .map_err(|e| Failure::permanent("source", e))?;
    let client = huggingface::client().map_err(Failure::network)?;
    download_from(Some(app), task, file, base, control, url, client).await
}

async fn download_from(
    app: Option<&AppHandle>,
    task: &mut DownloadTask,
    file: &DownloadFile,
    base: u64,
    control: Arc<AtomicU8>,
    url: reqwest::Url,
    client: reqwest::Client,
) -> Result<(), Failure> {
    let path =
        paths::part_path(&task.plan, &file.path).map_err(|e| Failure::permanent("path", e))?;
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| Failure::permanent("disk", e.to_string()))?;
    paths::no_links(&path).map_err(|e| Failure::permanent("path", e))?;
    let checkpoint_path = path.with_extension("checkpoint.json");
    paths::no_links(&checkpoint_path).map_err(|e| Failure::permanent("path", e))?;
    let saved: Checkpoint = fs::read(&checkpoint_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut offset = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    // Never trust bytes beyond a flushed checkpoint. A missing validator and no
    // authoritative source digest require a fresh request.
    if offset > file.size_bytes || (file.sha256.is_none() && saved.etag.is_none()) {
        offset = 0;
    } else if saved.bytes < offset {
        offset = saved.bytes;
    }
    if offset == file.size_bytes && offset > 0 {
        task.downloaded_bytes = base + offset;
        return Ok(());
    }
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        if let Some(etag) = &saved.etag {
            request = request.header(reqwest::header::IF_RANGE, etag);
        }
    }
    let response = tokio::select! {
        result=request.send()=>result.map_err(|e|Failure::network(e.to_string()))?,
        _=wait_control(control.clone())=>return Err(Failure::permanent("interrupted","Download paused or cancelled")),
    };
    let status = response.status().as_u16();
    if status == 429 || status == 503 {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after)
            .unwrap_or(2)
            .min(300);
        return Err(Failure {
            code: "rate_limit".into(),
            message: format!("Source returned HTTP {status}; retry later"),
            retryable: true,
            retry_after,
        });
    }
    if status == 401 || status == 403 {
        return Err(Failure::permanent("access","Hugging Face access is restricted. Open the repository page. Public repositories only in this release."));
    }
    if status >= 500 {
        return Err(Failure::network(format!("Source returned HTTP {status}")));
    }
    if status == 416 {
        return Err(Failure::permanent("range","Source rejected Range; retry from the retained partial after verifying repository metadata"));
    }
    if status != 200 && status != 206 {
        return Err(Failure::permanent(
            "http",
            format!("Source returned HTTP {status}"),
        ));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|e| !e.starts_with("W/"))
        .map(str::to_string);
    if status == 206 {
        let range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !content_range(range, offset, file.size_bytes) {
            return Err(Failure::permanent(
                "range",
                "Invalid Content-Range from source",
            ));
        }
        if offset > 0 && saved.etag.is_some() && saved.etag != etag {
            return Err(Failure::permanent(
                "validator",
                "Remote file validator changed; remove partial and retry",
            ));
        }
    } else {
        offset = 0;
    }
    let expected = file.size_bytes - offset;
    if response.content_length().is_some_and(|n| n != expected) {
        return Err(Failure::permanent(
            "size",
            "Source Content-Length does not match the pinned file size",
        ));
    }
    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&path)
        .map_err(|e| Failure::permanent("disk", e.to_string()))?;
    output
        .set_len(offset)
        .map_err(|e| Failure::permanent("disk", e.to_string()))?;
    use std::io::{Seek, SeekFrom};
    output
        .seek(SeekFrom::Start(offset))
        .map_err(|e| Failure::permanent("disk", e.to_string()))?;
    let mut response = response;
    let start = Instant::now();
    let initial = offset;
    let mut tick = Instant::now();
    checkpoint(
        &checkpoint_path,
        &Checkpoint {
            bytes: offset,
            etag: etag.clone(),
        },
    )?;
    loop {
        if control.load(Ordering::Acquire) != 0 {
            break;
        }
        let chunk = tokio::select! {
            result=response.chunk()=>result.map_err(|e|Failure::network(e.to_string()))?,
            _=wait_control(control.clone())=>break,
        };
        let Some(chunk) = chunk else { break };
        if offset.saturating_add(chunk.len() as u64) > file.size_bytes {
            return Err(Failure::permanent(
                "size",
                "Source sent more bytes than declared",
            ));
        }
        output.write_all(&chunk).map_err(|e| {
            Failure::permanent(
                "disk",
                format!("Cannot write model (disk full or unavailable): {e}"),
            )
        })?;
        offset += chunk.len() as u64;
        if tick.elapsed() >= Duration::from_millis(250) {
            output
                .sync_data()
                .map_err(|e| Failure::permanent("disk", e.to_string()))?;
            checkpoint(
                &checkpoint_path,
                &Checkpoint {
                    bytes: offset,
                    etag: etag.clone(),
                },
            )?;
            task.downloaded_bytes = base + offset;
            task.speed_bytes_per_second =
                (offset - initial) as f64 / start.elapsed().as_secs_f64().max(0.001);
            if let Some(app) = app {
                manager::publish(app, task)
                    .await
                    .map_err(|e| Failure::permanent("database", e))?;
            }
            tick = Instant::now();
        }
    }
    output
        .sync_all()
        .map_err(|e| Failure::permanent("disk", e.to_string()))?;
    checkpoint(
        &checkpoint_path,
        &Checkpoint {
            bytes: offset,
            etag,
        },
    )?;
    task.downloaded_bytes = base + offset;
    if control.load(Ordering::Acquire) != 0 {
        return Err(Failure::permanent(
            "interrupted",
            "Download paused or cancelled",
        ));
    }
    if offset != file.size_bytes {
        return Err(Failure::network(
            "Connection ended before the complete file was received",
        ));
    }
    Ok(())
}

pub async fn wait_control(control: Arc<AtomicU8>) {
    while control.load(Ordering::Acquire) == 0 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn parse_retry_after(text: &str) -> Option<u64> {
    text.parse().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc2822(text).ok().map(|d| {
            (d.with_timezone(&chrono::Utc) - chrono::Utc::now())
                .num_seconds()
                .max(0) as u64
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener};

    fn server(
        reply: Vec<u8>,
        delay: Duration,
    ) -> (
        reqwest::Url,
        std::sync::mpsc::Receiver<String>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/file", listener.local_addr().unwrap()))
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let join = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while stream.read(&mut byte).unwrap_or(0) > 0 {
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let _ = sender.send(String::from_utf8_lossy(&request).into_owned());
            std::thread::sleep(delay);
            let _ = stream.write_all(&reply);
        });
        (url, receiver, join)
    }

    fn file() -> DownloadFile {
        DownloadFile {
            path: "model.gguf".into(),
            size_bytes: 10,
            sha256: Some("a".repeat(64)),
            local_sha256: None,
            role: "model".into(),
            quantization: None,
        }
    }
    fn partial(task: &DownloadTask, bytes: &[u8]) {
        let path = paths::part_path(&task.plan, "model.gguf").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        checkpoint(
            &path.with_extension("checkpoint.json"),
            &Checkpoint {
                bytes: bytes.len() as u64,
                etag: Some("\"version-one\"".into()),
            },
        )
        .unwrap();
    }
    fn cleanup(task: &DownloadTask) {
        let path = std::path::Path::new(&task.plan.destination);
        assert!(path.starts_with(std::env::temp_dir()));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("aplot-download-"));
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn resumes_206_and_uses_if_range() {
        let mut task = super::super::fixture();
        partial(&task, b"0123");
        let (url,request,join)=server(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 6\r\nContent-Range: bytes 4-9/10\r\nETag: \"version-one\"\r\nConnection: close\r\n\r\n456789".to_vec(),Duration::ZERO);
        download_from(
            None,
            &mut task,
            &file(),
            0,
            Arc::new(AtomicU8::new(0)),
            url,
            reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(paths::part_path(&task.plan, "model.gguf").unwrap()).unwrap(),
            b"0123456789"
        );
        let req = request.recv().unwrap().to_ascii_lowercase();
        assert!(req.contains("range: bytes=4-"));
        assert!(req.contains("if-range: \"version-one\""));
        join.join().unwrap();
        cleanup(&task);
    }

    #[tokio::test]
    async fn ignored_range_restarts_without_appending() {
        let mut task = super::super::fixture();
        partial(&task, b"BAD!");
        let (url,_,join)=server(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"version-two\"\r\nConnection: close\r\n\r\n0123456789".to_vec(),Duration::ZERO);
        download_from(
            None,
            &mut task,
            &file(),
            0,
            Arc::new(AtomicU8::new(0)),
            url,
            reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(paths::part_path(&task.plan, "model.gguf").unwrap()).unwrap(),
            b"0123456789"
        );
        join.join().unwrap();
        cleanup(&task);
    }

    #[tokio::test]
    async fn rejects_bad_ranges_changed_validators_and_416() {
        for (headers,code) in [
            ("206 Partial Content\r\nContent-Length: 6\r\nContent-Range: bytes 3-8/10\r\nETag: \"version-one\"","range"),
            ("206 Partial Content\r\nContent-Length: 6\r\nContent-Range: bytes 4-9/10\r\nETag: \"version-two\"","validator"),
            ("416 Range Not Satisfiable\r\nContent-Length: 0\r\nContent-Range: bytes */10","range"),
        ] {
            let mut task=super::super::fixture();partial(&task,b"0123");
            let (url,_,join)=server(format!("HTTP/1.1 {headers}\r\nConnection: close\r\n\r\n456789").into_bytes(),Duration::ZERO);
            let error=download_from(None,&mut task,&file(),0,Arc::new(AtomicU8::new(0)),url,reqwest::Client::new()).await.unwrap_err();
            assert_eq!(error.code,code);assert!(!error.retryable);
            assert_eq!(fs::read(paths::part_path(&task.plan,"model.gguf").unwrap()).unwrap(),b"0123");
            join.join().unwrap();cleanup(&task);
        }
    }

    #[tokio::test]
    async fn handles_rate_limit_cutoff_timeout_and_access() {
        for (reply, delay, code, retry) in [
            (
                "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nRetry-After: 7\r\n\r\n",
                0,
                "rate_limit",
                true,
            ),
            (
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
                0,
                "access",
                false,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc",
                0,
                "network",
                true,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789",
                200,
                "network",
                true,
            ),
        ] {
            let mut task = super::super::fixture();
            let (url, _, join) = server(reply.as_bytes().to_vec(), Duration::from_millis(delay));
            let client = reqwest::Client::builder()
                .read_timeout(Duration::from_millis(70))
                .build()
                .unwrap();
            let error = download_from(
                None,
                &mut task,
                &file(),
                0,
                Arc::new(AtomicU8::new(0)),
                url,
                client,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.retryable, retry);
            if code == "rate_limit" {
                assert_eq!(error.retry_after, 7);
            }
            join.join().unwrap();
            cleanup(&task);
        }
    }

    #[tokio::test]
    async fn checkpoint_limits_recovery_and_pause_preserves_files() {
        let mut task = super::super::fixture();
        partial(&task, b"0123");
        let path = paths::part_path(&task.plan, "model.gguf").unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"UNFLUSHED")
            .unwrap();
        // Invalid size (over expected) deliberately starts fresh, never trusts it.
        let (url, request, join) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789".to_vec(),
            Duration::ZERO,
        );
        download_from(
            None,
            &mut task,
            &file(),
            0,
            Arc::new(AtomicU8::new(0)),
            url,
            reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert!(!request
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("range:"));
        join.join().unwrap();
        cleanup(&task);

        let mut task = super::super::fixture();
        let control = Arc::new(AtomicU8::new(0));
        let cancel = control.clone();
        let (url, _, join) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789".to_vec(),
            Duration::from_millis(250),
        );
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            cancel.store(1, Ordering::Release);
        });
        let result = download_from(
            None,
            &mut task,
            &file(),
            0,
            control,
            url,
            reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(result.code, "interrupted");
        assert!(!std::path::Path::new(&task.plan.final_path).exists());
        join.join().unwrap();
        cleanup(&task);
    }

    #[tokio::test]
    async fn refuses_non_https_redirect() {
        let mut task = super::super::fixture();
        let (url,_,join)=server(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\n\r\n".to_vec(),Duration::ZERO);
        assert!(download_from(
            None,
            &mut task,
            &file(),
            0,
            Arc::new(AtomicU8::new(0)),
            url,
            huggingface::client().unwrap()
        )
        .await
        .is_err());
        join.join().unwrap();
        cleanup(&task);
    }
    #[tokio::test]
    #[ignore = "Manual Windows/network acceptance; never required by offline unit tests"]
    async fn live_huggingface_complete_set_with_range_and_installation() {
        let mode = std::env::var("APLOT_LIVE_DOWNLOAD").unwrap_or_else(|_| "tiny".into());
        let source = "https://huggingface.co/ggml-org/models-moved";
        let resolved = huggingface::resolve(source, None).await.unwrap();
        let wanted = match mode.as_str() {
            "split" => "tinyllamas/split/stories15M-q8_0-00001-of-00003.gguf",
            "large" => "mistral-7b-v0.2-iq3_s-imat.gguf",
            "tiny" => "tinyllamas/stories260K.gguf",
            other => panic!("Unknown APLOT_LIVE_DOWNLOAD mode: {other}"),
        };
        let files = huggingface::select(
            &resolved,
            &super::super::DownloadSelection {
                vision_only: false,
                source: source.into(),
                revision: resolved.revision.clone(),
                files: vec![wanted.into()],
            },
        )
        .unwrap();
        let mut task = super::super::fixture();
        task.plan.source = source.into();
        task.plan.repo_id = resolved.repo_id.clone();
        task.plan.revision = resolved.revision;
        task.plan.files = files.clone();
        task.total_bytes = files.iter().map(|f| f.size_bytes).sum();
        task.plan.total_bytes = task.total_bytes;
        println!(
            "Live {mode}: {} files, {} bytes, pinned {}",
            files.len(),
            task.total_bytes,
            task.plan.revision
        );
        println!("Isolated live fixture: {}", task.plan.destination);
        let transfer_started = Instant::now();
        let mut base = 0;
        for file in &files {
            let url =
                huggingface::file_url(&task.plan.repo_id, &task.plan.revision, &file.path).unwrap();
            let mut response = huggingface::client()
                .unwrap()
                .get(url.clone())
                .header("Range", "bytes=0-65535")
                .header("Accept-Encoding", "identity")
                .send()
                .await
                .unwrap();
            let etag = response
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let mut prefix = Vec::new();
            while prefix.len() < 65536 {
                let Some(chunk) = response.chunk().await.unwrap() else {
                    break;
                };
                prefix.extend_from_slice(&chunk[..chunk.len().min(65536 - prefix.len())]);
            }
            drop(response);
            let path = paths::part_path(&task.plan, &file.path).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &prefix).unwrap();
            checkpoint(
                &path.with_extension("checkpoint.json"),
                &Checkpoint {
                    bytes: prefix.len() as u64,
                    etag,
                },
            )
            .unwrap();
            download_from(
                None,
                &mut task,
                file,
                base,
                Arc::new(AtomicU8::new(0)),
                url,
                huggingface::client().unwrap(),
            )
            .await
            .unwrap();
            let hash = super::super::install::verify(&path, file, &AtomicU8::new(0)).unwrap();
            assert_eq!(Some(hash.clone()), file.sha256);
            println!("Source SHA-256 verified: {} {hash}", file.path);
            task.plan
                .files
                .iter_mut()
                .find(|f| f.path == file.path)
                .unwrap()
                .local_sha256 = Some(hash);
            base += file.size_bytes;
        }
        println!(
            "Transfer and initial verification: {:?}, average {:.2} MiB/s",
            transfer_started.elapsed(),
            task.total_bytes as f64 / 1048576.0 / transfer_started.elapsed().as_secs_f64()
        );
        task.state = "installing".into();
        let start = Instant::now();
        super::super::install::publish_set(&task).unwrap();
        assert!(super::super::install::recover(&mut task).unwrap());
        assert_eq!(task.state, "completed");
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        super::super::repository::init_schema(&conn).unwrap();
        super::super::repository::save(&mut conn, &task).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM model_installations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        println!("Verified and published {} bytes; recovery+registration {:?}; engine support remains separate",task.total_bytes,start.elapsed());
        cleanup(&task);
    }

    #[test]
    fn range_is_exact_and_bounded() {
        assert!(content_range("bytes 10-99/100", 10, 100));
        for s in [
            "bytes 0-99/100",
            "bytes 10-100/100",
            "bytes 10-99/*",
            "bytes 10-99/101",
            "items 10-99/100",
        ] {
            assert!(!content_range(s, 10, 100), "{s}");
        }
    }

    #[tokio::test]
    #[ignore = "Bounded live probe of a multi-GB Hub file; no complete model is published"]
    async fn live_large_gguf_range_probe_is_streamed_and_cancellable() {
        let resolved = huggingface::resolve("ggml-org/models-moved", None)
            .await
            .unwrap();
        let file = resolved
            .files
            .iter()
            .find(|file| file.path == "mistral-7b-v0.2-iq3_s-imat.gguf")
            .unwrap()
            .clone();
        assert!(file.size_bytes > 3_000_000_000);
        let mut task = super::super::fixture();
        task.plan.repo_id = resolved.repo_id;
        task.plan.revision = resolved.revision;
        let path = paths::part_path(&task.plan, &file.path).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let url =
            huggingface::file_url(&task.plan.repo_id, &task.plan.revision, &file.path).unwrap();
        let mut response = huggingface::client()
            .unwrap()
            .get(url.clone())
            .header("Range", "bytes=0-65535")
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        let etag = response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let mut prefix = Vec::new();
        while prefix.len() < 65536 {
            let Some(chunk) = response.chunk().await.unwrap() else {
                break;
            };
            prefix.extend_from_slice(&chunk[..chunk.len().min(65536 - prefix.len())]);
        }
        assert!(prefix.starts_with(b"GGUF"));
        drop(response);
        fs::write(&path, &prefix).unwrap();
        checkpoint(
            &path.with_extension("checkpoint.json"),
            &Checkpoint {
                bytes: prefix.len() as u64,
                etag,
            },
        )
        .unwrap();
        let control = Arc::new(AtomicU8::new(0));
        let cancel = control.clone();
        let watched = path.clone();
        let watcher = tokio::spawn(async move {
            loop {
                if fs::metadata(&watched).is_ok_and(|meta| meta.len() >= 4 * 1024 * 1024) {
                    cancel.store(1, Ordering::Release);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let began = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(45),
            download_from(
                None,
                &mut task,
                &file,
                0,
                control,
                url,
                huggingface::client().unwrap(),
            ),
        )
        .await;
        watcher.abort();
        let error = result.expect("large file probe timed out").unwrap_err();
        assert_eq!(error.code, "interrupted");
        let retained = fs::metadata(&path).unwrap().len();
        assert!(retained >= 4 * 1024 * 1024 && retained < file.size_bytes);
        let saved: Checkpoint =
            serde_json::from_slice(&fs::read(path.with_extension("checkpoint.json")).unwrap())
                .unwrap();
        assert_eq!(saved.bytes, retained);
        assert!(!std::path::Path::new(&task.plan.final_path).exists());
        println!("Large GGUF probe: declared={}, checkpoint={}, elapsed={:?}; not fully downloaded or source-hash verified",file.size_bytes,retained,began.elapsed());
        cleanup(&task);
    }
    #[test]
    fn retry_seconds_and_dates() {
        assert_eq!(parse_retry_after("3"), Some(3));
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 +0000"),
            Some(0)
        );
    }
}
