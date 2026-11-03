<a id="history"></a>
# Chats and history

## Conversations

The Chat screen can create separate conversations, search history, rename, open and delete them. Starting a new conversation preserves the previous one. History and drafts are restored after restarting the application.

Conversations support pinning, archiving, and date/project filters. Message actions create a branch at the selected point, edit a user message, or regenerate an answer. Editing and regeneration create new conversations and preserve the original transcript.

JSON export preserves supported messages and attachments. Markdown is a readable export without binary media data. Import accepts Aplot's own export formats and assigns new identifiers instead of overwriting existing conversations.

## Context and temporary mode

Context and tools provides global chat instructions, shared project instructions, and conversation instructions. Linking a project includes its confirmed memory; project instructions also apply to new agent sessions. Context is sent only to the explicitly selected connection.

A temporary conversation exists only in the current application's memory. Local persistence, exports, project instructions, and project memory are disabled. This mode does not control the external provider's or runtime's own records.

## Tools and structured responses

Web search can be enabled for an OpenAI connection. Availability depends on the model and account; API tools may incur separate charges. This switch does not add web search to local chat or Claude.

[RichContent.tsx](../../../src/features/chat/RichContent.tsx) renders typed sources, tool states, artifact references, tables, and simple charts. The Responses stream persists these blocks and available token usage with the message. Unknown blocks have a safe fallback and arbitrary HTML is not executed. Interrupted tools do not remain active after cancellation or history restoration.

[ChatView.tsx](../../../src/views/ChatView.tsx) renders history and messages; [store.ts](../../../src/features/chat/store.ts) owns conversations and current streams. Conversation IDs are independent of server IDs: multiple conversations can use one model, and a response keeps updating its original conversation when the selected history changes.

## Project files

Selecting a project exposes its file library under Context and tools. Import creates an independent copy; changing the source does not change a saved version. Importing the same latest bytes reuses that version. A changed file with the same name creates the next version.

Search covers filenames and UTF-8, DOCX, and XLSX text. PDFs and images are searchable by filename. DOCX supplies main-document text; headers, footers, footnotes, comments, and embedded images are excluded. XLSX supplies sheet names, cell addresses, and stored values: formulas are not evaluated and missing cached values are explicitly labeled. Cell formatting is not applied, so dates may remain Excel serial numbers.

Imports allow files up to 25 MiB; images are limited to 5 MiB, PDFs to 10 MiB, and plain UTF-8 text to 200,000 bytes. Office extraction supplies at most 200,000 text bytes with a truncation notice. ZIP/XML reads are bounded; macros, formulas, and external links are never executed.

Attach adds a snapshot to the draft; the selected model receives it only after Send. Save as exports the original saved bytes, including the original DOCX/XLSX. The library and drafts survive restart. Removing a version deletes its metadata and index while preserving the source; previously attached snapshots remain in history. Temporary conversations do not use the project library.

Native commands in [project_files.rs](../../../src-tauri/src/project_files.rs) verify project ownership and hashes. [document_text.rs](../../../src-tauri/src/document_text.rs) also handles direct DOCX/XLSX attachment. Managed storage paths never enter the renderer.

## Creating documents

The project library's Create document action builds DOCX, PDF, or XLSX locally. Text documents support paragraphs, three heading levels, bullet lists, and Markdown tables. XLSX accepts pasted CSV: the first row supplies headers and remaining rows supply worksheet cells. CSV values remain literal text, including leading `=`; no automatic formula conversion occurs.

The result becomes a project file version immediately. DOCX/XLSX offer extracted-text preview, and Save as exports the original file. This preview does not reproduce Office layout. Creating a file neither sends a chat message nor requires a model connection.

PDF embeds Noto Sans with Cyrillic and supports wrapped lines, page breaks, and paginated tables. Unsupported glyphs produce a clear error suggesting DOCX. Complex-script shaping and interactive PDF forms are unsupported. Limits include 64,000 text bytes, 100 blocks, and 8 columns/200 rows per text table; workbooks allow up to 16 sheets and 10,000 cells. Arbitrary code and macros are not executed.

## Storage

[history.ts](../../../src/features/chat/history.ts) batches frequent updates, saves changed conversations and flushes writes before normal shutdown. [chatHistory.ts](../../../src/services/chatHistory.ts) accesses SQLite through native commands; browser previews use localStorage.

Messages, attachments and drafts are stored locally. History excludes saved API keys, launch settings and authentication objects. A read failure does not overwrite existing history with an empty list. Interrupted generations are restored as stopped.

## Model binding

[historyModel.ts](../../../src/features/chat/historyModel.ts) stores target metadata only. Local bindings include the run and generation, model and start time. Cloud bindings include the provider, connection profile and model. When the original target is unavailable, history remains readable; continuing with another model requires an explicit connection choice. History is never silently sent to another server.

The Continue with saved context action creates a new conversation for the selected target and copies messages, attachments and the draft. The original conversation remains intact. The first conversation waits until run initialization completes before binding its target.

## Responsiveness

Text input updates immediately. Persistence runs separately from input and message rendering. [motion.css](../../../src/styles/kontur/motion.css) defines brief visual feedback; the operating system reduced-motion preference disables animations. [viewModules.ts](../../../src/lib/viewModules.ts) preloads screens on hover, focus and idle time after initialization.

The transcript scrolls independently from the composer. Streaming follows the latest answer while the reader is at the bottom; scrolling to older messages pauses automatic following.
