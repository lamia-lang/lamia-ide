# Using Lamia Chat

The Lamia Chat panel is an AI assistant built into the IDE. It can answer questions about Lamia, generate Lamia projects from scratch, edit files in your projects, fix issues in your code, and more.

## Opening the Chat

- Press `Cmd+Shift+L` (macOS) or `Ctrl+Shift+L` (Windows/Linux)
- Or click the chat icon in the secondary sidebar

## Sending Messages

Type your message in the text area and press `Enter` to send. Use `Shift+Enter` for a new line.

## Attaching Files

You can give the assistant context about specific files:

- **@-mention**: Type `@` followed by a filename to search project files and attach them
- **SHIFT button + Drag and drop**: Drag files from the explorer into the chat input area (hold Shift while dragging)
- **Copy with context**: When you copy code from the editor (`Cmd+C`), the file path and line numbers are automatically tracked and attached to your next message

## Chat Features

### New Chat

Click the `+` button in the chat header to start a fresh conversation. You always load the previous chats from the chat history.

### Chat History

Click the clock icon in the chat header to browse previous conversations. Click any chat to reload it. Delete chats with the `×` button.

### Model Selection

Use the model dropdown in the chat header to switch between available models.See [API Keys & Models](api-keys-and-models.md) documentation about what models are available and how to add more models.

### Stop Generation

Click the **Stop** button to cancel a response in progress. The input will be restored so you can edit and resend.

### Retry

If a response fails, click the **Retry** button on the error message. If the assistant completed some steps before the error, it will continue from where it left off.

## Tool Usage

The assistant can use tools during a conversation.

Tool progress is shown as a step-by-step log with checkmarks (✓) or error indicators (✗).

## File Changes

When the assistant creates or modifies files, a summary appears below the response:

- **Created**: new file was written
- **Modified**: existing file was changed — click **View Diff** to see before/after, **Open** to jump to the file in the editor

## Code Blocks

Code snippets in responses have action buttons:

- **Copy** — copy the code to clipboard
- **Insert** — insert the code at the cursor position in the active editor
