const fs = require('node:fs');
const path = require('node:path');

function createActivityStore(file) {
  return {
    load() {
      return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    save(snapshot) {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      const descriptor = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(snapshot));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
    }
  };
}

module.exports = { createActivityStore };
