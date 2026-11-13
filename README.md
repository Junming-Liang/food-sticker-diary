# 轻食日记

一个手机优先的开源饮食记录应用。拍下食物、生成透明贴纸、估算营养，并把某一天的记录分享给搭子。参考了轻果健康的公开界面与使用流程；本项目是独立实现，与原应用及其开发者无关联。

## 已有功能

- 手机端每日热量环、三餐和加餐、贴纸墙、七日趋势。
- 食物照片自动抠图；识别结果、餐次、重量和营养均可手动修改。贴纸可下载为透明 PNG。
- 内置常见食物库，可搜索食材并按重量估算热量与营养；手动修改后的数值不会被重量变化覆盖。
- 支持在个人设置中配置 DeepSeek 或 OpenAI 的视觉模型与 API 密钥。食物照片会发送到选定服务商，可能产生 API 费用。
- 没有 API 密钥时可使用本地 Food-101 模型给出菜品候选；这个模型主要覆盖 101 类常见西式菜品；部分候选可匹配食物库并按 100 克给出参考热量，照片**不能确定实际重量**，必须核对并修改。中餐、混合餐和看不清的照片可能识别错误。
- 独立账号、饮水、体重、手动运动和断食计时记录。运动消耗会计入当天剩余热量。
- 双方确认后绑定一位搭子，互看每日热量和贴纸；每个人都可以暂停自己的共享或解除绑定。
- 有效期为 7 天、可撤销的单日只读分享链接。持有链接的人均可查看对应日期的餐食及贴纸。
- PWA：支持手机浏览器打开，并可通过浏览器的“添加到主屏幕”安装。

本项目目前覆盖上述核心功能，不包含原应用全部功能；例如原生系统桌面小组件、灵动岛和 Apple 健康同步尚未实现。热量和营养为估算值，不构成医疗建议。

## 运行

已在 Python 3.12、3.13 上验证；本地模型需要约 100 MB 空间。

```bash
git clone https://github.com/Junming-Liang/food-sticker-diary.git
cd food-sticker-diary
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python scripts/download_models.py
FOOD_BASE=/ FOOD_COOKIE_SECURE=0 waitress-serve --listen=127.0.0.1:8792 app:app
```

本地打开 `http://127.0.0.1:8792/`。模型下载器会校验 SHA-256；如果模型不可用，仍可手动记录或配置云端视觉服务，但自动抠图需要 U2NetP 模型。

手机上可使用 Safari 的“分享 → 添加到主屏幕”，或 Android 浏览器的安装选项将应用加入桌面。PWA 仍需要网络访问个人数据和识别服务。

`FOOD_COOKIE_SECURE=0` 仅用于本地 HTTP。生产环境应启用 HTTPS，并使用默认的安全 Cookie。设置 `FOOD_BASE` 为对外路径，例如 `/food-diary/`；代理需剥离该路径前缀。`deploy/` 包含 systemd 和 Nginx 示例。若修改对外路径，请同步修改服务环境变量与代理配置。

## 食物库数据

内置食物库由 [USDA FoodData Central](https://fdc.nal.usda.gov/download-datasets/) 的 SR Legacy 2018 和 FNDDS 2021–2023 中的食材及参考菜品整理，数值以每 100 克为基准，并提供每条原始数据链接。中文名称保留生熟及烹调条件；请选取与实际食物接近的条目。相同食物的品种、含水量、调味和烹饪用油可能导致明显差异，混合菜应结合具体配料调整。份量默认为 100 克，需要按实际情况修改。

食物数据可从 USDA 的 SR Legacy CSV 和 FNDDS 2021–2023 JSON 压缩包重建：

```bash
python scripts/build_foods.py /path/to/sr_legacy.zip /path/to/fndds_2021-2023.zip
```

## 配置视觉识别

1. 注册并登录，打开“我的 → 热量目标与识别设置”。
2. 选择 DeepSeek 或 OpenAI，填写有图片输入能力的模型与 API 密钥。默认模型分别为 `deepseek-flash` 和 `gpt-4o-mini`，可按账号权限修改。
3. 拍照或选择图片。识别完成后，核对名称、重量、热量及三大营养素，再保存。

### 使用另一台机器桥接 OpenAI

如果部署服务器不能直连 OpenAI，而另一台受信任、长期联网的机器可以访问，可参考 `deploy/food-openai-bridge.service` 创建 SSH 反向隧道。该示例只将服务器本机的 `127.0.0.1:18796` 转发到 `api.openai.com:443`，不是通用代理；需先配置好 SSH 主机别名、密钥登录与已验证的主机指纹。示例以 `tecent_blog` 为 SSH 别名，其他环境请修改。

```bash
# 在具备 OpenAI 连通性的机器，以普通用户执行
mkdir -p ~/.config/systemd/user
cp deploy/food-openai-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now food-openai-bridge.service
```

在服务器仅供 root 读写的 `/etc/food-sticker-diary/network.env` 中设置 `FOOD_OPENAI_TUNNEL_PORT=18796`，并重启 `food-sticker-diary.service`。应用仍以 `api.openai.com` 验证 HTTPS 证书，API 密钥及照片在端到端 TLS 中传输。桥接机器关机或断网时 OpenAI 不可用，本地识别与 DeepSeek 不经过该隧道。是否可在服务商支持的地区使用及相关费用，仍以服务商规则为准。请继续在应用中配置自己的 OpenAI API 密钥。

如服务器无法直连所选服务，可由服务器管理员配置标准 HTTP CONNECT 代理：在权限为 `0600` 的 `/etc/food-sticker-diary/network.env` 中设置 `HTTPS_PROXY=http://代理地址:端口`，然后重启服务。该文件由 systemd 读取，不要提交到仓库。连接质量、地区支持和费用取决于代理与服务商。

服务仅请求固定的官方 API 地址，避免将密钥发送至用户输入的任意网址。密钥由服务端加密存储，不会再次返回给浏览器；加密密钥和数据保存在同一台服务器，拥有服务器访问权限的管理员仍需保护它们。切换服务商时需重新填写密钥。

## 数据与分享

SQLite 数据库、图片、会话及密钥保存在 `FOOD_DATA` 指向的目录中，默认是项目的 `data/`。请使用 SQLite 在线备份或在停机后备份整个目录，同时保留 `secret.key`；丢失该文件会导致保存的 API 密钥和现有分享链接无法解密。**不要把该目录提交到公开仓库。**

分享链接具有访问凭证的作用：任何持有链接的人在有效期内都可查看该日期的记录，请只发送给信任的人。可在“我的 → 分享管理”中撤销。搭子邀请 24 小时内有效，接受邀请会开始双方共享，之后任何一方都能暂停或解除。账号、所有记录、图片和分享可通过“删除账号及数据”永久删除；目前没有密码找回功能，请妥善保管密码。

## 验证

```bash
python -m unittest discover -s tests -v
```

测试覆盖账号隔离、分享和撤销、搭子权限、运动记录、断食计时、输入校验、账号删除与视觉请求格式。云端视觉接口的真实调用需要各自有效的 API 密钥。

可选的手机浏览器冒烟测试需要 Node.js 和本机 Chrome。先按照上面的本地运行步骤启动应用，再执行：

```bash
npm ci
npm run test:ui
```

可用 `CHROME_BIN` 指定 Chrome 路径，用 `FOOD_TEST_URL` 指定测试实例。测试会创建并删除临时账号，请只对有权测试的实例运行。

## 模型和许可证

项目代码使用 MIT 许可证。内置食物数据来源于 [USDA FoodData Central](https://fdc.nal.usda.gov/api-guide/)，原始数据属于公共领域。模型权重不包含在仓库中，请分别查看上游许可证：

- [Food-101 Swin ONNX](https://huggingface.co/onnx-community/swin-finetuned-food101-ONNX)，Apache-2.0。
- [U²-Net](https://github.com/xuebinqin/U-2-Net)，Apache-2.0；本项目下载 [rembg 发布的 U2NetP ONNX 权重](https://github.com/danielgatis/rembg)。

该项目不包含原应用的商标、图标或界面素材。
