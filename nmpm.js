#!/usr/bin/env node
import { spawn } from 'child_process';
console.log('--- AUTO-CORRECTING nmpm TO npm ---');
const child = spawn('npm', ['start'], { stdio: 'inherit' });
child.on('close', code => process.exit(code));
