// Node 内置模块的最小环境声明（临时）。

/** 全局：DOM lib 已声明 console，这里只补 process */
declare const process: {
  version: string;
  platform: string;
  argv: string[];
  /** 当前 Node 可执行文件路径（用于在测试里以子进程方式运行验收探针） */
  execPath: string;
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code?: number): void;
};

/** 最小 Buffer 声明：仅用于 base64/二进制互转（Node 内置，引入 @types/node 后可删） */
interface MinimalBuffer extends Uint8Array {
  /** 参数必须可选：否则与 Uint8Array.toString(): string 不兼容，Buffer 就无法当 Uint8Array 用 */
  toString(encoding?: 'base64' | 'hex' | 'latin1' | 'utf8'): string;
}

declare const Buffer: {
  /** 不传 encoding 时按 utf8 处理（与 Node 一致） */
  from(data: string, encoding?: 'base64' | 'latin1' | 'utf8'): MinimalBuffer;
  from(data: Uint8Array): MinimalBuffer;
  byteLength(data: string, encoding?: 'utf8' | 'latin1'): number;
  /** 拼接字节流（加密自测里与 OpenSSL 的输出比对时需要） */
  concat(list: MinimalBuffer[], totalLength?: number): MinimalBuffer;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8' | 'latin1'): string;
  /** 不带 encoding 时返回原始字节（用于把导出的 OFD 容器原样回传浏览器） */
  export function readFileSync(path: string): Uint8Array;
  /** data 支持 Uint8Array：导出 OFD 时直接写二进制容器（无需 Buffer） */
  export function writeFileSync(path: string, data: string | Uint8Array, encoding?: 'utf8'): void;
  /**
   * 带写入选项的重载：写服务端配置文件时要用 `flag: 'wx'`（两个进程同时启动时只有一个写得成）
   * 与 `mode: 0o600`（它是一把钥匙，不是普通配置）。运行时 Node 本就支持，只是这里缺声明。
    */
  export function writeFileSync(path: string, data: string | Uint8Array, options: { encoding?: 'utf8'; flag?: string; mode?: number }): void;
  /** 追加写入（自测与探针往产物里追加一行时用） */
  export function appendFileSync(path: string, data: string | Uint8Array, encoding?: 'utf8'): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive?: boolean }): string | undefined;
  export function readdirSync(path: string): string[];
  /** 带 `withFileTypes` 的重载：装载算子插件时要逐个目录判（文件不是插件）  */
  export function readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  export function statSync(path: string): { isDirectory(): boolean };
  /** 删除文件（测试清理用；force 时文件不存在也不报错；recursive 删目录） */
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  /** 临时目录（算子插件的自测要在真实文件系统上跑：验的就是"签名覆盖文件"这件事） */
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    error?: Error;
    stdout?: string;
    stderr?: string;
  }
  export function spawnSync(command: string, args?: readonly string[], options?: { encoding?: 'utf8'; cwd?: string; windowsHide?: boolean }): SpawnSyncResult;

  /** 异步子进程：Demo 服务在自测里需要"起服务→打 HTTP→关服务"，spawnSync 会阻塞主线程 */
  export interface ChildProcess {
    pid?: number;
    kill(signal?: string): boolean;
    stdout?: { on(event: 'data', listener: (chunk: Uint8Array) => void): void } | null;
    stderr?: { on(event: 'data', listener: (chunk: Uint8Array) => void): void } | null;
    on(event: 'exit', listener: (code: number | null) => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
  }
  export function spawn(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      stdio?: 'pipe' | 'inherit' | 'ignore';
      windowsHide?: boolean;
      /** 子进程环境：测试用它把"落盘路径"指向临时文件，避免污染真实数据目录 */
      env?: Record<string, string | undefined>;
    },
  ): ChildProcess;
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
  }
  export interface ServerResponse {
    statusCode: number;
    /** 已结束的响应不能再写（错误处理里用于避免重复回包） */
    writableEnded: boolean;
    setHeader(name: string, value: string | number): void;
    end(data?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): Server;
    close(callback?: () => void): void;
    address(): { port: number } | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array, encoding?: 'utf8' | 'latin1'): Hash;
    /** 不传编码时返回原始字节（密钥派生与口令哈希要的是字节，不是十六进制串） */
    digest(): MinimalBuffer;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;

  /** 不透明密钥句柄：只暴露"导出 DER"与"类型自省"，避免上层依赖 Node 的内部结构 */
  export interface KeyObject {
    export(options: { format: 'der'; type: 'spki' | 'pkcs8' }): Uint8Array;
    /**
     * 密钥类型自省。对 SM2 曲线有坑：原生生成的 key 是 'ec'，
     * 而从 DER 导入的 SM2 公钥这里是 undefined（且验签恒失败）—— 见 provider.ts 的说明。
      */
    readonly asymmetricKeyType?: string;
    readonly asymmetricKeyDetails?: { namedCurve?: string };
  }
  export interface KeyPair {
    privateKey: KeyObject;
    publicKey: KeyObject;
  }
  /** 曲线名用字符串传入（如 'SM2'）：各 Node/OpenSSL 版本支持不同，由调用方探测后再用 */
  export function generateKeyPairSync(type: 'ec', options: { namedCurve: string }): KeyPair;
  export function createPublicKey(options: { key: Uint8Array; format: 'der'; type: 'spki' }): KeyObject;
  /**
   * 常数时间比较（比对口令哈希时用：按字节提前返回会泄漏"前几位对了"）。
   * 长度不等时它会抛异常，所以调用方必须先自己比长度 —— 这个约定写在调用处，不写在这里。
    */
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function sign(algorithm: string, data: Uint8Array, key: KeyObject): Uint8Array;
  export function verify(algorithm: string, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
  /** 返回的是 Buffer（Uint8Array 的子类）：`toString('hex')` 用它生成一次性令牌 */
  export function randomBytes(size: number): MinimalBuffer;

  /** 对称加密（SM4 由 OpenSSL 提供；见 crypto/sm4.ts 的说明与自检） */
  export interface Cipher {
    update(data: Uint8Array): Uint8Array;
    final(): Uint8Array;
    /** 流模式（CTR）必须关掉填充，否则尾部会多出一个填充块 */
    setAutoPadding(enabled: boolean): void;
  }
  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array | null): Cipher;

  export interface Hmac {
    update(data: Uint8Array | string, encoding?: 'utf8' | 'latin1'): Hmac;
    digest(): Uint8Array;
    digest(encoding: 'hex'): string;
  }
  export function createHmac(algorithm: string, key: Uint8Array | string): Hmac;
  /** 运行时支持的算法清单（用于能力探测：不能假设每个 OpenSSL 都带国密算法） */
  export function getCiphers(): string[];
  export function getHashes(): string[];
}

declare module 'node:zlib' {
  /** 解压 deflate 原始流（ZIP 的 method=8 用的就是这个） */
  export function inflateRawSync(buffer: Uint8Array): Uint8Array;
}

declare module 'node:net' {
  /** 只声明实际用到的那点：自测里探"这个端口能不能连上"，连上就立刻断开 */
  export interface Socket {
    once(event: 'connect', listener: () => void): void;
    once(event: 'error', listener: () => void): void;
    destroy(): void;
  }
  export function connect(port: number, host: string): Socket;
}

declare module 'node:os' {
  /** 临时目录：算子插件的自测要在一个真实目录里验签与装载 */
  export function tmpdir(): string;
  const os: {
    platform(): string;
    arch(): string;
    cpus(): Array<{ model: string }>;
    totalmem(): number;
  };
  export default os;
}
