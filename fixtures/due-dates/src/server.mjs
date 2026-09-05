import { createWorkingBoardServer } from './working-board.mjs';

const app = createWorkingBoardServer({ file: process.argv[2] });
app.listen().then((port) => process.stdout.write(`${port}\n`));
