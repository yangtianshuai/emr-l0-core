# NOTICE

Required Notice: Copyright (c) 2026 宏医AI

本仓库按 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权 —— 详见 [`README.md`](README.md) 的「许可」一节：
**非商业使用免费，任何商业用途都需另行取得书面授权**。

## 第三方的东西

- 许可文本自身：`© PolyForm Project Inc.`，全文见 <https://polyformproject.org/licenses/noncommercial/1.0.0>
- 运行时依赖：**没有**。只使用 Node 内置模块（`node:crypto` / `node:sqlite` / `node:http` …），
  没有 `node_modules`、没有构建步骤
- **SM4 由运行时 OpenSSL 提供**（不自研）；SM3 与 SM2 是本仓库自研并用国标示例向量与 OpenSSL 交叉验证
- `tools/voice-client/*.cs`：用系统自带 `csc.exe`（.NET Framework 4.x）编译，不依赖 NuGet
- 演示数据全部为**虚构合成**：患者姓名一律掩码（`王**`），身份类号码为合成号；
  `artifacts/` 下是演示产物，已由 `npm run scan:phi` 排查

## 不能拿它去声明的事

- 不能声称符合 **GB/T 48666**（正文尚未公开）
- 不能声称支持 **WS/T 500**（章节与数据元编码尚未与标准原文核完）
- 不能作为**合规证据**使用：自研密码学未经第三方审计，生产必须换成经认证的密码模块
- 演示私钥 `DEMO_SIGNING_SEED` 写在源码里、可由公开种子推导 —— **只用于演示**

完整边界见 [`README.md`](README.md)「现在不能做什么」。
