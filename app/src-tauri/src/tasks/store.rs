//! Desktop re-export of the shared task store.

pub(crate) use aplot_core::tasks::store::*;

// `cfg(test)` on a dependency is evaluated while compiling that dependency,
// not the desktop crate. Keep desktop-only tests on the shared schema without
// exposing a test helper as part of the core crate's production API.
#[cfg(test)]
pub(crate) fn test_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
    )
    .unwrap();
    aplot_core::tasks::store::create_schema(&conn).unwrap();
    conn
}
