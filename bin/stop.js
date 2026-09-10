#!/usr/bin/env node
// Stops a dev server this tool started with `node bin/setup.js` — no PID to
// remember or copy out of old terminal scrollback. Finds the marker file
// runProject.js drops in each project directory it starts (PID_FILE_NAME)
// and kills that process group.
//
// Usage:
//   node bin/stop.js              stop every running project found in the
//                                  current directory's immediate subfolders
//   node bin/stop.js <project>     stop just that one

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PID_FILE_NAME, getStopCommand } = require('../src/steps/runProject');

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findRunningProjects(cwd) {
  return fs
    .readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pidFilePath = path.join(cwd, entry.name, PID_FILE_NAME);
      if (!fs.existsSync(pidFilePath)) return null;
      try {
        const data = JSON.parse(fs.readFileSync(pidFilePath, 'utf-8'));
        return { projectName: entry.name, pidFilePath, ...data };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stopOne({ projectName, pid, pidFilePath }) {
  if (!isProcessAlive(pid)) {
    console.log(`ℹ️  ${projectName}: already stopped.`);
    fs.unlinkSync(pidFilePath);
    return;
  }
  try {
    execSync(getStopCommand(pid), { stdio: 'ignore' });
    console.log(`✅ ${projectName}: stopped (PID ${pid}).`);
  } catch (err) {
    console.log(`⚠️  ${projectName}: could not stop PID ${pid}: ${err.message}`);
    return;
  }
  fs.unlinkSync(pidFilePath);
}

function main() {
  const target = process.argv[2];
  const running = findRunningProjects(process.cwd());

  if (running.length === 0) {
    console.log('No running project found in this directory (nothing started with `node bin/setup.js` here, or it was already stopped).');
    return;
  }

  const toStop = target ? running.filter((r) => r.projectName === target) : running;

  if (target && toStop.length === 0) {
    console.log(`No running project named "${target}" found here. Running: ${running.map((r) => r.projectName).join(', ')}`);
    return;
  }

  toStop.forEach(stopOne);
}

main();
