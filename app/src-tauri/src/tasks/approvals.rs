//! Tool approval state machine.
//!
//! `pending` is the only non-terminal state. The first valid answer wins; a
//! later answer from another client sees the recorded outcome instead of
//! creating a second permission. An approval belongs to one runtime generation
//! and is never applied to a restarted worker.
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Pending,
    Approved,
    Denied,
    Expired,
    Stale,
}

impl Status {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "approved" => Self::Approved,
            "denied" => Self::Denied,
            "expired" => Self::Expired,
            "stale" => Self::Stale,
            _ => return None,
        })
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Stale => "stale",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event<'a> {
    /// A person answered. `decision` is the client result (`choice` or `answers`).
    Resolve {
        decision: &'a Value,
        runtime_alive: bool,
    },
    /// The turn ended or the runtime withdrew the request.
    Expire,
    /// The worker that asked is gone (restart, crash, sign-out).
    Invalidate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Moved(Status),
    /// Terminal already; report the recorded status without side effects.
    AlreadyResolved(Status),
}

pub(crate) fn transition(current: Status, event: Event<'_>) -> Outcome {
    if current != Status::Pending {
        return Outcome::AlreadyResolved(current);
    }
    Outcome::Moved(match event {
        Event::Resolve {
            runtime_alive: false,
            ..
        }
        | Event::Invalidate => Status::Stale,
        Event::Expire => Status::Expired,
        Event::Resolve { decision, .. } => {
            if decision.get("choice").and_then(Value::as_str) == Some("deny") {
                Status::Denied
            } else {
                Status::Approved
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_answer_wins() {
        let once = json!({"choice":"once"});
        let deny = json!({"choice":"deny"});
        assert_eq!(
            transition(
                Status::Pending,
                Event::Resolve {
                    decision: &once,
                    runtime_alive: true
                }
            ),
            Outcome::Moved(Status::Approved)
        );
        assert_eq!(
            transition(
                Status::Approved,
                Event::Resolve {
                    decision: &deny,
                    runtime_alive: true
                }
            ),
            Outcome::AlreadyResolved(Status::Approved)
        );
        assert_eq!(
            transition(
                Status::Pending,
                Event::Resolve {
                    decision: &deny,
                    runtime_alive: true
                }
            ),
            Outcome::Moved(Status::Denied)
        );
    }

    #[test]
    fn clarify_answers_count_as_approval() {
        let answers = json!({"answers":{"q":"yes"}});
        assert_eq!(
            transition(
                Status::Pending,
                Event::Resolve {
                    decision: &answers,
                    runtime_alive: true
                }
            ),
            Outcome::Moved(Status::Approved)
        );
    }

    #[test]
    fn a_dead_runtime_never_receives_a_permission() {
        let once = json!({"choice":"once"});
        assert_eq!(
            transition(
                Status::Pending,
                Event::Resolve {
                    decision: &once,
                    runtime_alive: false
                }
            ),
            Outcome::Moved(Status::Stale)
        );
        assert_eq!(
            transition(Status::Pending, Event::Invalidate),
            Outcome::Moved(Status::Stale)
        );
    }

    #[test]
    fn terminal_states_do_not_move() {
        for status in [
            Status::Approved,
            Status::Denied,
            Status::Expired,
            Status::Stale,
        ] {
            assert_eq!(
                transition(status, Event::Expire),
                Outcome::AlreadyResolved(status)
            );
            assert_eq!(
                transition(status, Event::Invalidate),
                Outcome::AlreadyResolved(status)
            );
            assert_eq!(Status::parse(status.as_str()), Some(status));
        }
        assert_eq!(
            transition(Status::Pending, Event::Expire),
            Outcome::Moved(Status::Expired)
        );
    }
}
