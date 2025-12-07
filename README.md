# spawnee

Spawn and orchestrate Cursor Cloud Agents from task templates with dependency resolution, parallel execution, and automatic retries.

## Installation

```bash
npm install -g spawnee
```

## Quick Start

```bash
# Initialize a config file
spawnee init

# Edit .spawneerc.json with your API key

# Validate a template
spawnee validate my-tasks.yaml

# Dry run (preview without spawning agents)
spawnee run my-tasks.yaml --dry-run

# Execute the template
spawnee run my-tasks.yaml
```

## Configuration

spawnee supports three configuration methods with the following priority (highest to lowest):

1. **CLI flags** - Override everything
2. **Environment variables** - Override config file and defaults
3. **Config file** (`.spawneerc.json`) - Override defaults
4. **Built-in defaults**

### Configuration Options

| Option | CLI Flag | Environment Variable | Config Key | Default |
|--------|----------|---------------------|------------|---------|
| API Key | `--api-key, -k` | `SPAWNEE_API_KEY` | `apiKey` | (required) |
| API Base URL | `--api-url` | `SPAWNEE_API_URL` | `apiBaseUrl` | `https://api.cursor.com` |
| Max Concurrent | `--concurrency, -c` | `SPAWNEE_CONCURRENCY` | `maxConcurrent` | `10` |
| Poll Interval | `--poll-interval` | `SPAWNEE_POLL_INTERVAL` | `pollInterval` | `15000` (ms) |
| Default Timeout | `--timeout, -t` | `SPAWNEE_TIMEOUT` | `defaultTimeout` | `3600000` (ms) |
| State File | `--state-file` | `SPAWNEE_STATE_FILE` | `stateFile` | `.spawnee-state.json` |
| Config File | `--config` | `SPAWNEE_CONFIG` | - | `.spawneerc.json` |
| Verbose | `--verbose, -v` | `SPAWNEE_VERBOSE` | `verbose` | `false` |

### Config File

Create a `.spawneerc.json` file in your project root:

```json
{
  "apiKey": "your-cursor-api-key",
  "apiBaseUrl": "https://api.cursor.com",
  "maxConcurrent": 10,
  "pollInterval": 15000,
  "defaultTimeout": 3600000,
  "stateFile": ".spawnee-state.json",
  "verbose": false
}
```

Or generate one with:

```bash
spawnee init
```

### Environment Variables

```bash
export SPAWNEE_API_KEY="your-cursor-api-key"
export SPAWNEE_CONCURRENCY=5
export SPAWNEE_TIMEOUT=7200000
export SPAWNEE_VERBOSE=true
```

### CLI Flags

```bash
spawnee run my-tasks.yaml \
  --api-key "your-key" \
  --concurrency 5 \
  --timeout 7200000 \
  --poll-interval 10000 \
  --state-file ".my-state.json" \
  --verbose
```

## Commands

### `spawnee run <template>`

Execute a task template.

```bash
spawnee run my-tasks.yaml [options]
```

**Options:**
- `-k, --api-key <key>` - Cursor API key
- `--api-url <url>` - API base URL
- `-c, --concurrency <n>` - Max concurrent agents
- `-t, --timeout <ms>` - Default task timeout
- `--poll-interval <ms>` - Status poll interval
- `--state-file <path>` - State file for persistence
- `-d, --dry-run` - Preview without spawning agents
- `--no-persist` - Disable state persistence
- `-v, --verbose` - Enable verbose output

### `spawnee validate <template>`

Validate a task template without running it.

```bash
spawnee validate my-tasks.yaml
```

### `spawnee status`

Check status of running agents.

```bash
spawnee status [options]
```

**Options:**
- `-k, --api-key <key>` - Cursor API key
- `--api-url <url>` - API base URL

### `spawnee cancel <agent-id>`

Cancel a running agent.

```bash
spawnee cancel abc123def456
```

### `spawnee init`

Create a `.spawneerc.json` config file.

```bash
spawnee init          # Create config file
spawnee init --force  # Overwrite existing
```

### `spawnee config`

Show the resolved configuration (useful for debugging).

```bash
spawnee config
```

## Task Templates

Templates can be JSON or YAML. Here's a complete example:

```yaml
name: "My Task Plan"
repository:
  url: "https://github.com/your-org/your-repo"
  branch: "main"
  baseBranch: "develop"

defaults:
  model: "auto"
  timeout: 3600000
  retries: 2

context:
  instructions: |
    You are implementing features for a Node.js application.
    Follow existing code patterns and conventions.
  files:
    - "README.md"
    - "package.json"

tasks:
  - id: "setup"
    name: "Project Setup"
    priority: 100
    branch: "feature/setup"
    prompt: |
      Initialize the project structure:
      1. Create necessary directories
      2. Set up configuration files

  - id: "feature-a"
    name: "Feature A"
    dependsOn: ["setup"]
    priority: 80
    branch: "feature/a"
    prompt: |
      Implement Feature A with tests.
    files:
      - "src/features/"

  - id: "feature-b"
    name: "Feature B"
    dependsOn: ["setup"]
    priority: 80
    branch: "feature/b"
    prompt: |
      Implement Feature B with tests.

  - id: "integration"
    name: "Integration"
    dependsOn: ["feature-a", "feature-b"]
    priority: 60
    branch: "feature/integration"
    prompt: |
      Integrate features and add integration tests.
    validation:
      command: "npm test"
      successPattern: "passed"
```

### Template Schema

**Required fields:**
- `name` - Template name
- `repository.url` - GitHub repository URL
- `tasks` - Array of tasks

**Task fields:**
- `id` (required) - Unique task identifier
- `name` (required) - Human-readable name
- `prompt` (required) - Instructions for the agent
- `dependsOn` - Array of task IDs this task depends on
- `priority` - Higher runs first (default: 0)
- `branch` - Git branch for the task
- `files` - Files to include in context
- `timeout` - Task-specific timeout (ms)
- `retries` - Max retry attempts
- `complete` - Mark as already complete (skip)
- `validation.command` - Command to verify completion
- `validation.successPattern` - Expected output pattern

## Features

- **Dependency Resolution** - Tasks run in correct order based on `dependsOn`
- **Parallel Execution** - Independent tasks run concurrently (up to `maxConcurrent`)
- **Automatic Retries** - Failed tasks retry with configurable attempts
- **State Persistence** - Resume interrupted runs from where they left off
- **Validation** - Optional command validation for task completion
- **Dry Run** - Preview task graph without spawning agents

## Limits

- Maximum 256 concurrent agents per API key
- Usage-based pricing (same as Cursor Background Agents)

## Getting Your API Key

Get your Cursor API key from: **Cursor Dashboard → Integrations → User API Keys**

## License

MIT
