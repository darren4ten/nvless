const os = require('os');
const http = require('http');
const fs = require('fs');
const axios = require('axios');
const net = require('net');
const { Buffer } = require('buffer');
const { exec, execSync } = require('child_process');
const { WebSocket, createWebSocketStream } = require('ws');
const UUID = process.env.UUID || 'de04add9-5c68-6bab-950c-08cd5320df33'; // 使用哪吒v1部署多个需要修改UUID，否则会覆盖
const NEZHA_SERVER = process.env.NEZHA_SERVER || ''; // 哪吒v1填写形式：nz.abc.com:8008  哪吒v0填写形式：nz.abc.com
const NEZHA_PORT = process.env.NEZHA_PORT || '';     // 哪吒v1留空，v0的agent端口
const NEZHA_KEY = process.env.NEZHA_KEY || '';       // 哪吒v1的NZ_CLIENT_CECRET或v0的agent密钥
const DOMAIN = process.env.DOMAIN || 'jnv-letstayweare.ladeapp.com';  // 必填,改为自己的app名称和账户名：app名称-账户名称.ladeapp.com
const AUTO_ACCESS = process.env.AUTO_ACCESS || false;   // true开启自动保活，false关闭
const SUB_PATH = process.env.SUB_PATH || 'sub';         // 节点订阅路径
const NAME = process.env.NAME || 'Lade';                // 节点名称
const PORT = process.env.PORT || 3000;                  // http服务和ws服务端口，不用改

const metaInfo = execSync(
  'curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
  { encoding: 'utf-8' }
);
const ISP = metaInfo.trim();
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello, World\n');
  } else if (req.url === `/${SUB_PATH}`) {
    const vlessURL = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&&type=ws&host=${DOMAIN}&path=%2Fed%3D2560#${NAME}-${ISP}`;
    const base64Content = Buffer.from(vlessURL).toString('base64');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(base64Content + '\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

const wss = new WebSocket.Server({ server: httpServer });
// 预先将 UUID 转换为 Buffer, 避免每次连接重复计算
const uuidBuffer = Buffer.from(UUID.replace(/-/g, ''), 'hex');
// 预先创建 TextDecoder 实例
const textDecoder = new TextDecoder();

wss.on('connection', ws => {
  ws.once('message', msg => {
    try {
      // 读取协议版本（第 1 个字节）
      const VERSION = msg.readUInt8(0);

      // 校验 UUID：从 offset 1 到 16 的数据应与预先存储的 uuidBuffer 相等
      const idBuffer = msg.slice(1, 17);
      if (!idBuffer.equals(uuidBuffer)) return;

      // 从 offset 17 读取一个字节，表示附加数据的长度，之后偏移量从 19 + extraLength 开始
      let offset = 17;
      const extraLength = msg.readUInt8(offset);
      offset = 19 + extraLength;

      // 读取目标端口（2 字节，网络字节序）
      const port = msg.readUInt16BE(offset);
      offset += 2;

      // 读取地址类型（ATYP）
      const ATYP = msg.readUInt8(offset);
      offset += 1;

      let host = '';
      if (ATYP === 1) { // IPv4 地址：接下来 4 字节
        host = Array.from(msg.slice(offset, offset + 4)).join('.');
        offset += 4;
      } else if (ATYP === 2) { // 域名地址：先读一个字节长度，再读相应字节的字符串
        const domainLen = msg.readUInt8(offset);
        offset += 1;
        host = textDecoder.decode(msg.slice(offset, offset + domainLen));
        offset += domainLen;
      } else if (ATYP === 3) { // IPv6 地址：接下来 16 字节，转换成标准 IPv6 格式
        const ipv6Buffer = msg.slice(offset, offset + 16);
        const ipv6Hex = ipv6Buffer.toString('hex');
        host = ipv6Hex.match(/.{1,4}/g).join(':');
        offset += 16;
      }

      // 发送响应，告知客户端连接成功（[VERSION, 0]）
      ws.send(Buffer.from([VERSION, 0]));

      // 建立 WebSocket 流和 TCP 连接之间的桥接
      const duplex = createWebSocketStream(ws);
      net.connect({ host, port }, function() {
        // 将 msg 剩余部分写入目标 TCP 连接
        this.write(msg.slice(offset));
        duplex.on('error', () => {})
              .pipe(this)
              .on('error', () => {})
              .pipe(duplex);
      }).on('error', () => {});
    } catch (err) {
      // 错误处理（可记录日志或进一步处理异常）
    }
  }).on('error', () => {});
});



const getDownloadUrl = () => {
  const arch = os.arch(); 
  if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
    return NEZHA_PORT ? 'https://arm64.ssss.nyc.mn/agent' : 'https://arm64.ssss.nyc.mn/v1';
  } else {
    return NEZHA_PORT ? 'https://amd64.ssss.nyc.mn/agent' : 'https://amd64.ssss.nyc.mn/v1';
  }
};

const downloadFile = async () => {
  try {
    const url = getDownloadUrl();
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream('npm');
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('npm download successfully');
        exec('chmod +x npm', (err) => {
          if (err) reject(err);
          resolve();
        });
      });
      writer.on('error', reject);
    });
  } catch (err) {
    throw err;
  }
};

const runnz = async () => {
  await downloadFile();
  let NEZHA_TLS = '';
  let command = '';

  if (NEZHA_SERVER && NEZHA_PORT && NEZHA_KEY) {
    const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
    NEZHA_TLS = tlsPorts.includes(NEZHA_PORT) ? '--tls' : '';
    command = `nohup ./npm -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} >/dev/null 2>&1 &`;
  } else if (NEZHA_SERVER && NEZHA_KEY) {
    if (!NEZHA_PORT) {
      const configYaml = `
client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
report_delay: 1
server: ${NEZHA_SERVER}
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: false
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;
      
      fs.writeFileSync('config.yaml', configYaml);
    }
    command = `nohup ./npm -c config.yaml >/dev/null 2>&1 &`;
  } else {
    console.log('NEZHA variable is empty, skip running');
    return;
  }

  try {
    exec(command, { 
      shell: '/bin/bash'
    });
    console.log('npm is running');
  } catch (error) {
    console.error(`npm running error: ${error}`);
  } 
};

async function addAccessTask() {
  if (!AUTO_ACCESS) return;
  try {
    if (!DOMAIN) {
      console.log('URL is empty. Skip Adding Automatic Access Task');
      return;
    } else {
      let fullURL = PORT === 3000 ? `https://${DOMAIN}` : `https://${DOMAIN}/${PORT}`;
      const command = `curl -X POST "https://oooo.serv00.net/add-url" -H "Content-Type: application/json" -d '{"url": "${fullURL}"}'`;
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('Error sending request:', error.message);
          return;
        }
        console.log('Automatic Access Task added successfully:', stdout);
      });
    }
  } catch (error) {
    console.error('Error added Task:', error.message);
  }
}

const delFiles = () => {
  fs.unlink('npm', () => {});
  fs.unlink('config.yaml', () => {}); 
};

httpServer.listen(PORT, async () => {
  await runnz();
  setTimeout(() => {
    delFiles();
  }, 50000);
  await addAccessTask();
  console.log(`Server is running on port ${PORT}`);
});
