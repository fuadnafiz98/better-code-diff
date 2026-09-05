# Horus for Raycast

Paste a GitHub pull request URL in Raycast to open it in Horus. Typing the URL starts the review in the background so Enter does not wait on a cold fetch.

## Install

Importing the source folder is not enough. Raycast needs a compiled development build:

```sh
cd extensions/horus
npm install
npm run dev
```

Leave that running once. Raycast will show a **Development** section with the Horus commands. After that, you can stop it; the extension stays loaded.

If you already used **Import Extension** and see `Missing executable`, remove that copy in Raycast Settings → Extensions, then run `npm run dev` as above.

## Show Horus when you paste a URL

Raycast does not let an extension add itself to **Use with...**. That list is the user's fallback commands, and the manifest has no flag for it.

The shortest enable path: paste any GitHub PR URL, click the gear on the **Use with...** section, and turn on **Open in Horus**. After that, every pasted PR URL offers it.

## Commands

| Command | What it does |
| --- | --- |
| **Open in Horus** | Fallback / hotkey command. Uses the pasted URL, or the clipboard. |
| **Open Pull Request** | Search bar if you want to edit the URL first. |
| **Open Clipboard Pull Request** | Clipboard only. Bind this to a hotkey. |

Horus watches the clipboard itself while its window is on screen, so there is no
background Raycast command: a copied PR URL is warmed by the app that is already
running, and a hidden Horus stays idle.

Warming only reaches a Horus that is already running — typing a URL in **Open
Pull Request** never launches the app. Opening one does: a running Horus is
reached through `horus://`, a cold one through `open -a Horus`.
