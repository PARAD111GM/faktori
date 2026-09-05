import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

async function body(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text || '{}');
}

export function createWorkingBoardServer({ file, port = 0 } = {}) {
  let tasks = [];
  const load = async () => { try { tasks = JSON.parse(await readFile(file, 'utf8')); } catch { tasks = []; } };
  const save = () => writeFile(file, `${JSON.stringify(tasks)}\n`);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(await readFile(new URL('./index.html', import.meta.url)));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(await readFile(new URL('./app.js', import.meta.url)));
      return;
    }
    if (url.pathname === '/api/tasks' && request.method === 'GET') {
      const filter = url.searchParams.get('filter') ?? 'all';
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const filtered = tasks.filter((task) => (filter === 'complete' ? task.complete : filter === 'open' ? !task.complete : true) && task.title.toLowerCase().includes(query));
      return json(response, 200, filtered);
    }
    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.title !== 'string' || input.title.trim() === '') return json(response, 400, { error: 'title is required' });
      const task = { id: crypto.randomUUID(), title: input.title.trim(), complete: false };
      tasks.push(task);
      await save();
      return json(response, 201, task);
    }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (!match) return json(response, 404, { error: 'not found' });
    const index = tasks.findIndex((task) => task.id === decodeURIComponent(match[1]));
    if (index === -1) return json(response, 404, { error: 'task not found' });
    if (request.method === 'PATCH') {
      const input = await body(request);
      if (input.title !== undefined) {
        if (typeof input.title !== 'string' || input.title.trim() === '') return json(response, 400, { error: 'title is required' });
        tasks[index].title = input.title.trim();
      }
      if (input.complete !== undefined) {
        if (typeof input.complete !== 'boolean') return json(response, 400, { error: 'complete must be boolean' });
        tasks[index].complete = input.complete;
      }
      await save();
      return json(response, 200, tasks[index]);
    }
    if (request.method === 'DELETE') {
      tasks.splice(index, 1);
      await save();
      response.writeHead(204);
      response.end();
      return;
    }
    return json(response, 405, { error: 'method not allowed' });
  });
  return {
    async listen() { await load(); return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))); },
  };
}
