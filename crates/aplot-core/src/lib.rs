//! Small transport-independent primitives shared by Aplot server hosts.
//!
//! This first slice owns the task server's typed event fan-out. Persistence,
//! runtime ownership, and transport adapters remain in their respective hosts.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub mod delegation;
pub mod owned_job;
pub mod tasks;
pub mod workspace;
pub mod workspace_sync;

/// Events sent by the task host to subscribers.
///
/// The serialized representation matches the existing desktop channel
/// protocol. Transient frames are intentionally not journal events; Hermes
/// voice status and transcript frames use that live-only path.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerEvent {
    /// A committed, ordered page of task journal events.
    Events { events: Vec<Value> },
    /// A live-only frame associated with a task, such as voice capture state.
    Transient {
        #[serde(rename = "taskId")]
        task_id: String,
        frame: Value,
    },
    /// The requested replay cursor has fallen out of the retained journal.
    Resync,
}

/// A transport-specific sender for one task event subscription.
///
/// Returning an error marks this subscription as disconnected. A sender may
/// register or replace subscriptions while handling an event; the context
/// never holds its registry lock while calling this method.
pub trait EventSink: Send + Sync + 'static {
    fn send(&self, event: &ServerEvent) -> Result<(), String>;
}

/// Shared event context for a server host.
///
/// Subscriptions are keyed so a reloaded desktop webview can replace its old
/// channel. Publications are serialized as batches, while sink callbacks run
/// outside the registry lock. This keeps callbacks free to register a new
/// subscription without deadlocking. The context does not provide storage or
/// runtime ownership; those remain host responsibilities.
#[derive(Default)]
pub struct ServerContext {
    subscribers: Mutex<HashMap<String, Arc<dyn EventSink>>>,
    dispatch: Mutex<()>,
}

impl ServerContext {
    /// Add a subscription or replace the current sink for the same client ID.
    pub fn subscribe(&self, id: impl Into<String>, sink: Arc<dyn EventSink>) {
        self.subscribers.lock().unwrap().insert(id.into(), sink);
    }

    /// Publish a committed task event batch to the current subscribers.
    pub fn publish_events(&self, events: Vec<Value>) {
        if !events.is_empty() {
            self.publish(ServerEvent::Events { events });
        }
    }

    /// Publish a live-only task frame, preserving voice event behavior.
    pub fn publish_transient(&self, task_id: impl Into<String>, frame: Value) {
        self.publish(ServerEvent::Transient {
            task_id: task_id.into(),
            frame,
        });
    }

    /// Publish one typed event to each subscriber.
    ///
    /// Concurrent publications are dispatched one at a time so all current
    /// sinks see complete batches in the same order. Failed sinks are removed
    /// only if they are still the registered sink; a replacement installed
    /// during a callback is retained.
    pub fn publish(&self, event: ServerEvent) {
        let _dispatch = self.dispatch.lock().unwrap();
        let subscribers = self
            .subscribers
            .lock()
            .unwrap()
            .iter()
            .map(|(id, sink)| (id.clone(), Arc::clone(sink)))
            .collect::<Vec<_>>();

        let failed = subscribers
            .into_iter()
            .filter_map(|(id, sink)| sink.send(&event).is_err().then_some((id, sink)))
            .collect::<Vec<_>>();

        if !failed.is_empty() {
            let mut current = self.subscribers.lock().unwrap();
            for (id, failed_sink) in failed {
                if current
                    .get(&id)
                    .is_some_and(|sink| Arc::ptr_eq(sink, &failed_sink))
                {
                    current.remove(&id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{EventSink, ServerContext, ServerEvent};
    use serde_json::json;
    use std::sync::{Arc, Barrier, Mutex, Weak};
    use std::thread;

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<ServerEvent>>);

    impl EventSink for RecordingSink {
        fn send(&self, event: &ServerEvent) -> Result<(), String> {
            self.0.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    struct FailingSink {
        entered: Arc<Barrier>,
        resume: Arc<Barrier>,
        attempts: Mutex<usize>,
    }

    impl EventSink for FailingSink {
        fn send(&self, _: &ServerEvent) -> Result<(), String> {
            *self.attempts.lock().unwrap() += 1;
            self.entered.wait();
            self.resume.wait();
            Err("channel closed".into())
        }
    }

    struct ResubscribingSink {
        context: Weak<ServerContext>,
        replacement: Arc<RecordingSink>,
        received: Mutex<usize>,
    }

    impl EventSink for ResubscribingSink {
        fn send(&self, _: &ServerEvent) -> Result<(), String> {
            *self.received.lock().unwrap() += 1;
            self.context
                .upgrade()
                .unwrap()
                .subscribe("client", self.replacement.clone());
            Ok(())
        }
    }

    fn received(sink: &RecordingSink) -> Vec<ServerEvent> {
        sink.0.lock().unwrap().clone()
    }

    #[test]
    fn fanout_preserves_batch_order_and_live_transient_frames() {
        let context = ServerContext::default();
        let first = Arc::new(RecordingSink::default());
        let second = Arc::new(RecordingSink::default());
        context.subscribe("first", first.clone());
        context.subscribe("second", second.clone());

        let first_batch = vec![json!({"seq": 1, "kind": "turn.started"})];
        let second_batch = vec![json!({"seq": 2, "kind": "message.delta"})];
        let voice_frame = json!({"type":"voice.transcript", "text":"hello"});
        context.publish_events(first_batch.clone());
        context.publish_events(second_batch.clone());
        context.publish_transient("task-1", voice_frame.clone());

        let expected = vec![
            ServerEvent::Events {
                events: first_batch,
            },
            ServerEvent::Events {
                events: second_batch,
            },
            ServerEvent::Transient {
                task_id: "task-1".into(),
                frame: voice_frame,
            },
        ];
        assert_eq!(received(&first), expected);
        assert_eq!(received(&second), expected);
    }

    #[test]
    fn event_payloads_keep_the_desktop_wire_shape() {
        assert_eq!(
            serde_json::to_value(ServerEvent::Events {
                events: vec![json!({"seq": 4})],
            })
            .unwrap(),
            json!({"type":"events", "events":[{"seq":4}]})
        );
        assert_eq!(
            serde_json::to_value(ServerEvent::Transient {
                task_id: "task-2".into(),
                frame: json!({"type":"voice.status", "state":"listening"}),
            })
            .unwrap(),
            json!({"type":"transient", "taskId":"task-2", "frame":{"type":"voice.status", "state":"listening"}})
        );
        assert_eq!(
            serde_json::to_value(ServerEvent::Resync).unwrap(),
            json!({"type":"resync"})
        );
    }

    #[test]
    fn a_failed_sink_does_not_remove_a_concurrent_replacement() {
        let context = Arc::new(ServerContext::default());
        let entered = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        let failing = Arc::new(FailingSink {
            entered: entered.clone(),
            resume: resume.clone(),
            attempts: Mutex::new(0),
        });
        let replacement = Arc::new(RecordingSink::default());
        context.subscribe("client", failing.clone());

        let publishing_context = context.clone();
        let publisher = thread::spawn(move || {
            publishing_context.publish_events(vec![json!({"seq":1})]);
        });

        entered.wait();
        context.subscribe("client", replacement.clone());
        resume.wait();
        publisher.join().unwrap();

        context.publish_events(vec![json!({"seq":2})]);
        assert_eq!(*failing.attempts.lock().unwrap(), 1);
        assert_eq!(
            received(&replacement),
            vec![ServerEvent::Events {
                events: vec![json!({"seq":2})],
            }]
        );
    }

    #[test]
    fn a_sink_can_register_a_replacement_during_delivery() {
        let context = Arc::new(ServerContext::default());
        let replacement = Arc::new(RecordingSink::default());
        let resubscribing = Arc::new(ResubscribingSink {
            context: Arc::downgrade(&context),
            replacement: replacement.clone(),
            received: Mutex::new(0),
        });
        context.subscribe("client", resubscribing.clone());

        context.publish_events(vec![json!({"seq":1})]);
        context.publish_events(vec![json!({"seq":2})]);

        assert_eq!(*resubscribing.received.lock().unwrap(), 1);
        assert_eq!(
            received(&replacement),
            vec![ServerEvent::Events {
                events: vec![json!({"seq":2})],
            }]
        );
    }
}
