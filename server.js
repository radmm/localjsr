const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Set headers for camera permission and caching
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=*');
  next();
});

// Serve static files from root directory
app.use(express.static(path.join(__dirname, '.'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Fallback to index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`H2S Badge Reader server running on http://${HOST}:${PORT}`);
});
