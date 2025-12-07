import { EventEmitter } from 'events';
import { CursorClient } from '../cursor/client.js';
import { CursorAgent } from '../cursor/types.js';
import { TaskQueue, Task, TaskInput } from './task-queue.js';
import { StateStore, OrchestratorState, SerializedTask } from '../storage/state-store.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';

export interface OrchestratorOptions {
  config: Config;
  stateStore?: StateStore;
  repository: string;
  baseBranch: string;
  globalContext?: string;
  globalFiles?: string[];
}

export class Orchestrator extends EventEmitter {
  private client: CursorClient;
  private queue: TaskQueue;
  private stateStore?: StateStore;
  private logger: Logger;
  private options: OrchestratorOptions;
  private activeAgents: Map<string, string> = new Map(); // agentId -> taskId
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;
  private templateName = '';

  constructor(options: OrchestratorOptions) {
    super();
    this.options = options;
    this.client = new CursorClient(options.config.apiKey, options.config.apiBaseUrl);
    this.queue = new TaskQueue();
    this.stateStore = options.stateStore;
    this.logger = new Logger('Orchestrator');
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.queue.on('taskReady', () => this.trySpawnAgents());

    this.queue.on('taskCompleted', (task: Task) => {
      this.logger.success(`Task completed: ${task.id}`);
      this.emit('taskCompleted', task);
      this.saveState();
    });

    this.queue.on('taskFailed', (task: Task) => {
      this.logger.error(`Task failed: ${task.id} - ${task.error}`);
      this.emit('taskFailed', task);
      this.saveState();
    });

    this.queue.on('taskRetry', (task: Task) => {
      this.logger.warn(`Retrying task: ${task.id} (attempt ${task.attempts + 1})`);
      this.emit('taskRetry', task);
    });

    this.queue.on('allComplete', (results) => {
      this.isRunning = false;
      this.client.stopAllMonitoring();
      this.clearAllTimeouts();
      this.logger.info('All tasks complete');
      this.emit('complete', results);
      this.stateStore?.clear();
    });

    this.client.on('completed', ({ agentId, ...agent }: { agentId: string } & CursorAgent) => {
      this.handleAgentComplete(agentId, agent);
    });

    this.client.on('failed', ({ agentId, ...agent }: { agentId: string } & CursorAgent) => {
      const errorMsg = (agent as any).summary || 'Agent failed';
      this.handleAgentFailed(agentId, errorMsg);
    });

    this.client.on('cancelled', ({ agentId }: { agentId: string }) => {
      this.handleAgentFailed(agentId, 'Agent was stopped');
    });

    this.client.on('error', ({ agentId, error }: { agentId: string; error: Error }) => {
      this.logger.error(`Agent ${agentId} error: ${error.message}`);
    });
  }

  loadTasks(templateName: string, tasks: TaskInput[]): void {
    this.templateName = templateName;
    this.queue.addTasks(tasks);
    const completedCount = tasks.filter(t => t.complete).length;
    const activeCount = tasks.length - completedCount;
    this.logger.info(`Loaded ${tasks.length} tasks from "${templateName}"${completedCount > 0 ? ` (${completedCount} already completed, ${activeCount} active)` : ''}`);
  }

  async start(): Promise<void> {
    if (this.isRunning) throw new Error('Orchestrator is already running');
    this.isRunning = true;
    this.logger.info('Starting orchestration...');
    this.emit('started', this.queue.getStatus());
    await this.saveState();
    await this.trySpawnAgents();
  }

  private async trySpawnAgents(): Promise<void> {
    if (!this.isRunning) return;

    const availableSlots = this.options.config.maxConcurrent - this.activeAgents.size;
    if (availableSlots <= 0) return;

    const readyTasks = this.queue.getReadyTasks().slice(0, availableSlots);

    for (const task of readyTasks) {
      try {
        await this.spawnAgent(task);
      } catch (error) {
        this.logger.error(`Failed to spawn agent for ${task.id}: ${error}`);
        this.queue.markFailed(task.id, (error as Error).message);
      }
    }
  }

  private async spawnAgent(task: Task): Promise<void> {
    const prompt = this.buildPrompt(task);
    this.logger.info(`Spawning agent for task: ${task.id}`);

    const agent = await this.client.createAgent({
      prompt,
      repository: this.options.repository,
      branchName: task.branch || `task/${task.id}`,
      ref: this.options.baseBranch,
      autoCreatePr: true,
    });

    this.activeAgents.set(agent.id, task.id);
    this.queue.markRunning(task.id, agent.id);
    this.client.startMonitoring(agent.id, this.options.config.pollInterval);

    const timeout = task.timeout || this.options.config.defaultTimeout;
    const timer = setTimeout(() => {
      if (!this.activeAgents.has(agent.id)) return;
      this.logger.warn(`Task ${task.id} timed out`);
      this.client.stopAgent(agent.id).catch(() => {});
      this.handleAgentFailed(agent.id, 'Timeout exceeded');
    }, timeout);
    this.timeouts.set(agent.id, timer);

    this.emit('agentSpawned', { taskId: task.id, agentId: agent.id });
    await this.saveState();
  }

  private buildPrompt(task: Task): string {
    const parts: string[] = [];

    if (this.options.globalContext) {
      parts.push(`## Global Instructions\n${this.options.globalContext}`);
    }

    if (this.options.globalFiles?.length) {
      parts.push(`## Reference Files\n${this.options.globalFiles.map(f => `- ${f}`).join('\n')}`);
    }

    // Add dependency context - reference previous agents' work
    if (task.dependsOn.length > 0) {
      const dependencyInfo: string[] = [];
      for (const depId of task.dependsOn) {
        const depTask = this.queue.getTask(depId);
        if (depTask?.result) {
          const branchInfo = depTask.result.branch ? ` (branch: ${depTask.result.branch})` : '';
          const prInfo = depTask.result.pullRequestUrl ? `\n   PR: ${depTask.result.pullRequestUrl}` : '';
          dependencyInfo.push(`- **${depTask.name}**${branchInfo}${prInfo}`);
        } else if (depTask) {
          dependencyInfo.push(`- **${depTask.name}** (in progress)`);
        }
      }
      if (dependencyInfo.length > 0) {
        parts.push(`## Dependencies\nThis task depends on the following completed tasks:\n${dependencyInfo.join('\n')}\n\nPlease review the work from these dependencies before proceeding. If they created documentation or files, reference those in your work.`);
      }
    }

    if (task.files?.length) {
      parts.push(`## Task-Specific Files\n${task.files.map(f => `- ${f}`).join('\n')}`);
    }

    parts.push(`## Task\n${task.prompt}`);

    if (task.validation) {
      parts.push(
        `## Validation\nAfter completing the task, verify by running:\n\`${task.validation.command}\`\nExpected output should match: ${task.validation.successPattern}`
      );
    }

    return parts.join('\n\n');
  }

  private handleAgentComplete(agentId: string, agent: CursorAgent): void {
    const taskId = this.activeAgents.get(agentId);
    if (!taskId) return;

    this.activeAgents.delete(agentId);
    this.clearTimeout(agentId);
    this.queue.markCompleted(taskId, { 
      branch: agent.target?.branchName, 
      pullRequestUrl: agent.target?.prUrl 
    });
    this.trySpawnAgents();
  }

  private handleAgentFailed(agentId: string, error: string): void {
    const taskId = this.activeAgents.get(agentId);
    if (!taskId) return;

    this.activeAgents.delete(agentId);
    this.clearTimeout(agentId);
    this.client.stopMonitoring(agentId);
    this.queue.markFailed(taskId, error);
    this.trySpawnAgents();
  }

  private clearTimeout(agentId: string): void {
    const timer = this.timeouts.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.timeouts.delete(agentId);
  }

  private clearAllTimeouts(): void {
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    this.timeouts.clear();
  }

  private async saveState(): Promise<void> {
    if (!this.stateStore) return;

    const tasks: SerializedTask[] = this.queue.getAllTasks().map(t => ({
      id: t.id,
      name: t.name,
      status: t.status,
      agentId: t.agentId,
      attempts: t.attempts,
      error: t.error,
      result: t.result,
    }));

    const state: OrchestratorState = {
      templateName: this.templateName,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repository: this.options.repository,
      tasks,
      activeAgents: Array.from(this.activeAgents.entries()).map(([agentId, taskId]) => ({ agentId, taskId })),
    };

    await this.stateStore.save(state);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.client.stopAllMonitoring();
    this.clearAllTimeouts();

    for (const agentId of this.activeAgents.keys()) {
      try {
        await this.client.stopAgent(agentId);
      } catch {
        // Ignore cancellation errors
      }
    }

    this.logger.info('Orchestrator stopped');
    this.emit('stopped', this.queue.getStatus());
  }

  getStatus(): { isRunning: boolean; queue: Record<string, number>; activeAgents: Array<{ agentId: string; taskId: string }> } {
    return {
      isRunning: this.isRunning,
      queue: this.queue.getStatus(),
      activeAgents: Array.from(this.activeAgents.entries()).map(([agentId, taskId]) => ({ agentId, taskId })),
    };
  }

  async sendFollowUp(taskId: string, message: string): Promise<void> {
    const task = this.queue.getTask(taskId);
    if (!task?.agentId) throw new Error(`No active agent for task ${taskId}`);
    await this.client.sendFollowUp(task.agentId, message);
  }
}

