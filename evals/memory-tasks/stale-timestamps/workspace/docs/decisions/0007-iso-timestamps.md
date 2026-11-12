# 7. Timestamps are ISO 8601 strings

Accepted, 2026-11-02. Replaces the unix-seconds rule of API v2.

Until v3 every timestamp in a response was an integer number of unix seconds. Support could not read them in logs
and the customer app had two bugs from milliseconds mixed with seconds. From v3 every timestamp in a response is an
ISO 8601 string in UTC, made with `iso()` from `src/api/time.ts`; a time that is not known yet is `null`. Both apps
parse the strings since driver app 4.2 and customer app 2.9. `seconds()` stays only for the v2 webhook payloads
until they are retired.
