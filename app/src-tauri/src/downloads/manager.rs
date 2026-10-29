use super::{
    huggingface, install, paths, repository, transfer, DownloadError, DownloadPlan,
    DownloadSelection, DownloadTask,
};
use crate::db::DbState;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

#[derive(Default)]
struct Inner {
    plans: BTreeMap<String, DownloadPlan>,
    tasks: BTreeMap<String, DownloadTask>,
    queue: VecDeque<String>,
    controls: BTreeMap<String, Arc<AtomicU8>>,
    running: bool,
    active: Option<String>,
}

#[derive(Default)]
pub struct DownloadManager {
    inner: Mutex<Inner>,
    stopping: AtomicBool,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn active(state: &str) -> bool {
    matches!(
        state,
        "queued"
            | "resolving"
            | "downloading"
            | "verifying"
            | "installing"
            | "pausing"
            | "retry_wait"
    )
}

impl DownloadManager {
    pub fn load(conn: &mut rusqlite::Connection) -> Result<Self, String> {
        repository::init_schema(conn)?;
        let mut inner = Inner::default();
        for mut task in repository::list(conn)? {
            if active(&task.state) {
                task.state = "interrupted".into();
                task.speed_bytes_per_second = 0.;
                task.updated_at = now();
                task.sequence += 1;
                repository::save(conn, &task)?;
            }
            inner.tasks.insert(task.id.clone(), task);
        }
        Ok(Self {
            inner: Mutex::new(inner),
            stopping: AtomicBool::new(false),
        })
    }

    pub async fn list(&self) -> Vec<DownloadTask> {
        let mut result: Vec<_> = self.inner.lock().await.tasks.values().cloned().collect();
        result.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        result
    }

    pub async fn get(&self, id: &str) -> Result<DownloadTask, String> {
        self.inner
            .lock()
            .await
            .tasks
            .get(id)
            .cloned()
            .ok_or_else(|| "Download was not found".into())
    }

    pub async fn prepare(
        &self,
        selection: DownloadSelection,
        destination: String,
    ) -> Result<DownloadPlan, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("Application is shutting down".into());
        }
        if selection.revision.len() != 40
            || !selection.revision.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Resolve a repository revision before preparing a download".into());
        }
        let resolved = huggingface::resolve(&selection.source, Some(&selection.revision)).await?;
        let files = huggingface::select(&resolved, &selection)?;
        let destination = tokio::task::spawn_blocking(move || paths::destination(&destination))
            .await
            .map_err(|e| e.to_string())??;
        let total = files
            .iter()
            .try_fold(0u64, |sum, f| sum.checked_add(f.size_bytes))
            .ok_or("Model set size overflow")?;
        let id = uuid::Uuid::new_v4().to_string();
        let folder = if selection.vision_only {
            format!("{}{id}", super::VISION_FOLDER_PREFIX)
        } else {
            format!("{}-{}", resolved.repo_id.replace('/', "-"), id)
        };
        let available = paths::available(&destination)?;
        let mut warnings=vec!["Downloaded GGUF does not confirm engine architecture support. Strata requires a prepared configuration.".into()];
        if files.iter().any(|f| f.sha256.is_none()) {
            warnings.push("Source SHA-256 is unavailable for some files; verification is limited to size, GGUF structure and a locally computed digest.".into());
        }
        let plan = DownloadPlan {
            plan_id: id,
            source: resolved.source,
            repo_id: resolved.repo_id,
            revision: resolved.revision,
            files,
            destination: destination.to_string_lossy().into_owned(),
            final_path: destination.join(folder).to_string_lossy().into_owned(),
            total_bytes: total,
            available_bytes: available,
            warnings,
        };
        let mut inner = self.inner.lock().await;
        check_space(&inner, &plan, None)?;
        // Plans are ephemeral and bounded. Durable state begins at Start.
        if inner.plans.len() >= 128 {
            inner.plans.clear();
        }
        inner.plans.insert(plan.plan_id.clone(), plan.clone());
        Ok(plan)
    }

    pub async fn start(&self, app: &AppHandle, id: &str) -> Result<DownloadTask, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("Application is shutting down".into());
        }
        let mut inner = self.inner.lock().await;
        if inner.tasks.contains_key(id) {
            return Err("This plan was already started".into());
        }
        let plan = inner
            .plans
            .get(id)
            .cloned()
            .ok_or("Download plan expired; prepare it again")?;
        paths::no_links(std::path::Path::new(&plan.destination))?;
        if std::path::Path::new(&plan.final_path).exists() {
            return Err("Destination already exists".into());
        }
        check_space(&inner, &plan, None)?;
        let timestamp = now();
        let task = DownloadTask {
            id: id.into(),
            download_id: id.into(),
            sequence: 1,
            state: "queued".into(),
            total_bytes: plan.total_bytes,
            plan,
            downloaded_bytes: 0,
            speed_bytes_per_second: 0.,
            current_file: None,
            error: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            installed_path: None,
            verification: None,
        };
        persist(app, &task).await?;
        inner.tasks.insert(id.into(), task.clone());
        inner.controls.insert(id.into(), Arc::new(AtomicU8::new(0)));
        inner.queue.push_back(id.into());
        inner.plans.remove(id);
        drop(inner);
        let _ = app.emit("download://updated", &task);
        kick(app);
        Ok(task)
    }

    pub async fn control(
        &self,
        app: &AppHandle,
        id: &str,
        action: &str,
    ) -> Result<DownloadTask, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("Application is shutting down".into());
        }
        let mut inner = self.inner.lock().await;
        let mut task = inner
            .tasks
            .get(id)
            .cloned()
            .ok_or("Download was not found")?;
        match action {
            "resume" => {
                if !matches!(
                    task.state.as_str(),
                    "paused" | "failed" | "interrupted" | "cancelled"
                ) {
                    return Err(
                        "Only paused, interrupted, cancelled or failed downloads can resume".into(),
                    );
                }
                // A rename completed before a DB failure needs no second copy
                // or weight-volume reservation. Reconcile it even on a full disk.
                if !install::published_set_exists(&task)? {
                    check_space(&inner, &task.plan, Some(id))?;
                }
                task.state = "queued".into();
                task.error = None;
                inner.controls.insert(id.into(), Arc::new(AtomicU8::new(0)));
                inner.queue.push_back(id.into());
            }
            "pause" | "cancel" => {
                if matches!(task.state.as_str(), "completed" | "cancelled") {
                    return Err("Download is already finished".into());
                }
                if inner.active.as_deref() == Some(id) {
                    if task.state == "installing" {
                        return Err("The complete model set is being published; wait for installation to finish".into());
                    }
                    inner
                        .controls
                        .get(id)
                        .ok_or("Missing active download control")?
                        .store(if action == "cancel" { 2 } else { 1 }, Ordering::Release);
                    task.state = "pausing".into();
                } else {
                    inner.queue.retain(|q| q != id);
                    task.state = if action == "cancel" {
                        "cancelled"
                    } else {
                        "paused"
                    }
                    .into();
                }
            }
            "remove" => {
                if inner.active.as_deref() == Some(id) || active(&task.state) {
                    return Err("Pause or cancel the download before removing partial files".into());
                }
                if task.state == "completed" {
                    return Err("Completed models are managed in the library".into());
                }
                if install::published_set_exists(&task)? {
                    return Err("The complete model set is already published. Resume to finish its registration; installed files are kept.".into());
                }
                install::remove_partial(&task)?;
                task.downloaded_bytes = 0;
                task.error = None;
            }
            _ => return Err("Unknown download operation".into()),
        }
        task.sequence += 1;
        task.updated_at = now();
        task.speed_bytes_per_second = 0.;
        persist(app, &task).await?;
        inner.tasks.insert(id.into(), task.clone());
        drop(inner);
        let _ = app.emit("download://updated", &task);
        if action == "resume" {
            kick(app);
        }
        Ok(task)
    }

    pub async fn shutdown(&self, app: &AppHandle) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        let mut inner = self.inner.lock().await;
        for control in inner.controls.values() {
            control.store(1, Ordering::Release);
        }
        let queued: Vec<_> = inner.queue.drain(..).collect();
        for id in queued {
            if let Some(task) = inner.tasks.get_mut(&id) {
                task.state = "paused".into();
                task.sequence += 1;
                task.updated_at = now();
                persist(app, task).await?;
                let _ = app.emit("download://updated", &*task);
            }
        }
        drop(inner);
        tokio::time::timeout(Duration::from_secs(65), async {
            loop {
                if !self.inner.lock().await.running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "Download checkpoint is still being saved; retry Quit".to_string())?;
        Ok(())
    }
}

fn check_space(inner: &Inner, plan: &DownloadPlan, exclude: Option<&str>) -> Result<(), String> {
    let destination = std::path::Path::new(&plan.destination);
    let available = paths::available(destination)?;
    // Conservative reservation across all queues, including other destinations.
    // This cannot overcommit a shared volume at the price of a cautious refusal.
    let reserved = inner
        .tasks
        .values()
        .filter(|t| {
            exclude != Some(t.id.as_str())
                && !matches!(t.state.as_str(), "completed" | "cancelled" | "failed")
        })
        .fold(0u64, |sum, t| {
            sum.saturating_add(t.total_bytes.saturating_sub(t.downloaded_bytes))
        });
    let existing = exclude
        .and_then(|id| inner.tasks.get(id))
        .map(|t| t.downloaded_bytes)
        .unwrap_or(0);
    let required = plan
        .total_bytes
        .saturating_sub(existing)
        .saturating_add(reserved)
        .saturating_add(64 * 1024 * 1024);
    if available < required {
        return Err(format!("Not enough free space: {required} bytes required (including queued downloads and reserve), {available} available"));
    }
    Ok(())
}

async fn persist(app: &AppHandle, task: &DownloadTask) -> Result<(), String> {
    let db = app.state::<DbState>();
    let mut conn = db.0.lock().await;
    repository::save(&mut conn, task)
}

pub async fn publish(app: &AppHandle, task: &mut DownloadTask) -> Result<(), String> {
    let manager = app.state::<DownloadManager>();
    let mut inner = manager.inner.lock().await;
    let previous = inner.tasks.get(&task.id).map(|t| t.sequence).unwrap_or(0);
    task.sequence = task.sequence.max(previous) + 1;
    task.updated_at = now();
    persist(app, task).await?;
    inner.tasks.insert(task.id.clone(), task.clone());
    drop(inner);
    let _ = app.emit("download://updated", &*task);
    Ok(())
}

fn kick(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<DownloadManager>();
        {
            let mut inner = manager.inner.lock().await;
            if inner.running || manager.stopping.load(Ordering::Acquire) {
                return;
            }
            inner.running = true;
        }
        loop {
            let next = {
                let mut inner = manager.inner.lock().await;
                match inner.queue.pop_front() {
                    Some(id) => {
                        inner.active = Some(id.clone());
                        Some((inner.tasks[&id].clone(), inner.controls[&id].clone()))
                    }
                    None => {
                        inner.running = false;
                        inner.active = None;
                        None
                    }
                }
            };
            let Some((mut task, control)) = next else {
                break;
            };
            let result = execute(&app, &mut task, control.clone()).await;
            task.speed_bytes_per_second = 0.;
            match result {
                Ok(()) => (),
                Err(error) => {
                    let action = control.load(Ordering::Acquire);
                    task.state = if action == 2 {
                        "cancelled"
                    } else if action == 1 {
                        "paused"
                    } else {
                        "failed"
                    }
                    .into();
                    task.error = if action != 0 {
                        None
                    } else {
                        Some(DownloadError {
                            code: error.code,
                            message: error.message,
                            retryable: error.retryable,
                        })
                    };
                }
            }
            if let Err(error) = publish(&app, &mut task).await {
                let _ = app.emit("download://persistence-error", &error);
                let mut inner = manager.inner.lock().await;
                // Stop the queue on a failed checkpoint rather than silently
                // downloading more files without authoritative durable state.
                inner.running = false;
                inner.active = None;
                task.state = "failed".into();
                task.sequence += 1;
                task.error = Some(DownloadError {
                    code: "database".into(),
                    message: format!("Download checkpoint could not be saved: {error}"),
                    retryable: false,
                });
                inner.tasks.insert(task.id.clone(), task.clone());
                let _ = app.emit("download://updated", &task);
                break;
            }
            manager.inner.lock().await.active = None;
        }
    });
}

async fn execute(
    app: &AppHandle,
    task: &mut DownloadTask,
    control: Arc<AtomicU8>,
) -> Result<(), transfer::Failure> {
    use transfer::Failure;
    if std::path::Path::new(&task.plan.final_path).exists() {
        task.state = "verifying".into();
        publish(app, task)
            .await
            .map_err(|e| Failure::permanent("database", e))?;
        let mut copy = task.clone();
        let recovery_control = control.clone();
        let recovered = tokio::task::spawn_blocking(move || {
            install::recover_with_control(&mut copy, &recovery_control).map(|done| (done, copy))
        })
        .await
        .map_err(|e| Failure::permanent("install", e.to_string()))?
        .map_err(|e| Failure::permanent("install", e))?;
        if recovered.0 {
            *task = recovered.1;
            return Ok(());
        }
    }
    let staging = paths::staging(&task.plan);
    paths::no_links(&staging).map_err(|e| Failure::permanent("path", e))?;
    std::fs::create_dir_all(&staging).map_err(|e| Failure::permanent("disk", e.to_string()))?;
    let mut base = 0;
    for file in task.plan.files.clone() {
        if control.load(Ordering::Acquire) != 0 {
            return Err(Failure::permanent("interrupted", "Paused"));
        }
        task.current_file = Some(file.path.clone());
        task.state = "downloading".into();
        publish(app, task)
            .await
            .map_err(|e| Failure::permanent("database", e))?;
        let ready = staging.join(&file.path);
        if !ready.exists() {
            let mut attempt = 0;
            loop {
                match transfer::download(app, task, &file, base, control.clone()).await {
                    Ok(()) => break,
                    Err(error)
                        if error.retryable
                            && attempt < 3
                            && control.load(Ordering::Acquire) == 0 =>
                    {
                        attempt += 1;
                        task.state = "retry_wait".into();
                        task.error = Some(DownloadError {
                            code: error.code.clone(),
                            message: error.message.clone(),
                            retryable: true,
                        });
                        publish(app, task)
                            .await
                            .map_err(|e| Failure::permanent("database", e))?;
                        tokio::select! {_=tokio::time::sleep(Duration::from_secs(error.retry_after.max(1<<attempt)))=>(),_=transfer::wait_control(control.clone())=>return Err(Failure::permanent("interrupted","Paused"))};
                        task.state = "downloading".into();
                        task.error = None;
                        publish(app, task)
                            .await
                            .map_err(|e| Failure::permanent("database", e))?;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        task.state = "verifying".into();
        task.speed_bytes_per_second = 0.;
        publish(app, task)
            .await
            .map_err(|e| Failure::permanent("database", e))?;
        let digest = install::verify_file(task, &file, control.clone())
            .await
            .map_err(|e| Failure::permanent("integrity", e))?;
        if let Some(stored) = task.plan.files.iter_mut().find(|f| f.path == file.path) {
            stored.local_sha256 = Some(digest.clone());
        }
        // Retain local computed hashes separately from the source identity.
        let digest_path = paths::part_path(&task.plan, &file.path)
            .map_err(|e| Failure::permanent("path", e))?
            .with_extension("verified-sha256");
        paths::no_links(&digest_path).map_err(|e| Failure::permanent("path", e))?;
        std::fs::write(digest_path, digest)
            .map_err(|e| Failure::permanent("disk", e.to_string()))?;
        base += file.size_bytes;
        task.downloaded_bytes = base;
    }
    if control.load(Ordering::Acquire) != 0 {
        return Err(Failure::permanent("interrupted", "Paused"));
    }
    task.state = "installing".into();
    task.error = None;
    publish(app, task)
        .await
        .map_err(|e| Failure::permanent("database", e))?;
    let copy = task.clone();
    let path = tokio::task::spawn_blocking(move || install::publish_set(&copy))
        .await
        .map_err(|e| Failure::permanent("install", e.to_string()))?
        .map_err(|e| Failure::permanent("install", e))?;
    task.installed_path = Some(path);
    task.state = "completed".into();
    task.current_file = None;
    task.verification = Some(
        if task.plan.files.iter().all(|f| f.sha256.is_some()) {
            "source_sha256"
        } else {
            "size_gguf_local_sha256_only"
        }
        .into(),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn restart_preserves_history_and_never_auto_resumes() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        repository::init_schema(&conn).unwrap();
        let mut task = super::super::fixture();
        task.state = "downloading".into();
        task.downloaded_bytes = 12;
        repository::save(&mut conn, &task).unwrap();
        let manager = DownloadManager::load(&mut conn).unwrap();
        let loaded = manager.get(&task.id).await.unwrap();
        assert_eq!(loaded.state, "interrupted");
        assert_eq!(loaded.downloaded_bytes, 12);
        assert!(loaded.sequence > task.sequence);
        assert!(manager.inner.lock().await.queue.is_empty());
        assert!(!manager.inner.lock().await.running);
        let again = DownloadManager::load(&mut conn).unwrap();
        assert_eq!(again.get(&task.id).await.unwrap().sequence, loaded.sequence);
        let root = std::path::Path::new(&task.plan.destination);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir(root).unwrap();
    }
}
