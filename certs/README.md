# Сертификаты

## russian_trusted_ca.pem

Корневой и промежуточный сертификаты Минцифры России.

**Зачем.** Серверы GigaChat (`api.giga.chat`, `ngw.devices.sberbank.ru`)
подписаны этим удостоверяющим центром. В хранилище Node и большинства
операционных систем его нет, поэтому запрос падает с ошибкой
`SELF_SIGNED_CERT_IN_CHAIN`, хотя ключ и адрес верные.

**Как подключается.** Автоматически: `npm start` запускает `api/start.js`,
который перезапускает сервер с переменной `NODE_EXTRA_CA_CERTS`,
указывающей на этот файл. Ничего настраивать не нужно.

Важно: `NODE_EXTRA_CA_CERTS` именно *добавляет* сертификаты к встроенным,
а не заменяет их. Доверие к обычным сайтам не меняется — в отличие от
`GIGACHAT_INSECURE_TLS=1`, который отключает проверку целиком.

**Откуда взят.** Официальная публикация Минцифры:

- https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
- https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt

Те же файлы раздаёт Госуслуги: https://www.gosuslugi.ru/crt

Файл — это два сертификата подряд (сначала корневой, затем промежуточный),
с переводами строки в формате LF. Исходные файлы отдаются с CRLF, и если
их склеить как есть, Node откажется их читать с ошибкой
`PEM routines::bad end line`.

**Проверить содержимое:**

    openssl x509 -in certs/russian_trusted_ca.pem -noout -subject -dates

**Обновление.** Сертификаты выпущены до 2032 года. Если срок истечёт,
скачайте файлы заново по ссылкам выше и приведите к LF:

    curl -sO https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
    curl -sO https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt
    cat russian_trusted_root_ca_pem.crt russian_trusted_sub_ca_pem.crt \
      | tr -d '\r' > certs/russian_trusted_ca.pem
