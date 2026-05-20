const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

const TERMINAL_ERRORS = new Set([
  "expired_token",
  "access_denied",
  "incorrect_device_code",
  "incorrect_client_credentials",
  "unsupported_grant_type"
]);

async function postJson(url, body, { fetchImpl }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "dotaios-sync"
    },
    body: JSON.stringify(body)
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`GitHub returned a non-JSON response (HTTP ${res.status ?? "?"}) from ${url}`);
  }
  return data;
}

export async function requestDeviceCode({ clientId, fetchImpl = fetch }) {
  const payload = await postJson(DEVICE_CODE_URL, { client_id: clientId }, { fetchImpl });
  if (payload.error) {
    throw new Error(`device code request failed: ${payload.error_description || payload.error}`);
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    intervalSec: payload.interval ?? 5,
    expiresInSec: payload.expires_in ?? 900
  };
}

export async function pollForToken({
  clientId,
  deviceCode,
  intervalSec,
  fetchImpl = fetch,
  sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000)),
  now = () => Date.now(),
  timeoutMs = 15 * 60 * 1000 // 15 min
}) {
  let interval = intervalSec;
  const startedAt = now();
  let iterations = 0;
  const MAX_ITERATIONS = 10_000;
  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error("device flow polling exceeded maximum iterations");
    }
    if (now() - startedAt > timeoutMs) {
      throw new Error("device code expired before user approved");
    }
    await sleep(interval);
    const res = await postJson(
      TOKEN_URL,
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      },
      { fetchImpl }
    );
    if (res.access_token) {
      return { accessToken: res.access_token, tokenType: res.token_type, scope: res.scope };
    }
    if (res.error === "authorization_pending") continue;
    if (res.error === "slow_down") {
      interval = Math.max(interval + 5, res.interval || interval + 5);
      continue;
    }
    if (TERMINAL_ERRORS.has(res.error)) {
      throw new Error(`device flow error: ${res.error}`);
    }
    throw new Error(`unknown device flow response: ${JSON.stringify(res)}`);
  }
}

export async function fetchUsername({ accessToken, fetchImpl = fetch }) {
  const res = await fetchImpl(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "dotaios-sync"
    }
  });
  const data = await res.json();
  if (!data.login) throw new Error("could not read GitHub username");
  return data.login;
}
