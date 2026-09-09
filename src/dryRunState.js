// Simple dry-run flag read from a single place throughout the process.
// bin/setup.js sets it via --dry-run, other modules read it via isDryRun().
let dryRun = false;

function setDryRun(value) {
  dryRun = Boolean(value);
}

function isDryRun() {
  return dryRun;
}

module.exports = { setDryRun, isDryRun };
