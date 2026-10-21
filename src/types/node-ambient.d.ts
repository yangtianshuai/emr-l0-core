declare const process: {
  version: string;
  platform: string;
  argv: string[];
  execPath: string;
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code?: number): void;
};

interface MinimalBuffer extends Uint8Array {
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
  export function writeFileSync(path: string, data: string | Uint8Array, encoding?: 'utf8'): void;
  export function writeFileSync(path: string, data: string | Uint8Array, options: { encoding?: 'utf8'; flag?: string; mode?: number }): void;
  export function appendFileSync(path: string, data: string | Uint8Array, encoding?: 'utf8'): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive?: boolean }): string | undefined;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  export function statSync(path: string): { isDirectory(): boolean };
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

  export interface KeyObject {
    export(options: { format: 'der'; type: 'spki' | 'pkcs8' }): Uint8Array;
    readonly asymmetricKeyType?: string;
    readonly asymmetricKeyDetails?: { namedCurve?: string };
  }
  export interface KeyPair {
    privateKey: KeyObject;
    publicKey: KeyObject;
  }
  export function generateKeyPairSync(type: 'ec', options: { namedCurve: string }): KeyPair;
  export function createPublicKey(options: { key: Uint8Array; format: 'der'; type: 'spki' }): KeyObject;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function sign(algorithm: string, data: Uint8Array, key: KeyObject): Uint8Array;
  export function verify(algorithm: string, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
  export function randomBytes(size: number): MinimalBuffer;

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
  export function getCiphers(): string[];
  export function getHashes(): string[];
}

declare module 'node:zlib' {
  export function inflateRawSync(buffer: Uint8Array): Uint8Array;
}

declare module 'node:net' {
  export interface Socket {
    once(event: 'connect', listener: () => void): void;
    once(event: 'error', listener: () => void): void;
    destroy(): void;
  }
  export function connect(port: number, host: string): Socket;
}

declare module 'node:os' {
  export function tmpdir(): string;
  const os: {
    platform(): string;
    arch(): string;
    cpus(): Array<{ model: string }>;
    totalmem(): number;
  };
  export default os;
}
