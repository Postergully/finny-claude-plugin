import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { applyProgress, progressInputSchema } from '../../../mcp/tools/progress.js';
import { taskManager } from '../../../mcp/tasks/manager.js';

vi.spyOn(console, 'error').mockImplementation(() => {});

describe('applyProgress', () => {
  beforeEach(() => {
    for (const task of taskManager.list()) {
      taskManager.delete(task.id);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('writes progress to a running task and returns ok', () => {
    const task = taskManager.create({ type: 'chat', input: {} });
    taskManager.updateStatus(task.id, 'running');

    const result = applyProgress({ text: 'querying NetSuite' }, { taskId: task.id });

    expect(result).toEqual({ ok: true });
    expect(taskManager.get(task.id)?.progress).toBe('querying NetSuite');
  });

  it('returns task_missing_or_terminal when task does not exist', () => {
    const result = applyProgress({ text: 'whatever' }, { taskId: 'task_does_not_exist' });

    expect(result).toEqual({ ok: false, reason: 'task_missing_or_terminal' });
  });

  it('returns task_missing_or_terminal for completed task', () => {
    const task = taskManager.create({ type: 'chat', input: {} });
    taskManager.updateStatus(task.id, 'completed', '{}');

    const result = applyProgress({ text: 'too late' }, { taskId: task.id });

    expect(result).toEqual({ ok: false, reason: 'task_missing_or_terminal' });
    expect(taskManager.get(task.id)?.progress).toBeUndefined();
  });

  it('rejects empty text via schema (throws ZodError)', () => {
    const task = taskManager.create({ type: 'chat', input: {} });
    taskManager.updateStatus(task.id, 'running');

    expect(() => applyProgress({ text: '' }, { taskId: task.id })).toThrow();
  });

  it('rejects over-length text via schema (>500 chars)', () => {
    const task = taskManager.create({ type: 'chat', input: {} });
    taskManager.updateStatus(task.id, 'running');
    const tooLong = 'x'.repeat(501);

    expect(() => applyProgress({ text: tooLong }, { taskId: task.id })).toThrow();
  });

  it('schema accepts exactly 500 chars (boundary)', () => {
    const exactly500 = 'x'.repeat(500);
    const parsed = progressInputSchema.safeParse({ text: exactly500 });
    expect(parsed.success).toBe(true);
  });
});
