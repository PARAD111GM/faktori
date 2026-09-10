import { randomUUID } from 'node:crypto';

export function addTask(tasks, title) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('A title is required');
  return [...tasks, { id: randomUUID(), title: title.trim(), completed: false }];
}
