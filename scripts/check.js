import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

try {
  fs.accessSync('node_modules/mineflayer/package.json');
  console.log('OK: mineflayer installed');
} catch {
  console.error('ERR: mineflayer not installed. Run dependency install first.');
  process.exit(1);
}

function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

const jsFiles = [...collectJsFiles('src'), ...collectJsFiles('test')].sort();
for (const filePath of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString('utf8')?.trim();
    console.error(`ERR: syntax check failed for ${filePath}${stderr ? `\n${stderr}` : ''}`);
    process.exit(1);
  }
}

console.log(`OK: syntax valid (${jsFiles.length} files)`);
