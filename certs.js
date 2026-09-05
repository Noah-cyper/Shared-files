import forge from 'node-forge';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* Máy chạy app tự sinh một CA của riêng nó, rồi ký chứng chỉ cho các IP LAN của mình.
   Cài CA đó vào điện thoại một lần là HTTPS hết bị cảnh báo — nhờ vậy điện thoại mới
   dùng được service worker (stream file lớn thẳng xuống máy) và cài được app lên màn hình chính.

   Khoá riêng của CA nằm trong .cert/ và không bao giờ rời khỏi máy này. Vì thế app
   KHÔNG được phát hành kèm CA làm sẵn: ai cầm khoá đó cũng giả mạo được HTTPS
   của mọi máy đã cài. */

const CA_YEARS = 10;
const LEAF_DAYS = 397;  // iOS từ chối chứng chỉ máy chủ có hạn dài hơn 825 ngày
const RENEW_BEFORE_DAYS = 30;

const DAY = 86400000;
const attrs = cn => [
  { name: 'commonName', value: cn },
  { name: 'organizationName', value: 'Shared Files' }
];

function newKeyPair() {
  // forge tự sinh khoá RSA rất chậm (vài giây), dùng crypto của Node rồi nạp vào forge
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  return {
    pem: privateKey,
    priv: forge.pki.privateKeyFromPem(privateKey),
    pub: forge.pki.publicKeyFromPem(publicKey)
  };
}

function baseCert(keyPub, days) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keyPub;
  cert.serialNumber = '00' + crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + days * DAY);
  return cert;
}

function createCa() {
  const key = newKeyPair();
  const cert = baseCert(key.pub, CA_YEARS * 365);
  cert.setSubject(attrs('Shared Files Local CA'));
  cert.setIssuer(attrs('Shared Files Local CA'));
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(key.priv, forge.md.sha256.create());
  return { cert, keyPem: key.pem, priv: key.priv };
}

function createLeaf(ca, hosts) {
  const key = newKeyPair();
  const cert = baseCert(key.pub, LEAF_DAYS);
  cert.setSubject(attrs(hosts.find(h => h.type === 2)?.value || 'localhost'));
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hosts },
    { name: 'authorityKeyIdentifier', authorityCertIssuer: true, serialNumber: ca.cert.serialNumber }
  ]);
  cert.sign(ca.priv, forge.md.sha256.create());
  return { cert, keyPem: key.pem };
}

const sansOf = cert => {
  const ext = cert.getExtension('subjectAltName');
  return new Set((ext?.altNames || []).map(a => a.ip || a.value));
};

const daysLeft = cert => (cert.validity.notAfter - Date.now()) / DAY;

export function ensureCerts(dir, ips) {
  fs.mkdirSync(dir, { recursive: true });
  const f = n => path.join(dir, n);
  const read = n => fs.existsSync(f(n)) ? fs.readFileSync(f(n), 'utf8') : null;

  let ca = null;
  const caPem = read('ca.crt'), caKeyPem = read('ca.key');
  if (caPem && caKeyPem) {
    const cert = forge.pki.certificateFromPem(caPem);
    if (daysLeft(cert) > RENEW_BEFORE_DAYS) {
      ca = { cert, priv: forge.pki.privateKeyFromPem(caKeyPem), keyPem: caKeyPem };
    }
  }
  let freshCa = false;
  if (!ca) {
    ca = createCa();
    fs.writeFileSync(f('ca.crt'), forge.pki.certificateToPem(ca.cert));
    fs.writeFileSync(f('ca.key'), ca.keyPem, { mode: 0o600 });
    freshCa = true;
  }

  const hosts = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map(ip => ({ type: 7, ip }))
  ];
  const want = new Set(hosts.map(h => h.ip || h.value));

  let leafPem = read('server.crt'), leafKeyPem = read('server.key');
  let stale = freshCa || !leafPem || !leafKeyPem;
  if (!stale) {
    const cert = forge.pki.certificateFromPem(leafPem);
    const have = sansOf(cert);
    // IP LAN đổi (đổi wifi, cắm dây mạng...) thì chứng chỉ cũ không còn khớp
    stale = daysLeft(cert) < RENEW_BEFORE_DAYS || [...want].some(h => !have.has(h));
  }
  if (stale) {
    const leaf = createLeaf(ca, hosts);
    leafPem = forge.pki.certificateToPem(leaf.cert);
    leafKeyPem = leaf.keyPem;
    fs.writeFileSync(f('server.crt'), leafPem);
    fs.writeFileSync(f('server.key'), leafKeyPem, { mode: 0o600 });
  }

  const caCertPem = forge.pki.certificateToPem(ca.cert);
  const caDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes(), 'binary');

  return {
    key: leafKeyPem,
    cert: leafPem + caCertPem,          // gửi kèm CA để client nào đã tin CA là dựng đủ chuỗi
    caPem: caCertPem,
    caDer,
    caFingerprint: crypto.createHash('sha256').update(caDer).digest('hex').toUpperCase().match(/../g).join(':'),
    renewed: stale
  };
}

/* Hồ sơ cấu hình cho iOS/iPadOS: bấm mở là máy tự đưa vào phần cài chứng chỉ,
   đỡ hẳn mấy bước lần mò so với tải thẳng file .crt. */
export function mobileconfig(caDer, fingerprint) {
  const uuid = tag => {
    const h = crypto.createHash('sha1').update(tag + fingerprint).digest('hex').toUpperCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const b64 = caDer.toString('base64').match(/.{1,64}/g).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>SharedFiles-CA.crt</string>
      <key>PayloadContent</key>
      <data>
${b64}
      </data>
      <key>PayloadDescription</key><string>Chứng chỉ gốc của máy chạy Shared Files</string>
      <key>PayloadDisplayName</key><string>Shared Files Local CA</string>
      <key>PayloadIdentifier</key><string>local.sharedfiles.ca</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid('ca')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>Shared Files</string>
  <key>PayloadDescription</key><string>Cho phép điện thoại tin chứng chỉ HTTPS của máy tính chạy Shared Files.</string>
  <key>PayloadIdentifier</key><string>local.sharedfiles.profile</string>
  <key>PayloadOrganization</key><string>Shared Files</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid('profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}
