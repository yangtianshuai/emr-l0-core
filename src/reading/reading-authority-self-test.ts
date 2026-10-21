import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WriteSession } from '../core/session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  documentFingerprint,
  issueReadingGrant,
  verifyCredential,
  type ReadingGrant,
} from '../core/controlled-reading.ts';
import { demoKeyPair, softwareSigner } from '../crypto/provider.ts';
import { publicKeyFingerprint, publicKeyToSpki } from '../crypto/sm2.ts';
import {
  checkIssuerTrust,
  isAuthorityConfigured,
  parseCredential,
  validateReadingAuthority,
} from './reading-authority.ts';
import { READING_AUTHORITY_KEY, loadReadingAuthority, saveReadingAuthority } from './reading-authority-store.ts';
import { openConfigFixture, writeCorruptRow } from '../testing/config-fixture.ts';

const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
};
const osx = (await import('node:os')) as unknown as { tmpdir: () => string };

const suite = new TestSuite('受控阅读授权平台自测', [
  '说明：本系统不签发阅读授权 —— 授权由院内平台签发，本系统只验签、登记与执行。',
  '信任判定的失败模式是"接纳"（放行一份不受信的授权），因此每条判定都必须有拒绝用例。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const PLATFORM_SEED = 'dept-authz-platform-2026';
const PLATFORM_KEY = demoKeyPair(PLATFORM_SEED);
const PLATFORM_FINGERPRINT = publicKeyFingerprint(PLATFORM_KEY.publicKey);
const PLATFORM_SIGNER = softwareSigner(PLATFORM_KEY.privateKey);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

function fixture() {
  const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
  doc.patient = { patientId: 'P_AUTH', nameMasked: '王**', gender: 'M', birthDate: '1965-03-03' };
  const session = WriteSession.open(doc);
  session.exportMachineReadable();
  return session.document;
}

function grantFor(doc: ReturnType<typeof fixture>): ReadingGrant {
  return {
    grantId: 'grant_auth_1',
    docId: doc.docId,
    documentFingerprint: documentFingerprint(doc),
    notBefore: '2026-10-09T00:00:00Z',
    notAfter: '2026-10-10T00:00:00Z',
    maxReads: 3,
    allowedEnvironments: ['WS-01'],
    allowedSections: ['*'],
    concealPatientIdentity: false,
    issuedBy: 'AUTHZ_PLATFORM',
    issuedAt: '2026-10-09T01:00:00Z',
    purpose: '院内会诊',
  };
}

async function main(): Promise<void> {
  const doc = fixture();

  await test('A1 空配置合法（= 未配置状态），但此时**不算已配置**', async () => {
    const config = validateReadingAuthority({});
    assertEqual(Object.keys(config).length, 0, '空输入应产出空配置（不是报错）');
    assertEqual(isAuthorityConfigured(config), false, '没有信任根 = 未配置');
  });

  await test('A2 粘贴平台公钥 → 指纹自动派生（免手抄 64 位 hex）', async () => {
    const spkiBase64 = Buffer.from(publicKeyToSpki(PLATFORM_KEY.publicKey)).toString('base64');
    const config = validateReadingAuthority({ trustedIssuerPublicKeyBase64: spkiBase64 });
    assertEqual(config.trustedIssuerFingerprint, PLATFORM_FINGERPRINT, '指纹应由公钥自动派生');
    assertEqual(config.trustedIssuerPublicKeyBase64, spkiBase64, '公钥应原样保留');
    assertEqual(isAuthorityConfigured(config), true, '有信任根即已配置');
  });

  await test('A3 指纹形态非法：报错而不是"照单全收"', async () => {
    assertEqual(
      codeOf(() => validateReadingAuthority({ trustedIssuerFingerprint: 'ABC123' })),
      'E_READING_AUTHORITY_BAD_FINGERPRINT',
      '非 64 位十六进制必须报错',
    );
  });

  await test('A4 公钥与指纹不是一对：保存时就报错（否则"信任的是哪把钥匙"会有两种说法）', async () => {
    const other = demoKeyPair('some-other-key');
    const otherSpki = Buffer.from(publicKeyToSpki(other.publicKey)).toString('base64');
    assert(publicKeyFingerprint(other.publicKey) !== PLATFORM_FINGERPRINT, '两把钥匙指纹不应相同（用例前提）');
    assertEqual(
      codeOf(() =>
        validateReadingAuthority({
          trustedIssuerPublicKeyBase64: otherSpki,
          trustedIssuerFingerprint: PLATFORM_FINGERPRINT,
        }),
      ),
      'E_READING_AUTHORITY_KEY_MISMATCH',
      '公钥与指纹不一致必须报错',
    );
  });

  await test('A5 平台公钥不是合法 SM2 公钥：保存时就报错（不等到导入第一份凭据）', async () => {
    assertEqual(
      codeOf(() => validateReadingAuthority({ trustedIssuerPublicKeyBase64: 'bm90LWEta2V5' })),
      'E_READING_AUTHORITY_INVALID',
      '非法公钥必须被拒',
    );
  });

  await test('A6 平台地址可单独配置（协议未实现，但地址本身要能存下来）', async () => {
    const config = validateReadingAuthority({ endpoint: 'https://authz.hospital.local/api/reading' });
    assertEqual(config.endpoint, 'https://authz.hospital.local/api/reading', '地址应保留');
    assertEqual(isAuthorityConfigured(config), false, '只配地址**不算**已配置（信任根才是关键）');
  });

  await test('B1 未配置信任根：拒绝**任何**凭据（fail-closed，先于一切判定）', async () => {
    const credential = await issueReadingGrant(grantFor(doc), PLATFORM_SIGNER);
    assertEqual(verifyCredential(credential).ok, true, '凭据本身应自洽（前提）');
    const decision = checkIssuerTrust(credential, validateReadingAuthority({}));
    assertEqual(decision.ok, false, '未配置时必须拒绝');
    assertEqual(decision.code, 'E_UNTRUSTED_ISSUER', '拒绝码应为 E_UNTRUSTED_ISSUER');
    assert((decision.reason ?? '').includes('尚未配置'), '理由要说清"尚未配置"，而不是含糊的"无权"');
  });

  await test('B2 配置后，该平台钥匙签发的凭据受信', async () => {
    const config = validateReadingAuthority({ trustedIssuerFingerprint: PLATFORM_FINGERPRINT });
    const credential = await issueReadingGrant(grantFor(doc), PLATFORM_SIGNER);
    assertEqual(checkIssuerTrust(credential, config).ok, true, '平台签发的凭据应受信');
  });

  await test('B3 自洽 ≠ 受信：另一把钥匙签的凭据被拒（这是信任根必须单设的理由）', async () => {
    const config = validateReadingAuthority({ trustedIssuerFingerprint: PLATFORM_FINGERPRINT });
    const otherKey = demoKeyPair('not-the-platform');
    const credential = await issueReadingGrant(grantFor(doc), softwareSigner(otherKey.privateKey));
    assertEqual(verifyCredential(credential).ok, true, '自签凭据在密码学上应自洽（这正说明内核判断不了"谁被信任"）');
    const decision = checkIssuerTrust(credential, config);
    assertEqual(decision.ok, false, '不在信任集里的签发者必须被拒');
    assertEqual(decision.code, 'E_UNTRUSTED_ISSUER', '拒绝码应为 E_UNTRUSTED_ISSUER');
  });

  await test('B4 信任根一换：原平台签发的凭据立即失效（信任集是唯一判定点）', async () => {
    const otherKey = demoKeyPair('the-new-platform');
    const newConfig = validateReadingAuthority({ trustedIssuerFingerprint: publicKeyFingerprint(otherKey.publicKey) });
    const oldCredential = await issueReadingGrant(grantFor(doc), PLATFORM_SIGNER);
    assertEqual(checkIssuerTrust(oldCredential, newConfig).ok, false, '换平台后，旧平台的凭据必须失效');
  });

  await test('C1 没配过 = 空配置，来源可见且**未配置**', async () => {
    const fixture = openConfigFixture({ prefix: 'l0-authority-' });
    const kv = fixture.kv;
    try {
      const loaded = loadReadingAuthority(kv);
      assertEqual(loaded.source, 'default', '没配过应为 default');
      assertEqual(isAuthorityConfigured(loaded.config), false, '默认未配置信任根');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C2 保存后来源为 store，记录修改者，且信任指纹持久化', async () => {
    const fixture = openConfigFixture({ prefix: 'l0-authority-' });
    const kv = fixture.kv;
    try {
      const saved = saveReadingAuthority(
        kv,
        { endpoint: 'https://authz.hospital.local/api/reading', trustedIssuerFingerprint: PLATFORM_FINGERPRINT },
        'ADMIN',
      );
      assertEqual(saved.loaded.source, 'store', '保存后来源应为 store');
      assertEqual(saved.loaded.updatedBy, 'ADMIN', '应记录修改者');
      const reloaded = loadReadingAuthority(kv);
      assertEqual(reloaded.config.trustedIssuerFingerprint, PLATFORM_FINGERPRINT, '信任指纹应持久化');
      assertEqual(reloaded.config.endpoint, 'https://authz.hospital.local/api/reading', '平台地址应持久化');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C3 非法配置不得落盘（指纹与公钥不一致时保存直接失败）', async () => {
    const fixture = openConfigFixture({ prefix: 'l0-authority-' });
    const kv = fixture.kv;
    try {
      const other = demoKeyPair('another-key');
      assertEqual(
        codeOf(() =>
          saveReadingAuthority(
            kv,
            {
              trustedIssuerPublicKeyBase64: Buffer.from(publicKeyToSpki(other.publicKey)).toString('base64'),
              trustedIssuerFingerprint: PLATFORM_FINGERPRINT,
            },
            'ADMIN',
          ),
        ),
        'E_READING_AUTHORITY_KEY_MISMATCH',
        '非法配置必须被拒',
      );
      assertEqual(loadReadingAuthority(kv).source, 'default', '被拒之后不应留下任何配置痕迹');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C4 配置损坏：报错，不当作"没配过"（否则会静默变成"拒绝一切"）', async () => {
    const fixture = openConfigFixture({ prefix: 'l0-authority-' });
    const kv = fixture.kv;
    try {
      writeCorruptRow(fixture, READING_AUTHORITY_KEY);
      assertEqual(
        codeOf(() => loadReadingAuthority(kv)),
        'E_READING_AUTHORITY_INVALID',
        '损坏的配置不得当作"没配过"',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('D1 合法凭据可解析（形状校验先于信任判定）', async () => {
    const credential = await issueReadingGrant(grantFor(doc), PLATFORM_SIGNER);
    const parsed = parseCredential(JSON.stringify(credential));
    assertEqual(parsed.ok, true, `合法凭据应可解析：${parsed.ok ? '' : parsed.reason}`);
    if (parsed.ok) {
      assertEqual(parsed.credential.grant.grantId, 'grant_auth_1', '解析出的授权编号应一致');
    }
  });

  await test('D2 非 JSON / 缺字段 / 缺 references：报"内容不对"，而不是抛内部错误', async () => {
    assertEqual(parseCredential('不是 JSON').ok, false, '非 JSON 应被拒');
    assertEqual((parseCredential('不是 JSON') as { code: string }).code, 'E_CREDENTIAL_MALFORMED', '应给出形状错误码');

    const noGrant = JSON.stringify({ publicKeyBase64: 'x', publicKeyFingerprint: 'y', signatureValue: 'z', signedInfoDigest: 'd', references: [{}] });
    assertEqual(parseCredential(noGrant).ok, false, '缺 grant 应被拒');

    const credential = await issueReadingGrant(grantFor(doc), PLATFORM_SIGNER) as unknown as Record<string, unknown>;
    const noRefs = JSON.stringify({ ...credential, references: [] });
    assertEqual(parseCredential(noRefs).ok, false, 'references 为空应被拒（授权书靠它参与验签）');
  });

  await test('D3 解析成功 ≠ 受信：形状对但签发者不可信，仍须被信任根拒', async () => {
    const otherKey = demoKeyPair('another-signer');
    const credential = await issueReadingGrant(grantFor(doc), softwareSigner(otherKey.privateKey));
    const parsed = parseCredential(JSON.stringify(credential));
    assert(parsed.ok, '形状校验应通过');
    if (parsed.ok) {
      const decision = checkIssuerTrust(parsed.credential, validateReadingAuthority({ trustedIssuerFingerprint: PLATFORM_FINGERPRINT }));
      assertEqual(decision.code, 'E_UNTRUSTED_ISSUER', '形状对但来源不可信，必须由信任根拒绝');
    }
  });

  process.exit(suite.report());
}

void main();
