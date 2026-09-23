// HAOC(하오커뮤니케이션) 통합 허브 — http://127.0.0.1:5047
// 티스토리(5043)/블로그스팟(5044)/홈페이지(5045) 작성기를 탭 하나로 묶어 보여준다.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5047;
const HTML = path.join(__dirname, 'hub.html');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(HTML));
}).listen(PORT, '127.0.0.1', () => console.log(`HaocHub: http://127.0.0.1:${PORT}`));
