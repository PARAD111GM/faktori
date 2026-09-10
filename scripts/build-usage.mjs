#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { args, fail, writeJson } from './lib/build-records.mjs';
import { summarizeUsage } from '../src/runtime/usage-accounting.mjs';

const command = process.argv[2];
const options = args(process.argv.slice(3));
const defaultInput = '.build/usage/records.jsonl';
const defaultOutput = 'construction/phase-summary.json';

export const summarize = summarizeUsage;

async function readRecords(path) {
  const contents = await readFile(path, 'utf8');
  return contents.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid JSONL record at line ${index + 1}`); }
  });
}

async function emit() {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const records = await readRecords(input);
  const summary = summarizeUsage(records, Number(options.estimate), options.phase === undefined ? undefined : Number(options.phase));
  await writeJson(output, summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function watch() {
  await emit();
  const timer = setInterval(() => emit().catch((error) => process.stderr.write(`${error.message}\n`)), 10_000);
  await new Promise(() => {});
}

if (!['summarize', 'watch'].includes(command)) fail('Usage: build-usage.mjs <summarize|watch> [--input records.jsonl] [--output summary.json] --estimate tokens [--phase number]');
else (command === 'watch' ? watch() : emit()).catch((error) => fail(error.message));
