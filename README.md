# Converge

A local-first Obsidian plugin for chatting with LLMs using your vault notes as context. Designed for government environments with strict IT policies.

## Features (v1.0)

- **Chat Interface** - Clean sidebar panel for conversations
- **Drag & Drop Context** - Drag notes into the chat to provide context to the LLM
- **OpenAI-Compatible API** - Works with any OpenAI-compatible endpoint (OpenAI, OpenRouter, Azure, self-hosted)
- **Token Counter** - Track context usage with color-coded warnings (yellow at 80%, red at 95%)
- **Export Chats** - Save conversations as markdown files to your vault
- **Personalization** - Set your name for friendly, personalized responses
- **Markdown Rendering** - Assistant responses render with full markdown support

## Why Converge?

Built for environments where:
- External dependencies need security approval
- Code must be auditable by IT teams
- Local-first, privacy-respecting solutions are required

## Auditability

- **Zero runtime dependencies** - only dev dependencies for building
- **~600 lines of TypeScript** - readable, single-file source
- **22KB built output** - small, inspectable
- **Single external call** - only `fetch()` to your configured API endpoint
- **No telemetry, no analytics**

## Installation

1. Copy `main.js`, `styles.css`, and `manifest.json` to your vault's `.obsidian/plugins/converge-obsidian/` folder
2. Enable the plugin in Obsidian Settings → Community plugins
3. Configure your API endpoint and key in plugin settings

## Configuration

| Setting | Description |
|---------|-------------|
| API Endpoint | OpenAI-compatible chat completions URL |
| API Key | Your API key (stored locally) |
| Model Name | Model identifier (e.g., `gpt-4o-mini`) |
| Your Name | How the assistant addresses you |
| System Prompt | Instructions for the assistant |
| Max Context Tokens | Token limit for the counter |
| Export Folder | Where chat exports are saved |

## Building from Source

```bash
npm install
npm run build
```

## License

MIT

## Author

Yeo Yong Kiat
