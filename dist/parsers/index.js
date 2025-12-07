import { z } from 'zod';
import * as yaml from 'yaml';
import { readFileSync } from 'fs';
const ValidationSchema = z.object({
    command: z.string(),
    successPattern: z.string(),
}).optional();
const TaskSchema = z.object({
    id: z.string(),
    name: z.string(),
    prompt: z.string(),
    dependsOn: z.array(z.string()).default([]),
    files: z.array(z.string()).optional(),
    branch: z.string().optional(),
    priority: z.number().default(0),
    timeout: z.number().optional(),
    retries: z.number().optional(),
    validation: ValidationSchema,
    complete: z.boolean().optional(),
});
const RepositorySchema = z.object({
    url: z.string().url(),
    branch: z.string().default('main'),
    baseBranch: z.string().optional(),
});
const DefaultsSchema = z.object({
    model: z.enum(['auto', 'claude-4-opus', 'claude-4.5-opus-high-thinking', 'claude-4.5-sonnet-thinking', 'gemini-3-pro', 'gpt-4o', 'gpt-5.1-codex-high', 'gpt-5.1-codex-max-high-fast', 'gpt-5.1-codex-max-high', 'gpt-5.1-codex-max-low-fast', 'gpt-5.1-codex-max-low', 'gpt-5.1-codex-max-medium-fast', 'gpt-5.1-codex-max-xhigh-fast', 'gpt-5.1-codex-max-xhigh', 'gpt-5.1-codex-max', 'gpt-5.1-codex']).default('auto'),
    timeout: z.number().default(3600000),
    retries: z.number().default(2),
    createPR: z.boolean().default(true),
}).default({});
const ContextSchema = z.object({
    files: z.array(z.string()).default([]),
    instructions: z.string().optional(),
}).default({});
const TemplateSchema = z.object({
    name: z.string(),
    repository: RepositorySchema,
    defaults: DefaultsSchema,
    context: ContextSchema,
    tasks: z.array(TaskSchema).min(1, 'At least one task is required'),
});
export function parseTemplate(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const isYaml = filePath.endsWith('.yaml') || filePath.endsWith('.yml');
    const raw = isYaml ? yaml.parse(content) : JSON.parse(content);
    const validated = TemplateSchema.parse(raw);
    const tasks = validated.tasks.map(t => ({
        id: t.id,
        name: t.name,
        prompt: t.prompt,
        dependsOn: t.dependsOn,
        priority: t.priority,
        branch: t.branch,
        files: t.files,
        timeout: t.timeout ?? validated.defaults.timeout,
        retries: t.retries ?? validated.defaults.retries,
        validation: t.validation,
        complete: t.complete,
    }));
    validateDependencies(tasks);
    return {
        name: validated.name,
        repository: validated.repository,
        defaults: validated.defaults,
        context: validated.context,
        tasks,
    };
}
function validateDependencies(tasks) {
    const taskIds = new Set(tasks.map(t => t.id));
    const errors = [];
    for (const task of tasks) {
        for (const depId of task.dependsOn) {
            if (!taskIds.has(depId))
                errors.push(`Task "${task.id}" depends on unknown task "${depId}"`);
        }
    }
    if (hasCycle(tasks))
        errors.push('Circular dependency detected in task graph');
    if (errors.length > 0)
        throw new Error(`Template validation failed:\n${errors.join('\n')}`);
}
function hasCycle(tasks) {
    const visited = new Set();
    const recursionStack = new Set();
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    function dfs(taskId) {
        visited.add(taskId);
        recursionStack.add(taskId);
        const task = taskMap.get(taskId);
        if (!task)
            return false;
        for (const depId of task.dependsOn) {
            if (!visited.has(depId) && dfs(depId))
                return true;
            if (recursionStack.has(depId))
                return true;
        }
        recursionStack.delete(taskId);
        return false;
    }
    for (const task of tasks) {
        if (!visited.has(task.id) && dfs(task.id))
            return true;
    }
    return false;
}
export function validateTemplateFile(filePath) {
    try {
        parseTemplate(filePath);
        return { valid: true, errors: [] };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { valid: false, errors: [message] };
    }
}
//# sourceMappingURL=index.js.map