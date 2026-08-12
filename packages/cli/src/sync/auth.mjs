// Auth for cross-device sync: the user pastes a GitHub Personal Access Token.
// No GitHub App, no device flow, no client_id — nothing DotAIOS has to own,
// register, or verify. The token is created on github.com and validated here.

const USER_URL = "https://api.github.com/user";

// A pre-filled link to GitHub's classic-token page: the `repo` scope is already
// ticked and the token is named, so the user just clicks "Generate token".
export function buildTokenCreateUrl() {
  const params = new URLSearchParams({
    scopes: "repo",
    description: "DotAIOS Sync"
  });
  return `https://github.com/settings/tokens/new?${params.toString()}`;
}

// Confirm a pasted token works and return the GitHub username it belongs to.
// Every failure becomes a plain-language error a non-technical user can act on.
export async function validateToken({ accessToken, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dotaios-sync"
      }
    });
  } catch (err) {
    throw new Error(`could not reach GitHub to check your token: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "that token was rejected by GitHub — check you copied it whole and gave it the 'repo' scope"
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub rejected the token check (HTTP ${res.status ?? "?"})`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("GitHub returned an unreadable response while checking your token");
  }
  if (!data.login) {
    throw new Error("could not read your GitHub username from that token");
  }
  return data.login;
}
