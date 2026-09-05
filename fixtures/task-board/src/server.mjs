import { createStarterServer } from './board.mjs';
const app = createStarterServer({ file: process.argv[2] });
app.listen().then((port) => process.stdout.write(`${port}\n`));
