//! Real process acceptance: no desktop/Tauri host is involved.
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_aplotd"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct TestDirectory(PathBuf);
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn standalone_binary_serves_and_releases_exclusive_data_ownership() {
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("aplot-process-test-{}", uuid::Uuid::new_v4())),
    );
    let mut process = Process(
        command()
            .arg("--data-dir")
            .arg(&directory.0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let output = process.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(output).read_line(&mut line).map(|_| line);
        let _ = send.send(result);
    });
    let line = receive
        .recv_timeout(Duration::from_secs(15))
        .expect("server startup timed out")
        .unwrap();
    let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["server"]["capabilities"]["taskExecution"], false);
    let address = ready["address"].as_str().unwrap();
    let mut stream =
        TcpStream::connect_timeout(&address.parse().unwrap(), Duration::from_secs(5)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("\"status\":\"ok\""));
    let duplicate = command()
        .arg("--data-dir")
        .arg(&directory.0)
        .arg("--check")
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("server-data-already-owned"));
    drop(process);
    let inspection = command()
        .arg("--data-dir")
        .arg(&directory.0)
        .arg("--check")
        .output()
        .unwrap();
    assert!(inspection.status.success());
    let info: serde_json::Value = serde_json::from_slice(&inspection.stdout).unwrap();
    assert_eq!(info["serverId"], ready["server"]["serverId"]);
    assert!(!directory.0.join("llama-control.sqlite3").exists());
}
