//! Same-process mobile HTTP acceptance without Tauri or a provider runtime.
use aplot_server::{
    mobile_api::{mobile_router, MobileApiConfig},
    mobile_host::start_mobile_host,
    ServerData,
};
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs, io,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::task::JoinHandle;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8123";
const TOKEN: &str = "mobile-test-token-with-at-least-32-chars";

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

struct TestServer {
    router: Router,
    host: aplot_server::mobile_host::MobileHost,
    worker: Option<JoinHandle<io::Result<()>>>,
    project_id: String,
    project_path: PathBuf,
    root: PathBuf,
    authority: String,
    origin: String,
}

impl TestServer {
    fn new() -> Self {
        Self::with_origin(ORIGIN, false)
    }

    fn with_origin(origin: &str, allow_private_http: bool) -> Self {
        let authority = origin.strip_prefix("http://").unwrap().to_owned();
        let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("aplot-mobile-api-{}-{id}", uuid::Uuid::new_v4()));
        let data_dir = root.join("data");
        let assets = root.join("assets");
        let project_path = root.join("project");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&assets).unwrap();
        fs::create_dir_all(&project_path).unwrap();
        fs::create_dir_all(assets.join("assets")).unwrap();
        fs::create_dir_all(assets.join("icons")).unwrap();
        fs::write(
            assets.join("index.html"),
            "<!doctype html><html><script src=\"/mobile/assets/app.js\"></script></html>",
        )
        .unwrap();
        fs::write(
            assets.join("assets/app.js"),
            "document.body.dataset.ready='yes';",
        )
        .unwrap();
        fs::write(
            assets.join("sw.js"),
            "self.addEventListener('install',()=>{});",
        )
        .unwrap();
        fs::write(assets.join("icons/app.png"), [137, 80, 78, 71]).unwrap();

        // Initialize the standalone database, then seed only the project
        // envelope through the same shared workspace validator the server uses.
        drop(ServerData::open(&data_dir).unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let mut db = Connection::open(data_dir.join("server-tasks.sqlite3")).unwrap();
        aplot_core::workspace::write_saved(
            &mut db,
            json!({
                "projects":[{"id":project_id,"name":"Test project","path":project_path}],
                "tasks":[],
                "threads":{},
                "memory":[]
            }),
            0,
        )
        .unwrap();
        drop(db);

        let data = ServerData::open(&data_dir).unwrap();
        let (host, worker) = start_mobile_host(data, None).unwrap();
        let router = mobile_router(
            host.clone(),
            MobileApiConfig {
                public_origin: origin.into(),
                access_token: TOKEN.into(),
                assets_dir: assets,
                allow_private_http,
            },
        )
        .unwrap();
        let worker = tokio::spawn(worker.run());
        Self {
            router,
            host,
            worker: Some(worker),
            project_id,
            project_path,
            root,
            authority,
            origin: origin.into(),
        }
    }

    async fn request(&self, request: Request<Body>) -> axum::response::Response {
        self.router.clone().oneshot(request).await.unwrap()
    }

    fn get(&self, uri: &str) -> Request<Body> {
        Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(header::HOST, &self.authority)
            .body(Body::empty())
            .unwrap()
    }

    fn auth_get(&self, uri: &str) -> Request<Body> {
        Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(header::HOST, &self.authority)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap()
    }

    fn post_json(&self, uri: &str, body: Value) -> Request<Body> {
        self.post_raw(uri, body.to_string())
    }

    fn post_raw(&self, uri: &str, body: String) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::HOST, &self.authority)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    }

    async fn shutdown(mut self) {
        self.host.shutdown();
        if let Some(worker) = self.worker.take() {
            tokio::time::timeout(std::time::Duration::from_secs(2), worker)
                .await
                .expect("mobile worker did not stop")
                .expect("mobile worker panicked")
                .expect("mobile worker failed");
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.host.shutdown();
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn public_shell_redirects_and_static_assets_have_bounded_headers() {
    let server = TestServer::new();

    let shell = server.request(server.get("/mobile/")).await;
    assert_eq!(shell.status(), StatusCode::OK);
    assert_eq!(shell.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(
        shell.headers()[header::CACHE_CONTROL],
        "public, max-age=0, must-revalidate"
    );
    assert!(shell.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("default-src 'self'"));
    assert!(shell
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_none());
    let html = to_bytes(shell.into_body(), 4096).await.unwrap();
    let html = String::from_utf8_lossy(&html);
    assert!(html.contains("/mobile/assets/app.js"));
    assert!(!html.contains(TOKEN));

    for path in ["/", "/mobile"] {
        let response = server.request(server.get(path)).await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(response.headers()[header::LOCATION], "/mobile/");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
    }

    let js = server.request(server.get("/mobile/assets/app.js")).await;
    assert_eq!(js.status(), StatusCode::OK);
    assert_eq!(
        js.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(js.headers()[header::CACHE_CONTROL], "public, max-age=3600");

    let icon = server.request(server.get("/mobile/icons/app.png")).await;
    assert_eq!(icon.status(), StatusCode::OK);
    assert_eq!(icon.headers()[header::CONTENT_TYPE], "image/png");

    let service_worker = server.request(server.get("/mobile/sw.js")).await;
    assert_eq!(service_worker.status(), StatusCode::OK);
    assert_eq!(
        service_worker.headers()[header::CACHE_CONTROL],
        "public, max-age=0, must-revalidate"
    );

    let traversal = server
        .request(server.get("/mobile/%2e%2e/server.json"))
        .await;
    assert_eq!(traversal.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        traversal.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn private_api_requires_bearer_and_exact_same_origin_authority() {
    let server = TestServer::new();

    let unauthorized = server.request(server.get("/api/v1/workspace")).await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(unauthorized.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        unauthorized.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    assert_eq!(unauthorized.headers()[header::WWW_AUTHENTICATE], "Bearer");
    assert_eq!(json_body(unauthorized).await["error"], "unauthorized");

    let cookie_only = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/workspace")
        .header(header::HOST, &server.authority)
        .header(header::COOKIE, format!("token={TOKEN}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        server.request(cookie_only).await.status(),
        StatusCode::UNAUTHORIZED
    );

    let query_only = server
        .request(server.get(&format!("/api/v1/workspace?token={TOKEN}")))
        .await;
    assert_eq!(query_only.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(query_only.headers()[header::CACHE_CONTROL], "no-store");

    let mut bad_host = server.auth_get("/api/v1/workspace");
    *bad_host.headers_mut().get_mut(header::HOST).unwrap() = "attacker.test".parse().unwrap();
    let bad_host = server.request(bad_host).await;
    assert_eq!(bad_host.status(), StatusCode::FORBIDDEN);
    assert_eq!(bad_host.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        bad_host.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );

    for origin in ["https://attacker.test", "null"] {
        let mut bad_origin = server.auth_get("/api/v1/workspace");
        bad_origin
            .headers_mut()
            .insert(header::ORIGIN, origin.parse().unwrap());
        assert_eq!(
            server.request(bad_origin).await.status(),
            StatusCode::FORBIDDEN
        );
    }

    let absolute_wrong_scheme = Request::builder()
        .method(Method::GET)
        .uri(format!("https://{}/api/v1/workspace", server.authority))
        .header(header::HOST, &server.authority)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        server.request(absolute_wrong_scheme).await.status(),
        StatusCode::FORBIDDEN
    );

    let mut good_origin = server.auth_get("/api/v1/workspace");
    good_origin
        .headers_mut()
        .insert(header::ORIGIN, server.origin.parse().unwrap());
    let workspace = server.request(good_origin).await;
    assert_eq!(workspace.status(), StatusCode::OK);
    assert_eq!(workspace.headers()[header::CACHE_CONTROL], "no-store");
    assert!(workspace
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_none());
    let workspace = json_body(workspace).await;
    assert_eq!(workspace["model"], ""); // Valid mobile DTO in browsing-only mode.
    assert_eq!(workspace["projects"][0]["name"], "Test project");
    assert!(workspace["projects"][0].get("path").is_none());
    assert!(!workspace
        .to_string()
        .contains(server.project_path.to_str().unwrap()));

    let query_with_bearer = server
        .request(server.auth_get(&format!("/api/v1/workspace?token={TOKEN}")))
        .await;
    assert_eq!(query_with_bearer.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(query_with_bearer).await["error"],
        "query-not-supported"
    );

    let no_info_route = server.request(server.get("/api/v1/info")).await;
    assert_eq!(no_info_route.status(), StatusCode::UNAUTHORIZED);
    let info_route = server.request(server.auth_get("/api/v1/info")).await;
    assert_eq!(info_route.status(), StatusCode::NOT_FOUND);
    assert_eq!(info_route.headers()[header::CACHE_CONTROL], "no-store");

    server.shutdown().await;
}

#[tokio::test]
async fn private_http_routes_keep_host_origin_and_bearer_gates() {
    let server = TestServer::with_origin("http://192.168.1.20:4180", true);

    let shell = server.request(server.get("/mobile/")).await;
    assert_eq!(shell.status(), StatusCode::OK);

    let unauthorized = server.request(server.get("/api/v1/workspace")).await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let mut authorized = server.auth_get("/api/v1/workspace");
    authorized
        .headers_mut()
        .insert(header::ORIGIN, server.origin.parse().unwrap());
    assert_eq!(server.request(authorized).await.status(), StatusCode::OK);

    let mut wrong_origin = server.auth_get("/api/v1/workspace");
    wrong_origin
        .headers_mut()
        .insert(header::ORIGIN, "http://192.168.1.21:4180".parse().unwrap());
    assert_eq!(
        server.request(wrong_origin).await.status(),
        StatusCode::FORBIDDEN
    );

    let mut wrong_host = server.auth_get("/api/v1/workspace");
    *wrong_host.headers_mut().get_mut(header::HOST).unwrap() = "192.168.1.21:4180".parse().unwrap();
    assert_eq!(
        server.request(wrong_host).await.status(),
        StatusCode::FORBIDDEN
    );

    server.shutdown().await;
}

#[tokio::test]
async fn task_routes_reject_extra_fields_and_keep_execution_disabled_without_config() {
    let server = TestServer::new();
    let create_path = format!("/api/v1/projects/{}/tasks", server.project_id);
    let extra = server
        .post_json(
            &create_path,
            json!({"commandId":uuid::Uuid::new_v4().to_string(),"title":"Task","model":"untrusted-model"}),
        );
    assert_eq!(
        server.request(extra).await.status(),
        StatusCode::BAD_REQUEST
    );

    let too_large = server.post_raw(
        &create_path,
        format!("{{\"title\":\"{}\"}}", "x".repeat(100_000)),
    );
    let too_large = server.request(too_large).await;
    assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(too_large.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        too_large.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    assert_eq!(json_body(too_large).await["error"], "body-too-large");

    let command_id = uuid::Uuid::new_v4().to_string();
    let created = server
        .request(server.post_json(
            &create_path,
            json!({"commandId":command_id,"title":"First mobile task"}),
        ))
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = json_body(created).await;
    assert_eq!(created["status"], "created");
    let task_id = created["taskId"].as_str().unwrap();

    let task_response = server
        .request(server.auth_get(&format!("/api/v1/tasks/{task_id}")))
        .await;
    assert_eq!(task_response.status(), StatusCode::OK);
    let task = json_body(task_response).await;
    assert_eq!(task["metadata"]["title"], "First mobile task");
    assert_eq!(task["metadata"]["accessMode"], "restricted");
    assert!(!task
        .to_string()
        .contains(server.project_path.to_str().unwrap()));

    let access_path = format!("/api/v1/tasks/{task_id}/access");
    let access_command = uuid::Uuid::new_v4().to_string();
    let expected_revision = task["task"]["revision"].as_u64().unwrap();
    let request = server.post_json(
        &access_path,
        json!({
            "commandId":access_command,
            "expectedRevision":expected_revision,
            "accessMode":"full",
        }),
    );
    let updated = server.request(request).await;
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = json_body(updated).await;
    assert_eq!(updated["status"], "updated");
    assert_eq!(updated["accessMode"], "full");
    assert_eq!(updated["revision"], expected_revision + 1);
    let replay = server
        .request(server.post_json(
            &access_path,
            json!({
                "commandId":access_command,
                "expectedRevision":expected_revision,
                "accessMode":"full",
            }),
        ))
        .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(json_body(replay).await, updated);
    let conflicting_replay = server
        .request(server.post_json(
            &access_path,
            json!({
                "commandId":access_command,
                "expectedRevision":expected_revision,
                "accessMode":"restricted",
            }),
        ))
        .await;
    assert_eq!(conflicting_replay.status(), StatusCode::CONFLICT);
    let stale = server
        .request(server.post_json(
            &access_path,
            json!({
                "commandId":uuid::Uuid::new_v4().to_string(),
                "expectedRevision":expected_revision,
                "accessMode":"restricted",
            }),
        ))
        .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let manual = server
        .request(server.post_json(
            &access_path,
            json!({
                "commandId":uuid::Uuid::new_v4().to_string(),
                "expectedRevision":updated["revision"],
                "accessMode":"manual",
            }),
        ))
        .await;
    assert_eq!(manual.status(), StatusCode::BAD_REQUEST);
    let metadata = server
        .request(server.auth_get(&format!("/api/v1/tasks/{task_id}")))
        .await;
    assert_eq!(json_body(metadata).await["metadata"]["accessMode"], "full");

    let send = server.post_json(
        &format!("/api/v1/tasks/{task_id}/messages"),
        json!({"commandId":uuid::Uuid::new_v4().to_string(),"text":"do not call a provider"}),
    );
    let send = server.request(send).await;
    assert_eq!(send.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(send).await["error"], "mobile-host-send-disabled");

    let send_extra = server.post_json(
        &format!("/api/v1/tasks/{task_id}/messages"),
        json!({"commandId":uuid::Uuid::new_v4().to_string(),"text":"ignored","codexHome":"/secret","executable":"/secret/bin/codex","model":"untrusted"}),
    );
    assert_eq!(
        server.request(send_extra).await.status(),
        StatusCode::BAD_REQUEST
    );

    let cancel = server
        .request(server.post_json(
            &format!("/api/v1/commands/{}/cancel", uuid::Uuid::new_v4()),
            json!({}),
        ))
        .await;
    assert_eq!(cancel.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(cancel).await["error"], "mobile-command-not-found");

    // Even an authenticated request cannot surface the old unauthenticated
    // bootstrap metadata endpoint as a mobile API bypass.
    let listed = server.request(server.auth_get("/api/v1/workspace")).await;
    let listed = json_body(listed).await;
    assert_eq!(listed["capabilities"]["send"], false);
    assert_eq!(listed["capabilities"]["changeAccessMode"], true);
    assert_eq!(
        listed["capabilities"]["allowedAccessModes"],
        json!(["restricted", "full"])
    );
    assert_eq!(listed["model"], "");
    assert_eq!(listed["tasks"][0]["id"], task_id);
    assert_eq!(listed["tasks"][0]["accessMode"], "full");
    server.shutdown().await;
}
