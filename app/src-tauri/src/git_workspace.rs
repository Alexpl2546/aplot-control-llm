//! Read-only Git status and diff previews for an agent task's project.
//!
//! The renderer sends a task ID, never a working directory. Relative paths used
//! for diff requests are revalidated against the current porcelain status.
use crate::{agent_workspace, db::DbState};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::State;

const MAX_STATUS_BYTES: usize = 2_000_000;
const MAX_FILES: usize = 300;
const MAX_DIFF_BYTES: usize = 128_000;
const MAX_PREVIEW_FILE_BYTES: usize = 64_000;
const MAX_PREVIEW_LINES: usize = 2_000;
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const DIFF_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitWorkspaceState {
    Ready,
    NotRepository,
    GitMissing,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    pub diffable: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceStatus {
    pub state: GitWorkspaceState,
    pub branch: Option<String>,
    pub files: Vec<GitChangedFile>,
    pub truncated: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSection {
    pub text: String,
    pub truncated: bool,
    pub notice: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceDiff {
    pub path: String,
    pub staged: GitDiffSection,
    pub unstaged: GitDiffSection,
    pub untracked: GitDiffSection,
}

#[derive(Debug)]
enum GitRunError {
    Missing,
    Timeout,
    Failed,
}

struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

struct GitOutput {
    status: ExitStatus,
    stdout: Captured,
    stderr: Captured,
}

fn read_bounded(mut reader: impl Read, limit: usize) -> Captured {
    let mut bytes = Vec::with_capacity(limit.min(16_384));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let allowed = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(allowed)]);
        truncated |= read > allowed;
        // Continue draining even after the capture limit so the child cannot
        // block forever on a full pipe.
    }
    Captured { bytes, truncated }
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn run_git(
    root: &Path,
    args: &[OsString],
    max_stdout: usize,
    timeout: Duration,
) -> Result<GitOutput, GitRunError> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_SETUP")
        .env_remove("GIT_TRACE_PERFORMANCE")
        .env_remove("GIT_TRACE_PACKET")
        .env_remove("GIT_TRACE_CURL")
        .env_remove("GIT_TRACE2")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            GitRunError::Missing
        } else {
            GitRunError::Failed
        }
    })?;
    let stdout = child.stdout.take().ok_or(GitRunError::Failed)?;
    let stderr = child.stderr.take().ok_or(GitRunError::Failed)?;
    let out_reader = thread::spawn(move || read_bounded(stdout, max_stdout));
    let err_reader = thread::spawn(move || read_bounded(stderr, 16_384));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                stop_child(&mut child);
                break Err(GitRunError::Timeout);
            }
            Err(_) => {
                stop_child(&mut child);
                break Err(GitRunError::Failed);
            }
        }
    };
    let stdout = out_reader.join().map_err(|_| GitRunError::Failed)?;
    let stderr = err_reader.join().map_err(|_| GitRunError::Failed)?;
    Ok(GitOutput {
        status: status?,
        stdout,
        stderr,
    })
}

fn base_args(subcommand: &str) -> Vec<OsString> {
    [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        subcommand,
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn status_args() -> Vec<OsString> {
    let mut args = base_args("status");
    args.extend(
        [
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--renames",
            "--",
            ".",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args
}

fn prefix_args() -> Vec<OsString> {
    let mut args = base_args("rev-parse");
    args.push(OsString::from("--show-prefix"));
    args
}

fn bytes_to_display(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(value) => (value.to_owned(), true),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
    }
}

fn parse_branch(header: &str) -> Option<String> {
    let rest = header.strip_prefix("## ")?.trim();
    let branch = if let Some(unborn) = rest.strip_prefix("No commits yet on ") {
        unborn
    } else if rest.starts_with("HEAD (no branch)") || rest.starts_with("HEAD (detached") {
        "Detached HEAD"
    } else if let Some((name, _)) = rest.split_once("...") {
        name
    } else {
        rest
    };
    let branch = branch.trim();
    (!branch.is_empty()).then(|| branch.chars().filter(|ch| !ch.is_control()).collect())
}

struct ParsedStatus {
    branch: Option<String>,
    files: Vec<GitChangedFile>,
    truncated: bool,
}

fn task_relative_path(path: &str, repo_prefix: &str) -> Option<String> {
    let relative = if repo_prefix.is_empty() {
        path
    } else {
        path.strip_prefix(repo_prefix)?
    };
    (!relative.is_empty()).then(|| relative.to_owned())
}

fn parse_status_z_with_prefix(bytes: &[u8], repo_prefix: &str) -> ParsedStatus {
    let fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut branch = None;
    let mut files = Vec::new();
    let mut truncated = false;
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        if record.starts_with(b"## ") {
            if let Ok(header) = std::str::from_utf8(record) {
                branch = parse_branch(header);
            }
            index += 1;
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            index += 1;
            continue;
        }
        let x = record[0] as char;
        let y = record[1] as char;
        let path_bytes = &record[3..];
        let (repo_path, path_valid) = bytes_to_display(path_bytes);
        let renames = x == 'R' || x == 'C' || y == 'R' || y == 'C';
        index += 1;
        let previous_path = if renames && index < fields.len() {
            let (previous, valid) = bytes_to_display(fields[index]);
            index += 1;
            if valid {
                task_relative_path(&previous, repo_prefix)
            } else {
                None
            }
        } else {
            None
        };
        // `git status` reports paths from the repository root. The task may
        // point at a nested project, so both filter siblings and normalize
        // retained paths before returning anything to the renderer.
        let Some(path) = task_relative_path(&repo_path, repo_prefix) else {
            continue;
        };
        if files.len() >= MAX_FILES {
            truncated = true;
            continue;
        }
        let status = [x, y];
        let conflicted = matches!(
            status,
            ['D', 'D']
                | ['A', 'U']
                | ['U', 'D']
                | ['U', 'A']
                | ['D', 'U']
                | ['A', 'A']
                | ['U', 'U']
        );
        let untracked = x == '?' && y == '?';
        files.push(GitChangedFile {
            path,
            previous_path,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            staged: x != ' ' && x != '?',
            unstaged: y != ' ' && y != '?',
            untracked,
            conflicted,
            diffable: path_valid,
        });
    }
    ParsedStatus {
        branch,
        files,
        truncated,
    }
}

fn parse_status_z(bytes: &[u8]) -> ParsedStatus {
    parse_status_z_with_prefix(bytes, "")
}

fn status_unavailable(reason: &str) -> GitWorkspaceStatus {
    GitWorkspaceStatus {
        state: GitWorkspaceState::Unavailable,
        branch: None,
        files: Vec::new(),
        truncated: false,
        reason: Some(reason.to_owned()),
    }
}

fn is_not_repository(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr.bytes).to_ascii_lowercase();
    stderr.contains("not a git repository")
}

fn inspect_status_scoped(root: &Path) -> (GitWorkspaceStatus, Option<String>) {
    let output = match run_git(&root, &status_args(), MAX_STATUS_BYTES, STATUS_TIMEOUT) {
        Ok(output) => output,
        Err(GitRunError::Missing) => {
            return (
                GitWorkspaceStatus {
                    state: GitWorkspaceState::GitMissing,
                    branch: None,
                    files: Vec::new(),
                    truncated: false,
                    reason: None,
                },
                None,
            )
        }
        Err(GitRunError::Timeout) => return (status_unavailable("timeout"), None),
        Err(GitRunError::Failed) => return (status_unavailable("git_error"), None),
    };
    if output.stdout.truncated {
        return (status_unavailable("output_limit"), None);
    }
    if !output.status.success() {
        if is_not_repository(&output) {
            return (
                GitWorkspaceStatus {
                    state: GitWorkspaceState::NotRepository,
                    branch: None,
                    files: Vec::new(),
                    truncated: false,
                    reason: None,
                },
                None,
            );
        }
        return (status_unavailable("git_error"), None);
    }
    let prefix_output = match run_git(root, &prefix_args(), 16_384, STATUS_TIMEOUT) {
        Ok(output) if output.status.success() && !output.stdout.truncated => output,
        Err(GitRunError::Missing) => {
            return (
                GitWorkspaceStatus {
                    state: GitWorkspaceState::GitMissing,
                    branch: None,
                    files: Vec::new(),
                    truncated: false,
                    reason: None,
                },
                None,
            )
        }
        Err(GitRunError::Timeout) => return (status_unavailable("timeout"), None),
        _ => return (status_unavailable("git_error"), None),
    };
    let mut prefix_bytes = prefix_output.stdout.bytes.as_slice();
    if prefix_bytes.ends_with(b"\n") {
        prefix_bytes = &prefix_bytes[..prefix_bytes.len() - 1];
    }
    if prefix_bytes.ends_with(b"\r") {
        prefix_bytes = &prefix_bytes[..prefix_bytes.len() - 1];
    }
    let Ok(repo_prefix) = std::str::from_utf8(prefix_bytes) else {
        return (status_unavailable("unsafe_prefix"), None);
    };
    let parsed = parse_status_z_with_prefix(&output.stdout.bytes, repo_prefix);
    (
        GitWorkspaceStatus {
            state: GitWorkspaceState::Ready,
            branch: parsed.branch,
            files: parsed.files,
            truncated: parsed.truncated,
            reason: None,
        },
        Some(repo_prefix.to_owned()),
    )
}

fn inspect_status(root: PathBuf) -> GitWorkspaceStatus {
    inspect_status_scoped(&root).0
}

async fn resolved_task_root(db: &DbState, task_id: &str) -> Result<PathBuf, String> {
    let connection = db.0.lock().await;
    let path = agent_workspace::task_root(&connection, task_id)?;
    Ok(PathBuf::from(path))
}

#[tauri::command]
pub async fn git_workspace_status(
    db: State<'_, DbState>,
    task_id: String,
) -> Result<GitWorkspaceStatus, String> {
    let root = resolved_task_root(&db, &task_id).await?;
    tauri::async_runtime::spawn_blocking(move || inspect_status(root))
        .await
        .map_err(|_| "git-error".to_owned())
}

fn section(text: String, truncated: bool, notice: Option<&str>) -> GitDiffSection {
    GitDiffSection {
        text,
        truncated,
        notice: notice.map(str::to_owned),
    }
}

fn empty_section(notice: Option<&str>) -> GitDiffSection {
    section(String::new(), false, notice)
}

fn diff_args(paths: &[&str], staged: bool) -> Vec<OsString> {
    let mut args = base_args("diff");
    args.extend(
        [
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
        ]
        .into_iter()
        .map(OsString::from),
    );
    if staged {
        args.push(OsString::from("--cached"));
    }
    args.push(OsString::from("--"));
    // Pathspecs are interpreted relative to the task root. `:(literal)` keeps
    // a filename containing wildcard/pathspec syntax from selecting other
    // files, including files outside a nested task directory.
    args.extend(
        paths
            .iter()
            .map(|path| OsString::from(format!(":(literal){path}"))),
    );
    args
}

fn run_diff(
    root: &Path,
    path: &str,
    previous_path: Option<&str>,
    staged: bool,
) -> Result<GitDiffSection, String> {
    let mut paths = Vec::with_capacity(2);
    if let Some(previous_path) = previous_path {
        paths.push(previous_path);
    }
    paths.push(path);
    let output = run_git(
        root,
        &diff_args(&paths, staged),
        MAX_DIFF_BYTES,
        DIFF_TIMEOUT,
    )
    .map_err(|error| match error {
        GitRunError::Missing => "git-missing",
        GitRunError::Timeout => "git-timeout",
        GitRunError::Failed => "git-error",
    })?;
    if !output.status.success() {
        return Err("git-error".into());
    }
    let (text, valid) = bytes_to_display(&output.stdout.bytes);
    if !valid {
        return Ok(empty_section(Some("binary")));
    }
    Ok(section(text, output.stdout.truncated, None))
}

fn visible_path(path: &str) -> String {
    path.chars().flat_map(char::escape_default).collect()
}

fn untracked_preview(root: &Path, path: &str) -> GitDiffSection {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return empty_section(Some("unsafe_path"));
    }
    let Ok(root) = fs::canonicalize(root) else {
        return empty_section(Some("file_unavailable"));
    };
    let Ok(candidate) = fs::canonicalize(root.join(relative)) else {
        return empty_section(Some("file_unavailable"));
    };
    if !candidate.starts_with(&root) {
        return empty_section(Some("unsafe_path"));
    }
    let Ok(metadata) = candidate.metadata() else {
        return empty_section(Some("file_unavailable"));
    };
    if !metadata.is_file() {
        return empty_section(Some("not_a_file"));
    }
    if metadata.len() > MAX_PREVIEW_FILE_BYTES as u64 {
        return empty_section(Some("too_large"));
    }
    let Ok(file) = fs::File::open(candidate) else {
        return empty_section(Some("file_unavailable"));
    };
    let mut bytes = Vec::with_capacity(MAX_PREVIEW_FILE_BYTES.min(metadata.len() as usize));
    if file
        .take((MAX_PREVIEW_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return empty_section(Some("file_unavailable"));
    }
    if bytes.len() > MAX_PREVIEW_FILE_BYTES {
        return empty_section(Some("too_large"));
    }
    if bytes.contains(&0) {
        return empty_section(Some("binary"));
    }
    let Ok(contents) = String::from_utf8(bytes) else {
        return empty_section(Some("binary"));
    };
    let mut output = format!("--- /dev/null\n+++ b/{}\n", visible_path(path));
    let mut lines = 0;
    for line in contents.split_inclusive('\n') {
        if lines >= MAX_PREVIEW_LINES {
            return section(output, true, None);
        }
        output.push('+');
        output.push_str(line);
        if !line.ends_with('\n') {
            output.push('\n');
        }
        lines += 1;
    }
    section(output, false, None)
}

fn inspect_diff(root: PathBuf, relative_path: String) -> Result<GitWorkspaceDiff, String> {
    let (status, _repo_prefix) = inspect_status_scoped(&root);
    match status.state {
        GitWorkspaceState::Ready => {}
        GitWorkspaceState::NotRepository => return Err("git-not-repository".into()),
        GitWorkspaceState::GitMissing => return Err("git-missing".into()),
        GitWorkspaceState::Unavailable => {
            return Err(match status.reason.as_deref() {
                Some("timeout") => "git-timeout",
                _ => "git-error",
            }
            .into())
        }
    }
    let Some(file) = status
        .files
        .into_iter()
        .find(|file| file.path == relative_path)
    else {
        return Err("changed-file-missing".into());
    };
    if !file.diffable {
        return Err("unsafe_path".into());
    }
    let previous_path = file.previous_path.as_deref();
    let staged = if file.staged {
        run_diff(&root, &relative_path, previous_path, true)?
    } else {
        empty_section(None)
    };
    let unstaged = if file.unstaged && !file.untracked {
        run_diff(&root, &relative_path, previous_path, false)?
    } else {
        empty_section(None)
    };
    let untracked = if file.untracked {
        untracked_preview(&root, &relative_path)
    } else {
        empty_section(None)
    };
    Ok(GitWorkspaceDiff {
        path: relative_path,
        staged,
        unstaged,
        untracked,
    })
}

#[tauri::command]
pub async fn git_workspace_diff(
    db: State<'_, DbState>,
    task_id: String,
    relative_path: String,
) -> Result<GitWorkspaceDiff, String> {
    if relative_path.len() > 4096 {
        return Err("unsafe_path".into());
    }
    let root = resolved_task_root(&db, &task_id).await?;
    tauri::async_runtime::spawn_blocking(move || inspect_diff(root, relative_path))
        .await
        .map_err(|_| "git-error".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_at(root: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[test]
    fn parses_branch_and_porcelain_file_states_with_nul_paths() {
        let status = b"## feature/workplace...origin/feature/workplace [ahead 1]\0 M src/main.rs\0A  staged.txt\0?? new file.txt\0UU conflict.txt\0R  renamed.rs\0old.rs\0";
        let parsed = parse_status_z(status);
        assert_eq!(parsed.branch.as_deref(), Some("feature/workplace"));
        assert_eq!(parsed.files.len(), 5);
        assert!(parsed.files[0].unstaged);
        assert!(parsed.files[1].staged);
        assert!(parsed.files[2].untracked);
        assert!(parsed.files[3].conflicted);
        assert_eq!(parsed.files[4].previous_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn reports_unborn_and_detached_branches() {
        assert_eq!(
            parse_branch("## No commits yet on fresh-branch").as_deref(),
            Some("fresh-branch")
        );
        assert_eq!(
            parse_branch("## HEAD (no branch)").as_deref(),
            Some("Detached HEAD")
        );
    }

    #[test]
    fn untracked_preview_is_bounded_and_rejects_paths_outside_the_root() {
        let root = std::env::temp_dir().join(format!("aplot-git-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("notes.txt"), "first\nsecond").unwrap();
        let preview = untracked_preview(&root, "notes.txt");
        assert!(preview.text.contains("+first\n+second\n"));
        assert_eq!(
            untracked_preview(&root, "../outside.txt").notice.as_deref(),
            Some("unsafe_path")
        );
        assert_eq!(
            untracked_preview(&root, "missing.txt").notice.as_deref(),
            Some("file_unavailable")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_task_sees_only_its_changes_and_gets_staged_unstaged_untracked_and_rename_previews() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repository =
            std::env::temp_dir().join(format!("aplot-git-nested-{}", uuid::Uuid::new_v4()));
        let task = repository.join("apps").join("demo");
        fs::create_dir_all(&task).unwrap();
        assert!(git_at(&repository, &["init", "-q"]));
        assert!(git_at(&repository, &["config", "user.name", "Aplot Test"]));
        assert!(git_at(
            &repository,
            &["config", "user.email", "aplot-test@example.invalid"]
        ));
        fs::write(task.join("modified.txt"), "before\n").unwrap();
        fs::write(task.join("rename-old.txt"), "rename body\n").unwrap();
        fs::write(repository.join("sibling.txt"), "tracked sibling\n").unwrap();
        assert!(git_at(&repository, &["add", "."]));
        assert!(git_at(&repository, &["commit", "-q", "-m", "baseline"]));

        fs::write(task.join("modified.txt"), "after\n").unwrap();
        fs::write(task.join("staged.txt"), "staged body\n").unwrap();
        assert!(git_at(&repository, &["add", "apps/demo/staged.txt"]));
        fs::write(task.join("untracked.txt"), "untracked body\n").unwrap();
        assert!(git_at(
            &repository,
            &["mv", "apps/demo/rename-old.txt", "apps/demo/rename-new.txt"]
        ));
        fs::write(repository.join("sibling.txt"), "outside change\n").unwrap();
        fs::write(
            repository.join("sibling-untracked.txt"),
            "outside untracked\n",
        )
        .unwrap();

        let status = inspect_status(task.clone());
        assert_eq!(status.state, GitWorkspaceState::Ready);
        assert!(status
            .files
            .iter()
            .all(|file| !file.path.starts_with("apps/")));
        assert!(!status
            .files
            .iter()
            .any(|file| file.path.contains("sibling")));
        let paths = status
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert!(paths.contains("modified.txt"));
        assert!(paths.contains("staged.txt"));
        assert!(paths.contains("untracked.txt"));
        let renamed = status
            .files
            .iter()
            .find(|file| file.path == "rename-new.txt")
            .expect("renamed file");
        assert_eq!(renamed.previous_path.as_deref(), Some("rename-old.txt"));

        let unstaged = inspect_diff(task.clone(), "modified.txt".into()).unwrap();
        assert!(unstaged.unstaged.text.contains("+after"));
        assert!(unstaged.staged.text.is_empty());
        let staged = inspect_diff(task.clone(), "staged.txt".into()).unwrap();
        assert!(staged.staged.text.contains("+staged body"));
        let untracked = inspect_diff(task.clone(), "untracked.txt".into()).unwrap();
        assert!(untracked.untracked.text.contains("+untracked body"));
        let renamed_diff = inspect_diff(task.clone(), "rename-new.txt".into()).unwrap();
        assert!(renamed_diff.staged.text.contains("rename from"));
        assert_eq!(
            inspect_diff(task.clone(), "../sibling.txt".into()).unwrap_err(),
            "changed-file-missing"
        );

        fs::remove_dir_all(repository).unwrap();
    }
}
