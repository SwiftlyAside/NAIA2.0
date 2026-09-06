#!/usr/bin/env node
// naia-inbox MCP 서버 진입점 — stdin 개행 JSON-RPC → tools, stdout 프로토콜 전용, stderr 로그.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createLineParser, encode } from './lib/protocol.mjs';
import { createTools } from './lib/tools.mjs';
import { createServer } from './lib/server.mjs';

const write = obj => process.stdout.write(encode(obj));
const log = msg => process.stderr.write(`[naia-inbox] ${msg}\n`);
const tools = createTools({ env: process.env, fs, homedir: os.homedir(), fetch: globalThis.fetch, spawn, sleep: ms => new Promise(r => setTimeout(r, ms)), now: Date.now, platform: process.platform });
const server = createServer({ tools, write, log });
const parser = createLineParser();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { for (const msg of parser.feed(chunk)) server.handle(msg).catch(e => log(`unhandled: ${e?.stack || e}`)); });
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
