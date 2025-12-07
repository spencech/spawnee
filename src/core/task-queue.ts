import { EventEmitter } from 'events';

export interface Task {
  id: string;
  name: string;
  prompt: string;
  dependsOn: string[];
  priority: number;
  branch?: string;
  files?: string[];
  timeout?: number;
  retries?: number;
  validation?: { command: string; successPattern: string };
  complete?: boolean;
  status: TaskStatus;
  agentId?: string;
  attempts: number;
  error?: string;
  result?: TaskResult;
}

export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed';

export interface TaskResult {
  branch?: string;
  pullRequestUrl?: string;
  completedAt: string;
}

export type TaskInput = Omit<Task, 'status' | 'attempts' | 'agentId' | 'error' | 'result'>;

export class TaskQueue extends EventEmitter {
  private tasks: Map<string, Task> = new Map();
  private completed: Set<string> = new Set();

  addTask(input: TaskInput): void {
    const task: Task = { ...input, status: 'pending', attempts: 0 };
    this.tasks.set(task.id, task);
    
    // If task is marked as complete, mark it as completed immediately
    if (task.complete) {
      this.markCompleted(task.id, { completedAt: new Date().toISOString() }, false);
    } else {
      this.updateReadyTasks();
    }
  }

  addTasks(inputs: TaskInput[]): void {
    inputs.forEach(input => {
      const task: Task = { ...input, status: 'pending', attempts: 0 };
      this.tasks.set(task.id, task);
      
      // If task is marked as complete, mark it as completed immediately
      if (task.complete) {
        this.markCompleted(task.id, { completedAt: new Date().toISOString() }, false);
      }
    });
    this.updateReadyTasks();
  }

  private updateReadyTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      const depsComplete = task.dependsOn.every(depId => this.completed.has(depId));
      if (!depsComplete) continue;
      task.status = 'ready';
      this.emit('taskReady', task);
    }
  }

  getReadyTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  markRunning(id: string, agentId: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'running';
    task.agentId = agentId;
    task.attempts++;
    this.emit('taskStarted', task);
  }

  markCompleted(id: string, result?: Partial<TaskResult>, checkComplete: boolean = true): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'completed';
    task.result = { ...result, completedAt: new Date().toISOString() };
    this.completed.add(id);
    this.emit('taskCompleted', task);
    this.updateReadyTasks();
    if (checkComplete) {
      this.checkAllComplete();
    }
  }

  markFailed(id: string, error: string, maxRetries: number = 2): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.error = error;

    if (task.attempts < (task.retries ?? maxRetries)) {
      task.status = 'ready';
      this.emit('taskRetry', task);
      return;
    }

    task.status = 'failed';
    this.emit('taskFailed', task);
    this.checkAllComplete();
  }

  private checkAllComplete(): void {
    const allDone = Array.from(this.tasks.values()).every(t => t.status === 'completed' || t.status === 'failed');
    if (allDone) this.emit('allComplete', this.getResults());
  }

  getResults(): { completed: Task[]; failed: Task[] } {
    const tasks = Array.from(this.tasks.values());
    return {
      completed: tasks.filter(t => t.status === 'completed'),
      failed: tasks.filter(t => t.status === 'failed'),
    };
  }

  getStatus(): Record<string, number> {
    const tasks = Array.from(this.tasks.values());
    return {
      pending: tasks.filter(t => t.status === 'pending').length,
      ready: tasks.filter(t => t.status === 'ready').length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      total: tasks.length,
    };
  }

  reset(): void {
    this.tasks.clear();
    this.completed.clear();
  }
}

