const list = document.querySelector('[role="list"]');
const newTask = document.querySelector('[aria-label="New task"]');
const textFilter = document.querySelector('[aria-label="Filter tasks"]');
const add = document.querySelector('[aria-label="Add task"]');
const filters = [...document.querySelectorAll('[aria-label$=" tasks"]')];
let filter = 'all';

async function api(path, options) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

function button(label, text, action) {
  const element = document.createElement('button');
  element.type = 'button'; element.setAttribute('aria-label', label); element.textContent = text; element.addEventListener('click', action);
  return element;
}

async function render() {
  const tasks = await api(`/api/tasks?filter=${filter}&q=${encodeURIComponent(textFilter.value)}`);
  list.replaceChildren(...tasks.map((task) => row(task)));
}

function row(task) {
  const item = document.createElement('li');
  const toggle = button(`Toggle ${task.title}`, task.complete ? 'Mark open' : 'Mark complete', async () => {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ complete: !task.complete }) });
    await render();
  });
  toggle.setAttribute('aria-pressed', String(task.complete));
  item.append(toggle, document.createTextNode(` ${task.title} `));
  item.append(button(`Edit ${task.title}`, 'Edit', () => edit(item, task)));
  item.append(button(`Delete ${task.title}`, 'Delete', async () => { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }); await render(); }));
  return item;
}

function edit(item, task) {
  const input = document.createElement('input');
  input.setAttribute('aria-label', `Edit ${task.title}`); input.value = task.title;
  const save = async () => { if (input.value.trim()) { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ title: input.value }) }); await render(); } };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') render(); });
  item.replaceChildren(input); input.focus(); input.select();
}

async function create() {
  if (!newTask.value.trim()) return;
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: newTask.value }) });
  newTask.value = ''; await render();
}

add.addEventListener('click', create);
newTask.addEventListener('keydown', (event) => { if (event.key === 'Enter') create(); if (event.key === 'Escape') newTask.value = ''; });
textFilter.addEventListener('input', render);
filters.forEach((element) => element.addEventListener('click', async () => { filter = element.getAttribute('aria-label').split(' ')[0].toLowerCase(); if (filter === 'completed') filter = 'complete'; filters.forEach((button) => button.setAttribute('aria-pressed', String(button === element))); await render(); }));
render();
