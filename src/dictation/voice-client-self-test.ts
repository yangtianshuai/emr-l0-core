import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { createChunkAssembler, type CaptureFrame, type SegmentConfig } from './capture.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXE = join(ROOT, 'tools', 'voice-client', 'bin', 'VoiceCaptureClient.exe');

const suite = new TestSuite('语音采集客户端（Windows exe）', [
  '构建：powershell -ExecutionPolicy Bypass -File tools/voice-client/build.ps1',
  '真麦克风不在这里验证（自测不开设备）：用 --source tone 走同一条分片与桥通道。',
]);

interface TimelineStep {
  seconds: number;
  voiced: boolean;
}

function runJsTimeline(steps: TimelineStep[], config: SegmentConfig): {
  segments: { index: number; startSec: number; endSec: number; reason: string; wavBytes: number }[];
  droppedShort: number;
  elapsedSec: number;
} {
  const assembler = createChunkAssembler(config);
  const segments: { index: number; startSec: number; endSec: number; reason: string; wavBytes: number }[] = [];
  let cursor = 0;
  const frameSec = 0.5;
  for (const step of steps) {
    const frames = Math.max(1, Math.round(step.seconds / frameSec));
    for (let i = 0; i < frames; i += 1) {
      const frame: CaptureFrame = {
        startSec: cursor,
        endSec: cursor + frameSec,
        voiced: step.voiced,
        pcm: new Uint8Array(Math.round(frameSec * 16000) * 2),
      };
      cursor = frame.endSec;
      for (const chunk of assembler.feed(frame)) {
        segments.push({
          index: chunk.plan.index,
          startSec: chunk.plan.startSec,
          endSec: chunk.plan.endSec,
          reason: chunk.plan.reason,
          wavBytes: chunk.audio.byteLength,
        });
      }
    }
  }
  for (const chunk of assembler.finish(cursor)) {
    segments.push({
      index: chunk.plan.index,
      startSec: chunk.plan.startSec,
      endSec: chunk.plan.endSec,
      reason: chunk.plan.reason,
      wavBytes: chunk.audio.byteLength,
    });
  }
  return { segments, droppedShort: assembler.droppedShort, elapsedSec: cursor };
}

function timelineSpec(steps: TimelineStep[]): string {
  return steps.map((step) => `${step.seconds},${step.voiced ? 1 : 0}`).join(';');
}

function runSelftest(steps: TimelineStep[], config: SegmentConfig): {
  segments: { index: number; startSec: number; endSec: number; reason: string; wavBytes: number }[];
  droppedShort: number;
  elapsedSec: number;
} {
  const result = spawnExeSync([
    '--selftest-segments',
    '--timeline',
    timelineSpec(steps),
    '--config',
    `${config.silenceMs},${config.maxSeconds},${config.minSeconds}`,
  ]);
  const parsed = JSON.parse(result) as {
    ok?: boolean;
    segments?: { index: number; startSec: number; endSec: number; reason: string; wavBytes: number }[];
    droppedShort?: number;
    elapsedSec?: number;
  };
  assert(parsed.ok === true, `exe 对拍模式没有返回 ok：${result}`);
  return {
    segments: parsed.segments ?? [],
    droppedShort: parsed.droppedShort ?? -1,
    elapsedSec: parsed.elapsedSec ?? -1,
  };
}

function spawnExeSync(args: string[]): string {
  const result = spawnSync(EXE, args, { encoding: 'utf8' });
  if (result.error !== undefined && result.error !== null) throw result.error;
  assert(result.status === 0, `exe 退出码 ${result.status}：${result.stderr ?? result.stdout ?? ''}`);
  return (result.stdout ?? '').trim();
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer(() => {});
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address === null ? 0 : address.port;
      server.close(() => resolve(port));
    });
  });
}

interface BridgeReply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

async function bridge(
  port: number,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; token?: string } = {},
): Promise<BridgeReply> {
  const token = options.token ?? '';
  const res = await fetch(`http://127.0.0.1:${port}${path}${token === '' ? '' : `?token=${encodeURIComponent(token)}`}`, {
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json, headers: res.headers };
}

async function waitForHello(port: number, token: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const reply = await bridge(port, '/dictation-capture/hello', { token });
      if (reply.status === 200) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('客户端 6s 内没有就绪');
}

const BASE_CONFIG: SegmentConfig = { silenceMs: 800, maxSeconds: 30, minSeconds: 1 };

async function main(): Promise<void> {
  if (!existsSync(EXE)) throw new Error(`找不到 ${EXE}：先运行 tools/voice-client/build.ps1`);

  await suite.test('VC1 分片规则 ≡ capture.ts：逐段号、逐区间、逐 WAV 字节数', () => {
    const cases: { name: string; steps: TimelineStep[]; config: SegmentConfig }[] = [
      { name: '静音判停', steps: [{ seconds: 2, voiced: true }, { seconds: 1.5, voiced: false }, { seconds: 2, voiced: true }], config: BASE_CONFIG },
      { name: '超长优先', steps: [{ seconds: 5, voiced: true }, { seconds: 1.5, voiced: false }, { seconds: 2, voiced: true }], config: { ...BASE_CONFIG, maxSeconds: 3 } },
      { name: '过短丢弃', steps: [{ seconds: 0.5, voiced: true }, { seconds: 1.5, voiced: false }, { seconds: 1, voiced: true }], config: { ...BASE_CONFIG, minSeconds: 2 } },
    ];
    for (const item of cases) {
      const expected = runJsTimeline(item.steps, item.config);
      const actual = runSelftest(item.steps, item.config);
      assertEqual(actual.segments.length, expected.segments.length, `${item.name}：段数不一致（exe ${JSON.stringify(actual.segments)} / js ${JSON.stringify(expected.segments)}）`);
      for (let i = 0; i < expected.segments.length; i += 1) {
        const a = actual.segments[i] as { index: number; startSec: number; endSec: number; reason: string; wavBytes: number };
        const e = expected.segments[i] as { index: number; startSec: number; endSec: number; reason: string; wavBytes: number };
        assertEqual(a.index, e.index, `${item.name}：第 ${i + 1} 段段号不一致`);
        assert(Math.abs(a.startSec - e.startSec) < 1e-9, `${item.name}：第 ${i + 1} 段起点 ${a.startSec} ≠ ${e.startSec}`);
        assert(Math.abs(a.endSec - e.endSec) < 1e-9, `${item.name}：第 ${i + 1} 段终点 ${a.endSec} ≠ ${e.endSec}`);
        assertEqual(a.reason, e.reason, `${item.name}：第 ${i + 1} 段定稿原因不一致`);
        assertEqual(a.wavBytes, e.wavBytes, `${item.name}：第 ${i + 1} 段 WAV 字节数不一致`);
      }
      assertEqual(actual.droppedShort, expected.droppedShort, `${item.name}：短片计数不一致`);
      assert(Math.abs(actual.elapsedSec - expected.elapsedSec) < 1e-9, `${item.name}：总时长不一致`);
    }
  });

  await suite.test('VC2 桥协议：令牌 / 未开始 / 配置非法 / 取段取音频 / 乱序拒绝 / ack 释放 / done 汇总', async () => {
    const port = await freePort();
    const token = 'vc-self-test-token';
    const child = spawn(EXE, ['--source', 'tone', '--port', String(port), '--token', token], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    let output = '';
    child.stdout?.on('data', (chunk: Uint8Array) => { output += new TextDecoder().decode(chunk); });
    child.stderr?.on('data', (chunk: Uint8Array) => { output += new TextDecoder().decode(chunk); });
    try {
      await waitForHello(port, token);

      const noToken = await bridge(port, '/dictation-capture/hello');
      assertEqual(noToken.status, 401, '没有令牌必须 401（回环端口不是安全边界）');
      assertEqual(noToken.json.code, 'E_BRIDGE_BAD_TOKEN', `401 的错误码不对：${JSON.stringify(noToken.json)}`);

      const hello = await bridge(port, '/dictation-capture/hello', { token });
      assertEqual(hello.status, 200, '带令牌的 /hello 应 200');
      assertEqual(hello.json.ok, true, '/hello 应 ok');
      assertEqual(hello.json.client, 'l0-dictation-client', '/hello 的 client 标识应与 Node 客户端一致');
      assertEqual(hello.json.tokenRequired, true, '启用令牌时 /hello 要如实告知页面');
      assert(String(hello.json.source).includes('tone'), `source 应如实说明是合成音频：${String(hello.json.source)}`);
      assertEqual(hello.headers.get('access-control-allow-origin'), '*', '跨源响应必须带 CORS：页面在 8787，桥在别的端口');

      const notStarted = await bridge(port, '/dictation-capture/next', { token });
      assertEqual(notStarted.json.code, 'E_BRIDGE_NOT_STARTED', '没开始采集时 /next 应明确报未开始');

      const badConfig = await bridge(port, '/dictation-capture/start', {
        method: 'POST',
        token,
        body: { silenceMs: 0, maxSeconds: 30, minSeconds: 1 },
      });
      assertEqual(badConfig.json.code, 'E_CAPTURE_CONFIG_INVALID', '非法配置必须报错，不能静默取默认值');

      const started = await bridge(port, '/dictation-capture/start', { method: 'POST', token, body: BASE_CONFIG });
      assertEqual(started.json.ok, true, `开始采集失败：${JSON.stringify(started.json)}`);
      const sessionId = String(started.json.sessionId);
      assert(sessionId.startsWith('client-capture-'), `会话号形状不对：${sessionId}`);

      const segments: { index: number; wav: Uint8Array; startSec: number; endSec: number }[] = [];
      let firstAudio: Uint8Array | null = null;
      let done: Record<string, unknown> | null = null;
      for (let i = 0; i < 120; i += 1) {
        const next = await bridge(port, '/dictation-capture/next', { token });
        const payload = next.json.next as Record<string, unknown> | undefined;
        assert(payload !== undefined, `/next 没有返回 next：${JSON.stringify(next.json)}`);
        if (payload.kind === 'done') {
          done = payload;
          break;
        }
        if (payload.kind !== 'segment') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        const segment = payload.segment as { index: number; startSec: number; endSec: number };
        const audioRes = await fetch(`http://127.0.0.1:${port}/dictation-capture/audio/${segment.index}?token=${encodeURIComponent(token)}`);
        assertEqual(audioRes.status, 200, `第 ${segment.index} 段取音频失败（HTTP ${audioRes.status}）`);
        assertEqual(audioRes.headers.get('content-type'), 'audio/wav', '段音频的 Content-Type 必须是 audio/wav');
        const wav = new Uint8Array(await audioRes.arrayBuffer());
        const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        assertEqual(String.fromCharCode(...wav.slice(0, 4)), 'RIFF', 'WAV 魔数不对');
        assertEqual(String.fromCharCode(...wav.slice(8, 12)), 'WAVE', 'WAV 头不对');
        assertEqual(view.getUint32(24, true), 16000, 'WAV 采样率必须是 16k');
        assertEqual(view.getUint16(22, true), 1, 'WAV 必须是单声道');
        assertEqual(view.getUint16(34, true), 16, 'WAV 必须是 16-bit');
        assertEqual(view.getUint32(40, true), wav.byteLength - 44, 'WAV data 长度必须与文件长度自洽');
        if (firstAudio === null) firstAudio = wav;
        segments.push({ index: segment.index, wav, startSec: segment.startSec, endSec: segment.endSec });

        const outOfOrder = await bridge(port, '/dictation-capture/ack', {
          method: 'POST',
          token,
          body: { index: segment.index + 99, ok: true },
        });
        assertEqual(outOfOrder.json.code, 'E_BRIDGE_ACK_OUT_OF_ORDER', '乱序 ack 必须拒绝：跳着确认会让"哪段没进病历"无从解释');

        const ack = await bridge(port, '/dictation-capture/ack', {
          method: 'POST',
          token,
          body: { index: segment.index, ok: true },
        });
        assertEqual(ack.json.ok, true, `ack 第 ${segment.index} 段失败：${JSON.stringify(ack.json)}`);

        const released = await fetch(`http://127.0.0.1:${port}/dictation-capture/audio/${segment.index}?token=${encodeURIComponent(token)}`);
        assertEqual(released.status, 404, 'ack 之后该段音频必须释放（不是"还能再取一次"）');
      }

      assert(done !== null, `12s 内没有收完：已取 ${segments.length} 段；进程输出：${output}`);
      assertEqual(done.total, segments.length, `done.total(${String(done.total)}) 应等于已取段数(${segments.length})`);
      assertEqual(segments.length, 2, `tone 时间线应产出 2 段，实际 ${segments.length}`);
      assert(Math.abs(segments[0].startSec) < 1e-9, `第 1 段应从 0 起，实际 ${segments[0].startSec}`);
      assert(segments[0].endSec - segments[0].startSec >= 1, '第 1 段不应短于 minSeconds');
      assertEqual(segments[1].startSec, segments[0].endSec, '相邻分片必须首尾相接（S2）');

      const stopped = await bridge(port, '/dictation-capture/stop', { method: 'POST', token, body: {} });
      assertEqual(stopped.json.ok, true, '停止必须成功');
    } finally {
      child.kill();
    }
  });

  await suite.test('VC3 无令牌模式：只按 Origin 白名单放行（跨源网页被拒，医生端与本机进程可用）', async () => {
    const port = await freePort();
    const child = spawn(EXE, ['--source', 'tone', '--port', String(port), '--page', 'http://127.0.0.1:8787/'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    const helloUrl = `http://127.0.0.1:${port}/dictation-capture/hello`;
    try {
      await waitForHello(port, '');

      const open = await bridge(port, '/dictation-capture/hello');
      assertEqual(open.status, 200, '没启用令牌时 /hello 应可直接访问（本机进程没有 Origin）');
      assertEqual(open.json.tokenRequired, false, '/hello 要告知本次未启用令牌');

      const evil = await fetch(helloUrl, { headers: { Origin: 'http://evil.example' } });
      assertEqual(evil.status, 403, '别的网页来源必须被拒：没有令牌时 Origin 就是那道门');
      const evilBody = (await evil.json()) as Record<string, unknown>;
      assertEqual(evilBody.code, 'E_BRIDGE_ORIGIN_DENIED', '被拒时要给出明确错误码');

      const good = await fetch(helloUrl, { headers: { Origin: 'http://127.0.0.1:8787' } });
      assertEqual(good.status, 200, '医生端来源（--page 的 origin）应放行');

      const evilStart = await fetch(`http://127.0.0.1:${port}/dictation-capture/start`, {
        method: 'POST',
        headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_CONFIG),
      });
      assertEqual(evilStart.status, 403, '跨源网页不得开始采集（不能只挡读、不挡写）');
    } finally {
      child.kill();
    }
  });

  await suite.test('VC4 多块录音卡：能列设备、能按编号/名字选，选不到就拒绝启动（不回落默认）', async () => {
    const listed = spawnExeSync(['--list-devices']);
    const parsed = JSON.parse(listed) as { ok?: boolean; devices?: unknown };
    assert(parsed.ok === true, `--list-devices 应返回 ok：${listed}`);
    assert(Array.isArray(parsed.devices), '--list-devices 的 devices 必须是数组（0 块设备时也要是空数组，不能缺字段）');

    /* 指定了却找不到必须退出：静默回落系统默认 = 录到别的麦克风，而且界面上看不出来 */
    const port = await freePort();
    const denied = spawnSync(EXE, ['--device', '999999', '--source', 'mic', '--port', String(port)], { encoding: 'utf8' });
    assertEqual(denied.status, 2, `选不到设备时应以 2 退出，实际 ${denied.status}`);
    assert(
      (denied.stderr ?? '').includes('选设备失败'),
      `退出前要说清"选设备失败"（不能静默回落）：${denied.stderr ?? ''}`,
    );
    assert(
      (denied.stderr ?? '').includes('怎么办'),
      `选设备失败也要给"怎么办"（可用设备 / 换编号），否则运维只能猜：${denied.stderr ?? ''}`,
    );

    const bogusName = spawnSync(EXE, ['--device', '不存在的卡', '--source', 'mic', '--port', String(port + 1)], { encoding: 'utf8' });
    assertEqual(bogusName.status, 2, '名字匹配不到时也必须拒绝启动');

    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    assert(!listening, '选设备失败时不得监听端口（否则页面会连上一个"连上了但采不到音"的客户端）');

    const tone = spawnExeSync(['--source', 'tone', '--selftest-segments', '--timeline', '1,1', '--config', '800,30,1']);
    assert(JSON.parse(tone).ok === true, 'tone 模式不该被设备选择影响');
  });

  await suite.test('VC5 无帧看门狗：设备中途停摆要报出来，收到帧后立刻恢复', () => {
    const raw = spawnExeSync(['--selftest-stall', '--stall-ms', '150']);
    const parsed = JSON.parse(raw) as {
      ok?: boolean; timeoutMs?: number; freshBlocked?: boolean; stalled?: boolean; afterReset?: boolean;
    };
    assertEqual(parsed.ok, true, `看门狗三条判定应同时成立：${raw}`);
    assertEqual(parsed.freshBlocked, false, '刚收到帧就报停摆是误报：那会把正常采集立刻掐断');
    assertEqual(parsed.stalled, true, `超时之后必须判定停摆（设备拔掉时页面才不会只看到"秒数不动"）：${raw}`);
    assertEqual(parsed.afterReset, false, '收到帧后必须立刻恢复，否则设备抖一下这次采集就再也起不来');
  });

  await suite.test('VC6 本机配置与开机启动：能读能写、坏值不落盘、自启命令带 --tray', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-config-'));
    const cfg = join(dir, 'client.json');
    try {
      const empty = JSON.parse(spawnExeSync(['--print-config', '--config-file', cfg])) as Record<string, unknown>;
      assertEqual(empty.ok, true, '--print-config 应返回 ok');
      assertEqual(empty.device, '', '默认设备为空（= 系统默认）');
      assertEqual(typeof empty.tray, 'boolean', '配置里必须有 tray（托盘开关要有地方存）');
      assertEqual(typeof empty.autostart, 'boolean', '配置里必须有 autostart');

      const saved = JSON.parse(spawnExeSync(['--set-device', 'default', '--config-file', cfg])) as Record<string, unknown>;
      assertEqual(saved.ok, true, '--set-device default 应成功');
      assert(existsSync(cfg), '--set-device 要真的落盘（否则"改完就记住"是空话）');

      const bad = spawnSync(EXE, ['--set-device', '999999', '--config-file', cfg], { encoding: 'utf8' });
      assertEqual(bad.status, 2, '不存在的设备不得写进配置');
      const after = JSON.parse(spawnExeSync(['--print-config', '--config-file', cfg])) as Record<string, unknown>;
      assertEqual(after.device, '', '失败的写入不能改坏已有配置');

      const auto = JSON.parse(spawnExeSync(['--autostart', 'status'])) as Record<string, unknown>;
      assertEqual(auto.ok, true, '--autostart status 应返回 ok');
      assertEqual(typeof auto.enabled, 'boolean', 'enabled 必须是布尔（"不知道"不能被当成"没开"）');
      assert(
        String(auto.command).includes('--tray'),
        `开机启动命令必须带 --tray（否则每次登录都在屏幕上弹一个黑框）：${String(auto.command)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  process.exit(suite.report());
}

void main().catch((err: Error) => {
  process.stderr.write(`\n${err.stack ?? err.message}\n`);
  process.exit(1);
});
