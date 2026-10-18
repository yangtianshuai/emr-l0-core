// 加密归档命令行：把产物加密成 `.l0enc` 信封（或解回来）。
// node src/crypto/envelope-cli.ts decrypt <输入.l0enc> <输出文件> --passphrase <口令>
// 命令行参数里的口令会进 shell 历史：仅用于本地验证；生产应由界面/密码设备采集口令。

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sm4Availability, sm4SelfCheck } from './sm4.ts';
import { decryptEnvelope, decryptEnvelopeWith, encryptEnvelope, encryptEnvelopeFor, type Envelope } from './envelope.ts';
import { demoKeyPair } from './provider.ts';
import { publicKeyFingerprint } from './sm2.ts';

function fail(message: string): never {
  console.error(message);
  console.error(usageText());
  process.exit(1);
  throw new Error('unreachable');
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usageText(): string {
  return [
    '用法：',
    '  node src/crypto/envelope-cli.ts selfcheck',
    '  # 口令模式（本机口令保护的归档件）',
    '  node src/crypto/envelope-cli.ts encrypt <输入文件> <输出.l0enc> --passphrase <口令> [--iterations N]',
    '  node src/crypto/envelope-cli.ts decrypt <输入.l0enc> <输出文件> --passphrase <口令>',
    '  # 公钥模式（只有持有私钥的一方看得见；演示用种子派生密钥）',
    '  node src/crypto/envelope-cli.ts seal-for <输入文件> <输出.l0enc> --recipient-seed <种子>',
    '  node src/crypto/envelope-cli.ts open-with <输入.l0enc> <输出文件> --recipient-seed <种子>',
    '',
    '说明：口令会进入 shell 历史；演示种子公开、私钥可被推导。两者都只用于本地验证。',
  ].join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) fail('缺少子命令');

  if (command === 'selfcheck') {
    const availability = sm4Availability();
    const check = sm4SelfCheck();
    console.log(`SM4 可用：${availability.ok ? '是' : '否'}${availability.reason ? `（${availability.reason}）` : ''}`);
    console.log(`可用算法：${availability.ciphers.join(', ') || '（无）'}`);
    console.log(`国标向量自检：${check.ok ? '通过' : '不通过'} —— ${check.detail}`);
    process.exit(check.ok ? 0 : 1);
  }

  const input = args[1];
  const output = args[2];
  if (!input || !output) fail('缺少输入或输出文件路径');

  /*  参数校验必须绑定到子命令：早期版本把 `--passphrase` 的检查放在全局，
     结果公钥模式的 seal-for / open-with 全被"缺少口令"拦住（实测发现）。
     纪律本身没错（没有密钥就不该产出"看起来加密了"的东西），错的是它管得太宽。  */
  const requirePassphrase = (): string => {
    const passphrase = argValue(args, '--passphrase');
    if (!passphrase) {
      fail('缺少 --passphrase：口令模式没有口令就不存在任何机密性可言，本命令拒绝"无口令加密"');
    }
    return passphrase;
  };

  if (command === 'encrypt') {
    const passphrase = requirePassphrase();
    const iterationsRaw = argValue(args, '--iterations');
    const plaintext = readFileSync(input);
    const envelope = encryptEnvelope(plaintext, {
      passphrase,
      ...(iterationsRaw ? { iterations: Number(iterationsRaw) } : {}),
    });
    writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    console.log(`加密完成：${basename(input)}（${plaintext.length} 字节）→ ${basename(output)}`);
    const kdf = envelope.header.kdf;
    const kdfText =
      kdf.algorithm === 'PBKDF2-HMAC-SM3'
        ? `口令派生（迭代 ${kdf.iterations}）`
        : `公钥封装（接收方 ${kdf.recipientFingerprint.slice(0, 16)}…）`;
    console.log(`算法套件：${envelope.header.suite}；密钥来源：${kdfText}`);
    console.log(`明文摘要：${envelope.header.plaintextDigest}`);
    process.exit(0);
  }

  if (command === 'decrypt') {
    const passphrase = requirePassphrase();
    const envelope = JSON.parse(readFileSync(input, 'utf8')) as Envelope;
    const result = decryptEnvelope(envelope, passphrase);
    if (!result.ok) fail(`解密失败：${result.code} —— ${result.reason}`);
    writeFileSync(output, result.plaintext);
    console.log(`解密完成：${basename(input)} → ${basename(output)}（${result.plaintext.length} 字节）`);
    process.exit(0);
  }

  /* --------------------- 公钥模式（演示用：由种子派生密钥） --------------------- */
  /*  用种子派生密钥只为本地演示：真正的接收方密钥必须由密码设备生成并保管。
     这里把这条限制写在命令输出里，避免被当成"生产用法"照抄。  */
  if (command === 'seal-for') {
    const seed = argValue(args, '--recipient-seed');
    if (!seed) fail('缺少 --recipient-seed（演示用；生产应由密码设备提供接收方公钥）');
    const recipient = demoKeyPair(seed);
    const fingerprint = publicKeyFingerprint(recipient.publicKey);
    const plaintext = readFileSync(input);
    const envelope = encryptEnvelopeFor(plaintext, { publicKey: recipient.publicKey, fingerprint });
    writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    console.log(`公钥加密完成：${basename(input)}（${plaintext.length} 字节）→ ${basename(output)}`);
    console.log(`接收方公钥指纹：${fingerprint}`);
    console.log('提示：只有持有该种子对应私钥的一方能解开；演示种子公开，不得用于生产。');
    process.exit(0);
  }

  if (command === 'open-with') {
    const seed = argValue(args, '--recipient-seed');
    if (!seed) fail('缺少 --recipient-seed');
    const recipient = demoKeyPair(seed);
    const envelope = JSON.parse(readFileSync(input, 'utf8')) as Envelope;
    const result = decryptEnvelopeWith(envelope, {
      privateKey: recipient.privateKey,
      fingerprint: publicKeyFingerprint(recipient.publicKey),
    });
    if (!result.ok) fail(`解密失败：${result.code} —— ${result.reason}`);
    writeFileSync(output, result.plaintext);
    console.log(`解开信封：${basename(input)} → ${basename(output)}（${result.plaintext.length} 字节）`);
    process.exit(0);
  }

  fail(`未知子命令：${command}`);
}

main();
