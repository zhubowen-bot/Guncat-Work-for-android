# 本机签名密钥

`npm run dist:android` 第一次构建会自动生成本目录下的 `guncat.jks`：

- alias：`guncat`
- store password / key password：`guncat-work`
- 有效期：10000 天

这是**自用调试/分发密钥**，不是上架商店的正式密钥。它已经加进 `.gitignore`，不会提交。

## 注意

- 升级安装必须使用同一把钥匙；删掉 `guncat.jks` 后重新构建会产生新证书，Android 会拒绝覆盖安装
  （需要先卸载，应用数据也随之丢失）。
- 想换密码/路径时用环境变量覆盖：
  - `GUNCAT_KEYSTORE=E:\keys\guncat.jks`
  - `GUNCAT_KS_PASS=你的密码`
- 如果要发布到应用商店，请换一把离线保存的正式密钥，并把密码放进 CI secret。
