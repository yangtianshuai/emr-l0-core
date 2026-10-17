/**
 * 库内载荷的**形状标识**。
 *
 * 单独一个文件，是为了让"库里存的是什么形状"这件事**只有一个来源** ——
 * 散在仓储的各处常量，迟早会出现"写的时候是 v1、读的时候按 v2 解"这种没人能查的故障。
 *
 * 与信封版本的分工见 `sealed.ts` 文件头：信封回答"密文怎么解"，这里回答"解出来该长什么样"。
 * **改形状必须换标识**（不是改版本号就能蒙过去），旧标识的读取路径要显式迁移。
 */
export const DOCUMENT_FORMAT = 'l0-document/1';
export const SIDECARS_FORMAT = 'l0-sidecars/1';
export const KV_FORMAT = 'l0-kv/1';
export const READING_GRANT_FORMAT = 'l0-reading-grant/1';
