#!/usr/bin/env bash
# GitHub Actions（macOS）里导入 iOS 签名：证书进临时钥匙串、装描述文件、生成 ios/signing.local.xcconfig。
# 由 .github/workflows/mobile-ios.yml 在 mobile/ 目录下调用，不要在自己的 Mac 上运行（会改钥匙串列表）。
#
# 输入（环境变量）：
#   IOS_CERT_P12_BASE64  IOS_CERT_PASSWORD  IOS_PROFILE_BASE64   必须
#   IOS_TEAM_ID          可选，没有就用描述文件里的 Team
#   KEYCHAIN_PASSWORD    可选，没有就随机生成
#   EXPORT_METHOD        auto / ad-hoc / app-store-connect
#   BUNDLE_ID            com.yxstorehouse.reel
# 输出（GITHUB_OUTPUT）：keychain、team、uuid、identity、method、profile_name、expires
set -euo pipefail

fail() { echo "::error::$*"; exit 1; }
: "${RUNNER_TEMP:?}" "${GITHUB_OUTPUT:?}" "${BUNDLE_ID:?}"
EXPORT_METHOD="${EXPORT_METHOD:-auto}"

KEYCHAIN="$RUNNER_TEMP/reel-signing.keychain-db"
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(openssl rand -hex 24)}"
echo "::add-mask::$KEYCHAIN_PASSWORD"
echo "keychain=$KEYCHAIN" >> "$GITHUB_OUTPUT"

# secrets 里粘贴的 base64 可能带换行 / 空格
printf '%s' "$IOS_CERT_P12_BASE64" | tr -d ' \r\n' | base64 --decode > "$RUNNER_TEMP/cert.p12" 2> /dev/null \
  || fail "IOS_CERT_P12_BASE64 不是合法的 base64"
printf '%s' "$IOS_PROFILE_BASE64" | tr -d ' \r\n' | base64 --decode > "$RUNNER_TEMP/profile.mobileprovision" 2> /dev/null \
  || fail "IOS_PROFILE_BASE64 不是合法的 base64"

# 临时钥匙串：导入证书，允许 codesign 不弹窗使用私钥
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$RUNNER_TEMP/cert.p12" -P "$IOS_CERT_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN" \
  || fail "证书导入失败：检查 IOS_CERT_PASSWORD 是否和 .p12 的密码一致"
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
rm -f "$RUNNER_TEMP/cert.p12"

# 发布证书。证书要能连到 Apple 的根证书才算有效：机器上缺 Apple WWDR 中间证书时补装一下再看
IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN" || true)
if ! printf '%s' "$IDENTITIES" | grep -qE '"(Apple|iPhone) Distribution'; then
  echo "钥匙串里还没有有效的发布证书，补装 Apple WWDR 中间证书后再看一次"
  for ca in AppleWWDRCAG3 AppleWWDRCAG4 AppleWWDRCAG5 AppleWWDRCAG6; do
    if curl -fsSL --retry 2 "https://www.apple.com/certificateauthority/$ca.cer" -o "$RUNNER_TEMP/$ca.cer"; then
      security import "$RUNNER_TEMP/$ca.cer" -k "$KEYCHAIN" -T /usr/bin/codesign > /dev/null 2>&1 || true
    fi
  done
  IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN" || true)
fi
echo "$IDENTITIES"
if printf '%s' "$IDENTITIES" | grep -q '"Apple Distribution'; then IDENTITY="Apple Distribution"
elif printf '%s' "$IDENTITIES" | grep -q '"iPhone Distribution'; then IDENTITY="iPhone Distribution"
else fail "钥匙串里没有可用的发布证书（Apple Distribution）：.p12 里要同时有证书和私钥，证书要是 Apple Distribution 类型"; fi

# 读描述文件：UUID、名字、Team、App ID、类型、有效期
security cms -D -i "$RUNNER_TEMP/profile.mobileprovision" > "$RUNNER_TEMP/profile.plist" 2> /dev/null \
  || fail "IOS_PROFILE_BASE64 不是描述文件（.mobileprovision）"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$RUNNER_TEMP/profile.plist" 2> /dev/null; }
UUID=$(pb UUID || true)
NAME=$(pb Name || true)
PROFILE_TEAM=$(pb TeamIdentifier:0 || true)
APP_ID=$(pb Entitlements:application-identifier || true)
[ -n "$UUID" ] && [ -n "$PROFILE_TEAM" ] || fail "描述文件里读不到 UUID / Team"
TEAM_ID="${IOS_TEAM_ID:-$PROFILE_TEAM}"
[ "$TEAM_ID" = "$PROFILE_TEAM" ] || fail "IOS_TEAM_ID（${TEAM_ID}）和描述文件的 Team（${PROFILE_TEAM}）不一致"
[ "$APP_ID" = "$TEAM_ID.$BUNDLE_ID" ] || fail "描述文件的 App ID 是 ${APP_ID}，应该是 $TEAM_ID.${BUNDLE_ID}（创建描述文件时选错了 App ID）"

if [ "$(pb Entitlements:get-task-allow || true)" = "true" ]; then
  fail "这是开发（Development）描述文件，请在 Apple 开发者网站创建 Ad Hoc 或 App Store 描述文件"
elif pb ProvisionsAllDevices > /dev/null; then
  fail "这是企业版（In-House）描述文件，这里只支持 Ad Hoc 和 App Store"
elif pb ProvisionedDevices > /dev/null; then
  PROFILE_KIND=ad-hoc
else
  PROFILE_KIND=app-store-connect
fi

EXPIRES=$(plutil -extract ExpirationDate raw -o - "$RUNNER_TEMP/profile.plist" 2> /dev/null || true)
EXPIRES_TS=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$EXPIRES" +%s 2> /dev/null || true)
if [ -n "$EXPIRES_TS" ] && [ "$EXPIRES_TS" -lt "$(date +%s)" ]; then
  fail "描述文件已经过期（${EXPIRES}），请在 Apple 开发者网站重新生成，再更新 IOS_PROFILE_BASE64"
fi

# 描述文件里要包含这张证书（证书换过、描述文件没重新生成时会对不上）
CERT_SHA1=$(security find-certificate -a -Z -c "$IDENTITY" "$KEYCHAIN" 2> /dev/null | awk '/SHA-1 hash:/ { print $3; exit }' || true)
MATCH=no
[ -n "$CERT_SHA1" ] || { echo "::warning::读不到证书指纹，跳过「描述文件包含这张证书」的检查"; MATCH=yes; }
i=0
while [ "$MATCH" = "no" ] && /usr/libexec/PlistBuddy -c "Print :DeveloperCertificates:$i" "$RUNNER_TEMP/profile.plist" > /dev/null 2>&1; do
  # PlistBuddy 打印 data 会出错乱，用 plutil 取 base64
  if plutil -extract "DeveloperCertificates.$i" raw -o - "$RUNNER_TEMP/profile.plist" 2> /dev/null \
      | base64 --decode 2> /dev/null | shasum -a 1 | awk '{ print toupper($1) }' | grep -qx "$CERT_SHA1"; then
    MATCH=yes
    break
  fi
  i=$((i + 1))
done
[ "$MATCH" = "yes" ] || fail "描述文件「${NAME}」里没有这张发布证书：在 Apple 开发者网站编辑描述文件、勾选现在的证书，重新下载后更新 IOS_PROFILE_BASE64"

METHOD="$EXPORT_METHOD"
[ "$METHOD" = "auto" ] && METHOD="$PROFILE_KIND"
[ "$METHOD" = "$PROFILE_KIND" ] || fail "选的导出方式是 ${METHOD}，但描述文件「${NAME}」是 $PROFILE_KIND 类型的"
echo "描述文件：${NAME}（${PROFILE_KIND}，到期 ${EXPIRES:-未知}）"

# Xcode 16 起从 UserData 里找描述文件，老位置也放一份
for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
  mkdir -p "$dir"
  cp "$RUNNER_TEMP/profile.mobileprovision" "$dir/$UUID.mobileprovision"
done

# 签名只配给 App 目标（ios/release.xcconfig 会 include 这个文件）
cat > ios/signing.local.xcconfig <<EOF
// GitHub Actions 生成，不入库
CODE_SIGN_STYLE = Manual
DEVELOPMENT_TEAM = $TEAM_ID
CODE_SIGN_IDENTITY = $IDENTITY
PROVISIONING_PROFILE_SPECIFIER = $UUID
EOF

{
  echo "team=$TEAM_ID"
  echo "uuid=$UUID"
  echo "identity=$IDENTITY"
  echo "method=$METHOD"
  echo "profile_name=$NAME"
  echo "expires=$EXPIRES"
} >> "$GITHUB_OUTPUT"
