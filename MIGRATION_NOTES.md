# 4.3.8 -> 4.3.9

- Added automatic proxy-failure recovery for Chromium navigation/transport errors.
- Proxy-specific failures such as `ERR_PROXY_CONNECTION_FAILED`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_SOCKS_CONNECTION_FAILED`, and unsupported/invalid proxy errors now mark the assigned proxy dead, rotate immediately, and retry the same target automatically.
- Added bounded immediate retry backoff: up to five rapid replacement attempts, then a 15-second cooldown before automatic retry continues.
- User Stop still cancels the retry timer and active Chromium session immediately.
