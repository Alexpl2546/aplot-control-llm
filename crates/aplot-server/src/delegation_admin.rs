//! Host-owned task-tool entry points. No network/model approval route exists.
use crate::ServerData;
use aplot_core::{
    delegation::{
        self, DelegationReceipt, PrepareDelegation, ProposalDecision, ProposalReceipt,
        ProposalRecord, ProposalRequest, ProposalResolution, ProposalResolver,
    },
    tasks::store,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io;

/// Only tool arguments are deserialized. Caller identity/generation are supplied
/// separately by the host's authenticated task capability.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateArguments {
    pub agent_id: String,
    pub prompt: String,
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalArguments {
    pub name: String,
    pub title: String,
    pub instructions: String,
}

impl ServerData {
    /// Prepare durable work only; a runtime supervisor must consume the queue.
    pub fn request_delegation(
        &mut self,
        caller_task_id: &str,
        caller_generation: u64,
        command_id: &str,
        args: DelegateArguments,
    ) -> io::Result<DelegationReceipt> {
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(
                &json!({"kind":"delegate","callerTaskId":caller_task_id,"callerGeneration":caller_generation,"arguments":args})
            )?)
        );
        let tx = self.tasks.transaction().map_err(io::Error::other)?;
        let child_task_id = uuid::Uuid::new_v4().to_string();
        let receipt = delegation::prepare_delegation(
            &tx,
            PrepareDelegation {
                caller_task_id: caller_task_id.into(),
                caller_generation,
                command_id: command_id.into(),
                request_hash: hash,
                child_task_id: child_task_id.clone(),
                turn_id: uuid::Uuid::new_v4().to_string(),
                message_id: uuid::Uuid::new_v4().to_string(),
                preset_id: args.agent_id,
                project_id: args.project_id,
                prompt: args.prompt,
                created_at_ms: store::millis(),
            },
        )
        .map_err(io::Error::other)?;
        if receipt.task_id == child_task_id {
            crate::runtime_session::inherit_execution(&tx, caller_task_id, &receipt.task_id)
                .map_err(io::Error::other)?;
        }
        tx.commit().map_err(io::Error::other)?;
        Ok(receipt)
    }

    pub fn request_agent_proposal(
        &mut self,
        caller_task_id: &str,
        caller_generation: u64,
        command_id: &str,
        args: AgentProposalArguments,
    ) -> io::Result<ProposalReceipt> {
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(
                &json!({"kind":"agent-proposal","callerTaskId":caller_task_id,"callerGeneration":caller_generation,"arguments":args})
            )?)
        );
        let tx = self.tasks.transaction().map_err(io::Error::other)?;
        let receipt = delegation::create_proposal(
            &tx,
            ProposalRequest {
                caller_task_id: caller_task_id.into(),
                caller_generation,
                proposal_id: uuid::Uuid::new_v4().to_string(),
                command_id: command_id.into(),
                request_hash: hash,
                name: args.name,
                title: args.title,
                instructions: args.instructions,
                created_at_ms: store::millis(),
            },
        )
        .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        Ok(receipt)
    }

    /// The control surface must derive `resolver` from host authorization;
    /// this method must never be registered as an LLM tool or raw JSON RPC.
    pub fn review_agent_proposal(
        &mut self,
        proposal_id: &str,
        resolver: ProposalResolver,
        decision: ProposalDecision,
    ) -> io::Result<ProposalReceipt> {
        let tx = self.tasks.transaction().map_err(io::Error::other)?;
        let receipt = delegation::resolve_proposal(
            &tx,
            ProposalResolution {
                proposal_id: proposal_id.into(),
                resolver,
                decision,
                agent_id: Some(uuid::Uuid::new_v4().to_string()),
                resolved_at_ms: store::millis(),
            },
        )
        .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        Ok(receipt)
    }

    pub fn pending_agent_proposals(&self) -> io::Result<Vec<ProposalRecord>> {
        delegation::pending_proposals(&self.tasks).map_err(io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_tool_arguments_cannot_supply_host_identity_or_approve_their_own_proposal() {
        assert!(serde_json::from_value::<DelegateArguments>(
            json!({"agentId":"a","prompt":"p","projectId":null,"callerTaskId":"other"})
        )
        .is_err());
        assert!(serde_json::from_value::<AgentProposalArguments>(
            json!({"name":"a","title":"t","instructions":"i","resolver":"Admin"})
        )
        .is_err());
    }

    #[test]
    fn server_owns_queued_children_and_proposals_across_reopen() {
        let directory =
            std::env::temp_dir().join(format!("aplot-delegation-host-{}", uuid::Uuid::new_v4()));
        let project_root = directory.join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let data_dir = directory.join("server");
        let mut server = ServerData::open(&data_dir).unwrap();
        let project = server.register_project(&project_root, "p").unwrap();
        let parent = server
            .new_task(project["project"]["id"].as_str().unwrap(), "parent")
            .unwrap();
        let parent_id = parent["task"]["id"].as_str().unwrap();
        let saved = aplot_core::workspace::read_saved(&server.tasks)
            .unwrap()
            .unwrap();
        let mut data = saved["data"].clone();
        data["presets"] = json!([{"id":"specialist","name":"Specialist","runtime":"codex","instructions":"Review code","accessMode":"full"}]);
        aplot_core::workspace::write_saved(
            &mut server.tasks,
            data,
            saved["revision"].as_u64().unwrap(),
        )
        .unwrap();
        let tx = server.tasks.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        journal
            .edit_state(parent_id, |state| {
                state.pending = true;
                state.live = true;
                state.native_generation = Some(7);
            })
            .unwrap();
        drop(journal);
        tx.commit().unwrap();
        let args = DelegateArguments {
            agent_id: "specialist".into(),
            prompt: "Review only".into(),
            project_id: None,
        };
        let child = server
            .request_delegation(parent_id, 7, "delegate-command", args.clone())
            .unwrap();
        assert_eq!(child.status, "queued");
        assert_eq!(
            child,
            server
                .request_delegation(parent_id, 7, "delegate-command", args)
                .unwrap()
        );
        assert_eq!(
            store::read_task(&server.tasks, &child.task_id)
                .unwrap()
                .unwrap()
                .config
                .access_mode
                .as_deref(),
            Some("restricted")
        );
        // Replaying old accepted work must not adopt a profile installed on
        // its parent afterwards. The original unbound child stays unbound.
        {
            let tx = server.tasks.transaction().unwrap();
            let mut profile = crate::codex_runtime::CodexRunConfig {
                executable: std::env::current_exe().unwrap(),
                codex_home: directory.join("later-profile"),
                working_directory: project_root.clone(),
                model: "later-model".into(),
                timeout: std::time::Duration::from_secs(1),
                access_mode: None,
                resume_thread_id: None,
            };
            crate::runtime_session::bind(&tx, parent_id, &mut profile).unwrap();
            crate::runtime_session::attach_account(&tx, parent_id, &"b".repeat(64)).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            server
                .request_delegation(
                    parent_id,
                    7,
                    "delegate-command",
                    DelegateArguments {
                        agent_id: "specialist".into(),
                        prompt: "Review only".into(),
                        project_id: None,
                    }
                )
                .unwrap(),
            child
        );
        assert!(!crate::runtime_session::has_binding(&server.tasks, &child.task_id).unwrap());
        let proposal = server
            .request_agent_proposal(
                parent_id,
                7,
                "proposal-command",
                AgentProposalArguments {
                    name: "New agent".into(),
                    title: "Reviewer".into(),
                    instructions: "Read code".into(),
                },
            )
            .unwrap();
        assert_eq!(proposal.status, "pending");
        assert!(server
            .review_agent_proposal(
                &proposal.proposal_id,
                ProposalResolver::Model,
                ProposalDecision::Approve
            )
            .is_err());
        assert_eq!(server.pending_agent_proposals().unwrap().len(), 1);
        drop(server);
        let reopened = ServerData::open(&data_dir).unwrap();
        assert!(reopened.pending_agent_proposals().unwrap().is_empty());
        assert_eq!(
            delegation::read_proposal(&reopened.tasks, &proposal.proposal_id)
                .unwrap()
                .unwrap()
                .status,
            "stale"
        );
        assert_eq!(
            store::turns(&reopened.tasks, &child.task_id, "queued")
                .unwrap()
                .len(),
            1
        );
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
