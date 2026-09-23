const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'lucide-react', 'dist');

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.js')) {
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('sourceMappingURL=')) {
        fs.writeFileSync(full, text.replace(/\r?\n?\/\/#[ \t]*sourceMappingURL=.*$/gm, ''), 'utf8');
      }
    }
  }
}

walk(root);
console.log('Patched lucide-react source-map references for local builds.');
