#!/usr/bin/env bash
# 第 1 步：生成 Apple 发布证书（Apple Distribution）用的私钥和证书申请文件（CSR）。
#
# Windows 上在 Git Bash 里运行（Git for Windows 自带 openssl），Mac / Linux 的终端也能用：
#
#   bash mobile/scripts/ios-csr.sh 你的Apple账号邮箱 [保存目录]
#
# 保存目录默认是 ~/.reel-keys/ios（Windows 上就是 C:\Users\你\.reel-keys\ios），在仓库外面：
#   reel-ios-distribution.key   私钥。最重要，不要外传、不要放进仓库；丢了证书就作废，只能重新申请
#   reel-ios-distribution.csr   上传到 Apple 开发者网站申请证书用
#
# 下一步：Apple 开发者网站 → Certificates → + → Apple Distribution → 上传 .csr → 下载 distribution.cer，
# 然后运行 mobile/scripts/ios-p12.sh（见 mobile/README.md「iOS」）。
set -euo pipefail

EMAIL="${1:-}"
DIR="${2:-$HOME/.reel-keys/ios}"
KEY=reel-ios-distribution.key
CSR=reel-ios-distribution.csr

if [ -z "$EMAIL" ] || [ "${EMAIL#*@}" = "$EMAIL" ]; then
  echo "用法：bash mobile/scripts/ios-csr.sh 你的Apple账号邮箱 [保存目录，默认 ~/.reel-keys/ios]"
  exit 1
fi
command -v openssl > /dev/null || { echo "找不到 openssl：Windows 上请在 Git Bash 里运行"; exit 1; }

mkdir -p "$DIR"
cd "$DIR"
if [ -e "$KEY" ]; then
  echo "$DIR/$KEY 已经存在，不覆盖（覆盖了之前申请的证书就用不了了）。"
  echo "确实要重新申请的话，先把旧文件挪走。"
  exit 1
fi

umask 077
openssl genrsa -out "$KEY" 2048 2> /dev/null

# 证书主题写在配置文件里：Git Bash 会把以 / 开头的 -subj 参数当成路径改掉
cat > csr.cnf <<EOF
[req]
prompt = no
distinguished_name = dn
[dn]
emailAddress = $EMAIL
CN = Reel Apple Distribution
C = CN
EOF
openssl req -new -sha256 -key "$KEY" -out "$CSR" -config csr.cnf
rm -f csr.cnf
openssl req -in "$CSR" -noout -verify > /dev/null 2>&1 || { echo "生成的 CSR 校验失败"; exit 1; }

cat <<EOF

已生成（保存目录：${DIR}）
  $KEY   私钥，不要外传，和下一步生成的 .p12 一起备份
  $CSR   证书申请文件

下一步：
  1. 打开 https://developer.apple.com/account/resources/certificates/add
  2. 选 Apple Distribution → Continue → 上传 $CSR → 下载 distribution.cer
  3. bash mobile/scripts/ios-p12.sh <下载的 distribution.cer 路径>
EOF
