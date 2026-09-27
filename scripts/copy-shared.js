// Copies the shared domain modules into functions/shared so the deployed
// backend runs exactly the code the browser app and tests use.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'functions', 'shared');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['core.js', 'calendar-core.js']) {
  fs.copyFileSync(path.join(root, 'js', f), path.join(dest, f));
}
console.log('copied shared modules to functions/shared');
