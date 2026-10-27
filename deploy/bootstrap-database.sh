#!/bin/sh
set -eu

# Observe 只读 SRM 设备短信记录、设备和端口。账号已存在时不改密码，避免和 Nacos 中的凭据不一致。
USERNAME=${OBSERVE_MYSQL_USERNAME:-chat_web_observe_service}
MYSQL_CONTAINER=${OBSERVE_MYSQL_CONTAINER:-chat-web-mysql}
PASSWORD_FILE=${OBSERVE_MYSQL_PASSWORD_FILE:-/opt/chat-web-observe-service/.observe-mysql-password}

docker inspect "$MYSQL_CONTAINER" >/dev/null

mysql_root() {
    docker exec -i "$MYSQL_CONTAINER" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$@"' sh "$@" 2>&1 | grep -v 'Using a password' || true
}

user_count=$(docker exec "$MYSQL_CONTAINER" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM mysql.user WHERE user=\"'"$USERNAME"'\" AND host=\"%\""' 2>/dev/null)
if [ "$user_count" = "0" ]; then
    if [ ! -s "$PASSWORD_FILE" ]; then
        umask 077
        mkdir -p "$(dirname "$PASSWORD_FILE")"
        docker run --rm node:22-alpine node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" > "$PASSWORD_FILE"
        printf '\n' >> "$PASSWORD_FILE"
        chmod 600 "$PASSWORD_FILE"
    fi
    password=$(tr -d '\r\n' < "$PASSWORD_FILE")
    printf "CREATE USER '%s'@'%%' IDENTIFIED BY '%s';\n" "$USERNAME" "$password" | mysql_root
fi
test -s "$PASSWORD_FILE" || { echo "缺少 Observe 数据库密码文件：$PASSWORD_FILE" >&2; exit 1; }

sql=$(cat <<SQL
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_simbank_message\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_simbank\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_simbank_port\` TO '$USERNAME'@'%';
FLUSH PRIVILEGES;
SQL
)
printf '%s\n' "$sql" | mysql_root

echo "Observe 已授权只读 SRM 设备短信记录、设备和端口"
