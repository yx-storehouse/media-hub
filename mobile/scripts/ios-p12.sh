#!/usr/bin/env bash
# 第 2 步：把 Apple 网站下载的发布证书（distribution.cer）和第 1 步（ios-csr.sh）的私钥合成 .p12，
# 打印 GitHub Actions 要用的 secrets（IOS_CERT_P12_BASE64、IOS_CERT_PASSWORD、IOS_TEAM_ID、KEYCHAIN_PASSWORD）。
#
#   bash mobile/scripts/ios-p12.sh <distribution.cer 的路径> [保存目录，默认 ~/.reel-keys/ios]
#
# 生成的文件都在保存目录里（仓库外面），和私钥一起备份：
#   reel-ios-distribution.p12           证书 + 私钥（有密码）
#   reel-ios-distribution.p12.password  .p12 的密码（随机生成）
#   reel-ios-distribution.p12.base64    .p12 的 base64，填 GitHub secret 用
set -euo pipefail

CER="${1:-}"
DIR="${2:-$HOME/.reel-keys/ios}"
REPO="yx-storehouse/media-hub"
NAME=reel-ios-distribution

if [ -z "$CER" ] || [ ! -f "$CER" ]; then
  echo "用法：bash mobile/scripts/ios-p12.sh <Apple 网站下载的 distribution.cer> [保存目录，默认 ~/.reel-keys/ios]"
  exit 1
fi
if [ ! -f "$DIR/$NAME.key" ]; then
  echo "在 $DIR 里找不到私钥 $NAME.key：证书必须用 ios-csr.sh 生成的 CSR 申请，并且用同一个保存目录。"
  exit 1
fi
command -v openssl > /dev/null || { echo "找不到 openssl：Windows 上请在 Git Bash 里运行"; exit 1; }

umask 077
cp "$CER" "$DIR/$NAME.cer"
cd "$DIR"

# Apple 给的证书是 DER 格式；万一已经是 PEM 也能处理
openssl x509 -inform DER -in "$NAME.cer" -out "$NAME.pem" 2> /dev/null \
  || openssl x509 -in "$NAME.cer" -out "$NAME.pem" 2> /dev/null \
  || { echo "$CER 不是证书文件（应该是 Apple 网站下载的 .cer）"; exit 1; }

# 证书和私钥必须是一对
CERT_PUB=$(openssl x509 -in "$NAME.pem" -noout -pubkey | openssl sha256)
KEY_PUB=$(openssl pkey -in "$NAME.key" -pubout | openssl sha256)
if [ "$CERT_PUB" != "$KEY_PUB" ]; then
  echo "这个证书和 $DIR/$NAME.key 不是一对：申请证书时上传的不是这个私钥生成的 CSR。"
  exit 1
fi

SUBJECT=$(openssl x509 -in "$NAME.pem" -noout -subject -nameopt multiline,utf8)
TEAM_ID=$(printf '%s\n' "$SUBJECT" | sed -n 's/^ *organizationalUnitName *= *//p' | head -n 1)
CN=$(printf '%s\n' "$SUBJECT" | sed -n 's/^ *commonName *= *//p' | head -n 1)
EXPIRES=$(openssl x509 -in "$NAME.pem" -noout -enddate | sed 's/^notAfter=//')
case "$CN" in
  "Apple Distribution"*|"iPhone Distribution"*) ;;
  *) echo "提醒：证书名字是「${CN}」，不是 Apple Distribution。GitHub Actions 打包需要的是 Apple Distribution 证书。" ;;
esac

# 随机密码；用 3DES / SHA1 的老格式，macOS 的钥匙串（GitHub 的 Mac 打包机）才能导入
PASS=$(openssl rand -hex 16)
openssl pkcs12 -export -inkey "$NAME.key" -in "$NAME.pem" -name "Reel Apple Distribution" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
  -out "$NAME.p12" -passout "pass:$PASS"
printf '%s' "$PASS" > "$NAME.p12.password"
openssl base64 -A -in "$NAME.p12" -out "$NAME.p12.base64"
openssl pkcs12 -in "$NAME.p12" -passin "pass:$PASS" -noout 2> /dev/null || { echo "生成的 .p12 打不开"; exit 1; }
rm -f "$NAME.pem"

cat <<EOF

已生成 .p12（保存目录：${DIR}）
  证书：$CN
  Team ID：$TEAM_ID
  到期：$EXPIRES

在 Git Bash 里依次运行下面这些命令，把它们存成 GitHub 的 secrets（需要先 gh auth login）：

  gh secret set IOS_CERT_P12_BASE64 -R $REPO < "$DIR/$NAME.p12.base64"
  gh secret set IOS_CERT_PASSWORD -R $REPO < "$DIR/$NAME.p12.password"
  gh secret set IOS_TEAM_ID -R $REPO --body "$TEAM_ID"
  gh secret set KEYCHAIN_PASSWORD -R $REPO --body "\$(openssl rand -hex 24)"

不用 gh 的话：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，
名字照上面填，值分别是 $NAME.p12.base64 的全部内容、$NAME.p12.password 的内容、${TEAM_ID}、随便一串长密码。

把整个 $DIR 文件夹备份好（U 盘 / 密码管理器），不要放进仓库、不要发到群里。

在网页里粘贴的话，IOS_CERT_P12_BASE64 的值就是下面两条横线之间的那一整行（和 $NAME.p12.base64 的内容一样）：
EOF
echo "-----------------------------------------------------------------"
cat "$NAME.p12.base64"
echo
echo "-----------------------------------------------------------------"
