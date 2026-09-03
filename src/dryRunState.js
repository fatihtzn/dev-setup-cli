// Süreç boyunca tek bir yerden okunan basit dry-run bayrağı.
// bin/setup.js --dry-run ile set eder, diğer modüller isDryRun() ile okur.
let dryRun = false;

function setDryRun(value) {
  dryRun = Boolean(value);
}

function isDryRun() {
  return dryRun;
}

module.exports = { setDryRun, isDryRun };
