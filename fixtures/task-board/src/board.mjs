import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Intentionally incomplete starter: candidates must implement the contract in README.
export function createStarterServer({ port = 0, file } = {}) {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/tasks') {
      let tasks = [];
      if (file) { try { tasks = JSON.parse(await readFile(file, 'utf8')); } catch {} }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(tasks));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'starter route not implemented' }));
  });
  return { server, listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))) };
}
