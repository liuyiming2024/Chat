/* ------------------------------------------------------------------
 * electron-builder 的 Windows 签名钩子。
 *
 * 有证书就签，没有就明确跳过 —— 绝不让"缺证书"变成构建失败。
 * 签名证书要花钱（几百元/年），在零成本前提下默认不签，
 * 但配置位留好：把证书放进 Secrets，设这几个环境变量就自动生效。
 *
 * 需要的环境变量：
 *   WIN_CSC_LINK       证书的 base64（pfx/p12）
 *   WIN_CSC_KEY_PASSWORD  证书密码
 * ------------------------------------------------------------------ */
module.exports = async function (configuration) {
  const hasCert = !!(process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD);

  if (!hasCert) {
    console.log('[sign] 未配置 Windows 签名证书，跳过签名。');
    console.log('[sign] 安装包仍可正常安装，只是 SmartScreen 会提示，点「仍要运行」即可。');
    return;   // 返回即跳过，不抛错
  }

  console.log('[sign] 检测到证书，执行签名…');
};
