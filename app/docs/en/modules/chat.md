<a id="history"></a>
# Chats and history

## Conversations

The Chat screen can create separate conversations, search history, rename, open and delete them. Starting a new conversation preserves the previous one. History and drafts are restored after restarting the application.

[ChatView.tsx](../../../src/views/ChatView.tsx) renders history and messages; [store.ts](../../../src/features/chat/store.ts) owns conversations and current streams. Conversation IDs are independent of server IDs: multiple conversations can use one model, and a response keeps updating its original conversation when the selected history changes.

## Storage

[history.ts](../../../src/features/chat/history.ts) batches frequent updates, saves changed conversations and flushes writes before normal shutdown. [chatHistory.ts](../../../src/services/chatHistory.ts) accesses SQLite through native commands; browser previews use localStorage.

Messages, attachments and drafts are stored locally. History excludes saved API keys, launch settings and authentication objects. A read failure does not overwrite existing history with an empty list. Interrupted generations are restored as stopped.

## Model binding

[historyModel.ts](../../../src/features/chat/historyModel.ts) stores target metadata only. Local bindings include the run and generation, model and start time. Cloud bindings include the provider, connection profile and model. When the original target is unavailable, history remains readable; continuing with another model requires an explicit connection choice. History is never silently sent to another server.

The Continue with saved context action creates a new conversation for the selected target and copies messages, attachments and the draft. The original conversation remains intact. The first conversation waits until run initialization completes before binding its target.

## Responsiveness

Text input updates immediately. Persistence runs separately from input and message rendering. [motion.css](../../../src/styles/kontur/motion.css) defines brief visual feedback; the operating system reduced-motion preference disables animations. [viewModules.ts](../../../src/lib/viewModules.ts) preloads screens on hover, focus and idle time after initialization.

The transcript scrolls independently from the composer. Streaming follows the latest answer while the reader is at the bottom; scrolling to older messages pauses automatic following.
