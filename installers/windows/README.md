# Windows Installer

This directory holds the source files for the DotAIOS `.msi` installer for Windows.

## What the installer does

The MSI is a tiny launcher, not a Node.js distribution. It installs:

- `setup.bat` — first-run script that detects Node.js, calls `npx -y dotaios@latest setup`, and pauses so the user can read output.
- `README.txt` — plain-English notes shown post-install.
- A "Set up DotAIOS" shortcut in the Start Menu.

This design keeps the installer tiny (~50 KB), keeps DotAIOS always at the latest version via `npx`, and avoids bundling/maintaining a Node.js distribution.

If Node.js is missing, `setup.bat` opens https://nodejs.org in the user's default browser and asks them to install it first.

## Build prerequisites (CI handles these automatically)

Built on `windows-latest` GitHub Action runner. Local builds:

```powershell
dotnet tool install --global wix
wix build installers\windows\dotaios.wxs -d ProductVersion=1.10.0 -o dotaios-1.10.0.msi
```

`ProductVersion` MUST be a `major.minor.patch` numeric triplet. Pre-release tags (`-rc1`, etc.) must be stripped before passing in.

## Signing

The current MSI is **unsigned**. Windows SmartScreen will warn users on first run. Two paths to remove the warning:

1. **EV code-signing certificate** (~$300/yr). Removes warning immediately.
2. **Standard code-signing certificate** (~$80/yr). Removes warning after enough installs build reputation.

To sign during CI, add a step that runs `signtool sign /fd SHA256 ...` with the certificate stored as a GitHub secret. Skipped for now.

## What the user sees

1. Downloads `dotaios-X.Y.Z.msi` from the GitHub release or dotaios.com.
2. Double-clicks. SmartScreen may warn (until signed).
3. Standard Windows installer dialog — Install / Cancel.
4. After install, Start Menu shows "Set up DotAIOS".
5. Clicking the shortcut opens a console window, runs `npx dotaios setup`, and stays open so the user reads the output.
6. Re-running the shortcut later upgrades automatically (npx fetches latest).

## Uninstall

Settings → Apps → DotAIOS → Uninstall. Removes the launcher + shortcut. The user's `~/aios/` folder is left alone.
